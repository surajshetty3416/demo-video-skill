#!/usr/bin/env python3
"""Local fine-tuning editor for the demo-video pipeline.

Usage:  python3 editor/server.py [--detach] [--port N] <workdir>

<workdir> is either a single segment dir (frames/ + meta.json) or a dir whose
immediate children are segment dirs (it may start empty and fill up via
imports). Serves the editor UI on a free local port (--port pins it, so the
recorder extension can keep a stable server URL), lets the browser save
meta.edited.json + knobs.json per segment (the original meta.json is never
touched), and runs the skill's compositor.py per segment (META_FILE/KNOBS_JSON
env) followed by an ffmpeg concat into edited-full.mp4.

The /api/import endpoints receive a real-time tab recording from the browser
extension (extension/): a JSON manifest (page size, t0, input events), then the
raw webm; ingest.py converts it into a normal segment that appears in the rail.
"""
import base64, json, math, os, re, shutil, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EDITOR_DIR = os.path.dirname(os.path.abspath(__file__))
COMPOSITOR = os.path.join(os.path.dirname(EDITOR_DIR), "compositor.py")
RECPILL = os.path.join(EDITOR_DIR, "recpill.py")
DIST_DIR = os.path.join(EDITOR_DIR, "ui", "dist")
CTYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
          ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff",
          ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
          ".map": "application/json", ".txt": "text/plain"}

INT_KNOBS = ["PANEL_SCALE", "PANEL_BASE_W", "MARGIN", "RAD", "END_EXTRA", "PULSE_N",
             "KEY_H", "KEY_INSET", "KEY_N", "CAP_H", "CRF", "CURSOR_CSS_H",
             "SHADOW_ALPHA", "SHADOW_BLUR"]
FLOAT_KNOBS = ["ZOOM_EMA", "PAN_EMA"]


def is_segment(path):
    return os.path.isfile(os.path.join(path, "meta.json")) and os.path.isdir(os.path.join(path, "frames"))


def discover_segments(workdir):
    segs = {}
    if is_segment(workdir):
        segs[os.path.basename(os.path.abspath(workdir)) or "segment"] = os.path.abspath(workdir)
    for name in sorted(os.listdir(workdir)):
        p = os.path.join(workdir, name)
        if os.path.isdir(p) and is_segment(p):
            segs[name] = os.path.abspath(p)
    return segs


def sanitize_knobs(k):
    out = {}
    for key in INT_KNOBS:
        if key in k: out[key] = int(round(float(k[key])))
    for key in FLOAT_KNOBS:
        if key in k: out[key] = float(k[key])
    if "PRESET" in k: out["PRESET"] = str(k["PRESET"])
    if "GRAD" in k:
        out["GRAD"] = [[float(t), [int(c[0]), int(c[1]), int(c[2])]] for t, c in k["GRAD"]]
    return out


def slugify(s):
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s[:60] or "recording"


sys.path.insert(0, os.path.dirname(EDITOR_DIR))
from resolve import needs_resolve, resolve_meta  # shared with compositor.py
from ingest import ingest_dir                    # recording -> segment converter


class RenderJob:
    def __init__(self):
        self.lock = threading.Lock()
        self.lines, self.status, self.error = [], "idle", None
        self.segments, self.outputs = [], []
        self.thread = None

    def log(self, line):
        with self.lock:
            self.lines.append(line)

    def snapshot(self, since):
        with self.lock:
            return {"status": self.status, "error": self.error,
                    "cursor": len(self.lines), "lines": self.lines[since:],
                    "segments": [dict(s) for s in self.segments],
                    "outputs": [dict(o) for o in self.outputs]}

    def start(self, segs, concat, workdir):
        with self.lock:
            if self.status == "running": return False
            self.lines, self.status, self.error = [], "running", None
            self.segments = [{"name": n, "frames": 0, "total": 0, "state": "pending"}
                             for n, _ in segs]
            if concat and len(segs) >= 1:
                self.segments.append({"name": "combine", "frames": 0, "total": 0, "state": "pending"})
            self.outputs = []
        self.thread = threading.Thread(target=self.run, args=(segs, concat, workdir), daemon=True)
        self.thread.start()
        return True

    def seg_slot(self, name):
        return next(s for s in self.segments if s["name"] == name)

    def add_output(self, label, url, fpath):
        with self.lock:
            self.outputs.append({"label": label, "url": url, "bytes": os.path.getsize(fpath)})

    def run(self, segs, concat, workdir):
        try:
            for name, path in segs:
                self.render_segment(name, path)
            if concat and len(segs) >= 1:
                self.concat(segs, workdir)
            with self.lock: self.status = "done"
        except Exception as e:
            with self.lock:
                self.status, self.error = "error", str(e)
            self.log(f"ERROR: {e}")

    def render_segment(self, name, path):
        slot = self.seg_slot(name)
        env = dict(os.environ)
        edited = os.path.join(path, "meta.edited.json")
        src = edited if os.path.exists(edited) else os.path.join(path, "meta.json")
        m = json.load(open(src))
        if os.path.exists(edited) or needs_resolve(m):
            resolved = resolve_meta(m)
            rpath = os.path.join(path, "meta.render.json")
            json.dump(resolved, open(rpath, "w"))
            env["META_FILE"] = rpath
            total = sum(f.get("repeat", 1) for f in resolved["frames"])
        else:
            total = sum(f.get("repeat", 1) for f in m["frames"])
        with self.lock:
            slot["state"], slot["total"] = "running", total
        knobs = os.path.join(path, "knobs.json")
        if os.path.exists(knobs):
            env["KNOBS_JSON"] = knobs
        proc = subprocess.Popen([sys.executable, "-u", COMPOSITOR, path], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in proc.stdout:
            line = line.rstrip()
            m = re.match(r"frame (\d+) / (\d+)", line)
            if m:
                with self.lock:
                    slot["frames"], slot["total"] = int(m.group(1)), int(m.group(2))
            self.log(f"[{name}] {line}")
        if proc.wait() != 0:
            raise RuntimeError(f"compositor failed for {name}")
        with self.lock:
            slot["state"], slot["frames"] = "done", slot["total"]
        self.add_output(name, f"/output/{name}", os.path.join(path, "demo.mp4"))

    def concat(self, segs, workdir):
        slot = self.seg_slot("combine")
        with self.lock: slot["state"] = "running"
        lst = os.path.join(workdir, "edited-concat.txt")
        with open(lst, "w") as f:
            for name, path in segs:
                f.write(f"file '{os.path.join(path, 'demo.mp4')}'\n")
        out = os.path.join(workdir, "edited-full.mp4")
        proc = subprocess.Popen(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                                 "-c", "copy", out],
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in proc.stdout:
            self.log(f"[combine] {line.rstrip()}")
        if proc.wait() != 0:
            raise RuntimeError("ffmpeg concat failed")
        with self.lock: slot["state"] = "done"
        self.add_output("Full video", "/output/__full__", out)


class Handler(BaseHTTPRequestHandler):
    workdir = None
    job = None
    port = 0
    imports = {}
    imports_lock = threading.Lock()
    protocol_version = "HTTP/1.1"

    def log_message(self, *a): pass

    def send(self, code, body, ctype="application/json", cache=False):
        if isinstance(body, (dict, list)): body = json.dumps(body).encode()
        elif isinstance(body, str): body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if cache: self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(body)

    def segpath(self, name):
        return discover_segments(self.workdir).get(name)

    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path.startswith("/output/"): return self.serve_video(path.split("/")[2])
            if not path.startswith("/api/"): return self.static(path)
            if path == "/api/segments": return self.list_segments()
            if path == "/api/render/status": return self.render_status()
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "import"] and parts[3] == "status":
                return self.import_status(parts[2])
            if len(parts) >= 4 and parts[:2] == ["api", "segment"]:
                seg = self.segpath(parts[2])
                if not seg: return self.send(404, {"error": "unknown segment"})
                if parts[3] == "meta": return self.seg_meta(seg, parts[2])
                if parts[3] == "frame" and len(parts) == 5: return self.frame(seg, int(parts[4]))
            self.send(404, {"error": "not found"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self.send(500, {"error": str(e)})

    def do_POST(self):
        try:
            path = self.path.split("?")[0]
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "import"] and parts[3] == "video":
                return self.import_video(parts[2])   # raw webm body, not JSON
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if len(parts) == 4 and parts[:2] == ["api", "segment"] and parts[3] == "save":
                seg = self.segpath(parts[2])
                if not seg: return self.send(404, {"error": "unknown segment"})
                return self.save(seg, body)
            if len(parts) == 4 and parts[:2] == ["api", "segment"] and parts[3] == "delete":
                return self.delete_segment(parts[2])
            if path == "/api/render": return self.render(body)
            if path == "/api/import": return self.import_start(body)
            if len(parts) == 4 and parts[:2] == ["api", "import"]:
                imp = self.imports.get(parts[2])
                if not imp: return self.send(404, {"error": "unknown import"})
                if parts[3] == "frames": return self.import_frames(imp, body)
                if parts[3] == "events": return self.import_events(imp, body)
                if parts[3] == "finish": return self.import_finish(imp, body)
                if parts[3] == "stop": return self.import_stop(imp)
            self.send(404, {"error": "not found"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self.send(500, {"error": str(e)})

    def static(self, path):
        """Serve the prebuilt Vue app from ui/dist (no node needed at runtime)."""
        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(DIST_DIR, rel))
        if not full.startswith(DIST_DIR + os.sep) or not os.path.isfile(full):
            full = os.path.join(DIST_DIR, "index.html")
        if not os.path.isfile(full):
            return self.send(500, {"error": "ui/dist missing; run `yarn build` in editor/ui"})
        ctype = CTYPES.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            self.send(200, f.read(), ctype, cache=full.endswith((".js", ".css", ".woff2")))

    def list_segments(self):
        out = []
        for name, path in discover_segments(self.workdir).items():
            edited = os.path.join(path, "meta.edited.json")
            has_edits = os.path.exists(edited)
            # playFrames must match the editor transport: resolved body, no END_EXTRA
            m = json.load(open(edited if has_edits else os.path.join(path, "meta.json")))
            label = m.get("label")  # resolve_meta drops non-frame keys, read it first
            if has_edits or needs_resolve(m):
                m = resolve_meta(m)
            play = sum(f.get("repeat", 1) for f in m["frames"])
            out.append({"name": name, "entries": len(m["frames"]), "playFrames": play,
                        "fps": m.get("fps", 60), "hasEdits": has_edits, "label": label})
        self.send(200, out)

    def seg_meta(self, seg, name):
        meta = json.load(open(os.path.join(seg, "meta.json")))
        edited = knobs = None
        ep, kp = os.path.join(seg, "meta.edited.json"), os.path.join(seg, "knobs.json")
        if os.path.exists(ep): edited = json.load(open(ep))
        if os.path.exists(kp): knobs = json.load(open(kp))
        self.send(200, {"name": name, "meta": meta, "edited": edited, "knobs": knobs})

    def frame(self, seg, k):
        p = os.path.join(seg, "frames", f"f{k:05d}.jpg")
        if not os.path.exists(p): p = os.path.join(seg, "frames", f"f{k:05d}.png")
        if not os.path.exists(p): return self.send(404, {"error": "no frame"})
        ctype = "image/jpeg" if p.endswith(".jpg") else "image/png"
        with open(p, "rb") as f:
            self.send(200, f.read(), ctype, cache=True)

    def delete_segment(self, name):
        seg = self.segpath(name)
        if not seg: return self.send(404, {"error": "unknown segment"})
        if os.path.abspath(seg) == os.path.abspath(self.workdir):
            return self.send(400, {"error": "refusing to delete the workdir itself"})
        shutil.rmtree(seg)
        self.send(200, {"ok": True})

    def save(self, seg, body):
        meta, knobs = body.get("meta"), body.get("knobs")
        if meta:
            with open(os.path.join(seg, "meta.edited.json"), "w") as f:
                json.dump(meta, f, indent=1)
        if knobs:
            with open(os.path.join(seg, "knobs.json"), "w") as f:
                json.dump(sanitize_knobs(knobs), f, indent=1)
        self.send(200, {"ok": True})

    def import_start(self, body):
        """Stage a recording import: claim a segment dir, keep the manifest.
        mode "webm" (default): the video follows on /api/import/<id>/video.
        mode "frames": screencast JPEGs + events stream in DURING recording
        via /frames and /events, then /finish converts. The id doubles as the
        segment (dir) name."""
        page, mode = body.get("page") or {}, body.get("mode") or "webm"
        if not page.get("w") or not page.get("h"):
            return self.send(400, {"error": "need page{w,h}"})
        if mode == "webm" and "t0" not in body:
            return self.send(400, {"error": "webm mode needs t0"})
        base = slugify(body.get("name") or page.get("title"))
        with self.imports_lock:
            name, k = base, 2
            while os.path.exists(os.path.join(self.workdir, name)):
                name, k = f"{base}-{k}", k + 1
            seg = os.path.join(self.workdir, name)
            os.makedirs(seg)
            self.imports[name] = {"status": "recording" if mode == "frames" else "awaiting-video",
                                  "error": None, "dir": seg, "mode": mode,
                                  "manifest": {"mode": mode, "name": body.get("name") or page.get("title"),
                                               "page": page, "t0": body.get("t0")},
                                  "times": [], "events": list(body.get("events") or [])}
        if mode == "frames":
            os.makedirs(os.path.join(seg, "raw"))
            # a topmost OS window is the only recording overlay the capture
            # can't see; skipped silently when tkinter is missing
            if not os.environ.get("NO_REC_PILL"):
                self.imports[name]["pill"] = subprocess.Popen(
                    [sys.executable, RECPILL, name, str(self.port)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            with open(os.path.join(seg, "recording.json"), "w") as f:
                json.dump({**self.imports[name]["manifest"],
                           "events": self.imports[name]["events"]}, f)
        self.send(200, {"id": name})

    def import_frames(self, imp, body):
        with self.imports_lock:
            seq = len(imp["times"])
            for fr in body.get("frames") or []:
                with open(os.path.join(imp["dir"], "raw", f"r{seq:06d}.jpg"), "wb") as f:
                    f.write(base64.b64decode(fr["d"]))
                imp["times"].append(int(fr["t"]))
                seq += 1
        self.send(200, {"ok": True, "count": seq, "stop": imp.get("stopRequested", False)})

    def import_stop(self, imp):
        imp["stopRequested"] = True
        self.send(200, {"ok": True})

    def import_events(self, imp, body):
        with self.imports_lock:
            imp["events"].extend(body.get("events") or [])
        self.send(200, {"ok": True})

    def import_finish(self, imp, body):
        with self.imports_lock:
            imp["events"].extend(body.get("events") or [])
            order = sorted(range(len(imp["times"])), key=lambda i: imp["times"][i])
            if order != list(range(len(order))):   # frames may arrive out of order
                for pos, i in enumerate(order):
                    os.rename(os.path.join(imp["dir"], "raw", f"r{i:06d}.jpg"),
                              os.path.join(imp["dir"], "raw", f"t{pos:06d}.jpg"))
                for pos in range(len(order)):
                    os.rename(os.path.join(imp["dir"], "raw", f"t{pos:06d}.jpg"),
                              os.path.join(imp["dir"], "raw", f"r{pos:06d}.jpg"))
                imp["times"].sort()
        with open(os.path.join(imp["dir"], "times.json"), "w") as f:
            json.dump(imp["times"], f)
        with open(os.path.join(imp["dir"], "recording.json"), "w") as f:
            json.dump({**imp["manifest"], "t0": imp["times"][0] if imp["times"] else None,
                       "events": imp["events"]}, f)
        imp["status"] = "converting"
        threading.Thread(target=self.convert, args=(imp,), daemon=True).start()
        self.send(200, {"ok": True})

    def import_video(self, name):
        imp = self.imports.get(name)
        if not imp: return self.send(404, {"error": "unknown import"})
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0: return self.send(400, {"error": "empty body"})
        with open(os.path.join(imp["dir"], "rec.webm"), "wb") as f:
            left = length
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk: break
                f.write(chunk); left -= len(chunk)
        imp["status"] = "converting"
        threading.Thread(target=self.convert, args=(imp,), daemon=True).start()
        self.send(200, {"ok": True})

    def convert(self, imp):
        if imp.get("pill"):
            imp["pill"].terminate()
        try:
            imp["summary"] = ingest_dir(imp["dir"])
            imp["status"] = "done"
        except Exception as e:
            imp["status"], imp["error"] = "error", str(e)

    def import_status(self, name):
        imp = self.imports.get(name)
        if not imp: return self.send(404, {"error": "unknown import"})
        self.send(200, {"status": imp["status"], "error": imp["error"], "segment": name,
                        "stop": imp.get("stopRequested", False), "summary": imp.get("summary")})

    def render(self, body):
        segs = discover_segments(self.workdir)
        wanted = body.get("segments") or list(segs)
        missing = [n for n in wanted if n not in segs]
        if missing: return self.send(400, {"error": f"unknown segments: {missing}"})
        started = self.job.start([(n, segs[n]) for n in wanted], bool(body.get("concat")), self.workdir)
        self.send(200 if started else 409, {"started": started})

    def render_status(self):
        since = 0
        if "?" in self.path:
            for kv in self.path.split("?", 1)[1].split("&"):
                if kv.startswith("since="): since = int(kv[6:] or 0)
        self.send(200, self.job.snapshot(since))

    def serve_video(self, name):
        if name == "__full__":
            fpath = os.path.join(self.workdir, "edited-full.mp4")
        else:
            seg = self.segpath(name)
            fpath = seg and os.path.join(seg, "demo.mp4")
        if not fpath or not os.path.exists(fpath):
            return self.send(404, {"error": "no rendered video"})
        size = os.path.getsize(fpath)
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            if a: start = int(a)
            if b: end = min(int(b), size - 1)
        length = end - start + 1
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        if rng: self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        with open(fpath, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk: break
                self.wfile.write(chunk)
                left -= len(chunk)


def spawn_detached(workdir, port):
    log = os.path.join(workdir, "editor.log")
    offset = os.path.getsize(log) if os.path.exists(log) else 0
    cmd = [sys.executable, os.path.abspath(__file__), "--port", str(port), workdir]
    child = subprocess.Popen(cmd, stdout=open(log, "ab"), stderr=subprocess.STDOUT,
                             start_new_session=True)
    for _ in range(50):
        time.sleep(0.1)
        with open(log, "rb") as f:
            f.seek(offset)
            fresh = f.read().decode(errors="replace")
        urls = [l for l in fresh.splitlines() if "demo-video editor:" in l]
        if urls:
            print(urls[-1])
            print(f"log: {log}  pid: {child.pid}")
            return
    sys.exit(f"editor did not start; see {log}")


def main():
    args = sys.argv[1:]
    detach, port = "--detach" in args, 0
    args = [a for a in args if a != "--detach"]
    if "--port" in args:
        i = args.index("--port")
        port = int(args[i + 1]); del args[i:i + 2]
    if len(args) != 1:
        sys.exit("usage: python3 server.py [--detach] [--port N] <workdir>")
    workdir = os.path.abspath(args[0])
    if not os.path.isdir(workdir):
        sys.exit(f"not a directory: {workdir}")
    if not discover_segments(workdir):
        print(f"no segments in {workdir} yet — record one from the browser "
              f"extension or add frames/ + meta.json dirs", flush=True)
    if detach:
        return spawn_detached(workdir, port)
    Handler.workdir = workdir
    Handler.job = RenderJob()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    Handler.port = httpd.server_address[1]
    print(f"demo-video editor: http://127.0.0.1:{httpd.server_address[1]}/  (workdir: {workdir})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
