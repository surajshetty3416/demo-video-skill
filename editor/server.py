#!/usr/bin/env python3
"""Local fine-tuning editor for the demo-video pipeline.

Usage:  python3 editor/server.py <workdir>

<workdir> is either a single segment dir (frames/ + meta.json) or a dir whose
immediate children are segment dirs. Serves the editor UI on a free local port,
lets the browser save meta.edited.json + knobs.json per segment (the original
meta.json is never touched), and runs the skill's compositor.py per segment
(META_FILE/KNOBS_JSON env) followed by an ffmpeg concat into edited-full.mp4.
"""
import json, os, re, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

EDITOR_DIR = os.path.dirname(os.path.abspath(__file__))
COMPOSITOR = os.path.join(os.path.dirname(EDITOR_DIR), "compositor.py")
DIST_DIR = os.path.join(EDITOR_DIR, "ui", "dist")
CTYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
          ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff",
          ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
          ".map": "application/json", ".txt": "text/plain"}

INT_KNOBS = ["PANEL_SCALE", "PANEL_BASE_W", "MARGIN", "RAD", "END_EXTRA", "PULSE_N",
             "KEY_H", "KEY_INSET", "KEY_N", "CRF", "CURSOR_CSS_H", "SHADOW_ALPHA", "SHADOW_BLUR"]
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


def resolve_meta(m):
    """Bake trim + speed into a compositor-ready meta: entry k must keep mapping to
    frames/f{k:05d}.jpg, so drops become repeat:0 and only the tail is truncated."""
    frames = [dict(f) for f in m["frames"]]
    n = len(frames)
    trim = m.get("trim") or {}
    tin, tout = int(trim.get("in", 0)), int(trim.get("out", n - 1))
    reps = [int(f.get("repeat", 1)) for f in frames]
    for i in range(n):
        if i < tin or i > min(tout, n - 1): reps[i] = 0
    pace = float(m.get("pace") or 1)
    mults = [pace if pace > 0 else 1.0] * n
    for sp in m.get("speed") or []:
        mult = float(sp["mult"])
        if mult <= 0: continue
        for i in range(max(0, int(sp["from"])), min(n, int(sp["to"]))):
            mults[i] *= mult
    acc = 0.0
    for i in range(n):
        if reps[i] == 0: continue
        if mults[i] == 1:
            acc = 0.0; continue
        acc += reps[i] / mults[i]
        k = int(acc); acc -= k
        reps[i] = k
    last = max((i for i in range(n) if reps[i] > 0), default=0)
    frames, reps = frames[:last + 1], reps[:last + 1]
    kept = [i for i in range(len(frames)) if reps[i] > 0]

    def snap(i):
        for k in kept:
            if k >= i: return k
        return kept[-1] if kept else None

    for i, f in enumerate(frames):
        f["repeat"] = reps[i]
    out = {"dsf": m["dsf"], "fps": m.get("fps", 60), "clip": m["clip"], "frames": frames}
    for key in ("clicks", "keys"):
        evts = []
        for e in m.get(key) or []:
            j = snap(int(e["i"]))
            if j is None: continue
            e2 = dict(e); e2["i"] = j
            evts.append(e2)
        out[key] = evts
    return out


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
        if os.path.exists(edited):
            resolved = resolve_meta(json.load(open(edited)))
            rpath = os.path.join(path, "meta.render.json")
            json.dump(resolved, open(rpath, "w"))
            env["META_FILE"] = rpath
            total = sum(f.get("repeat", 1) for f in resolved["frames"])
        else:
            meta = json.load(open(os.path.join(path, "meta.json")))
            total = sum(f.get("repeat", 1) for f in meta["frames"])
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
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or b"{}"))
            path = self.path.split("?")[0]
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "segment"] and parts[3] == "save":
                seg = self.segpath(parts[2])
                if not seg: return self.send(404, {"error": "unknown segment"})
                return self.save(seg, body)
            if path == "/api/render": return self.render(body)
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
            if has_edits:
                m = resolve_meta(m)
            play = sum(f.get("repeat", 1) for f in m["frames"])
            out.append({"name": name, "entries": len(m["frames"]), "playFrames": play,
                        "fps": m.get("fps", 60), "hasEdits": has_edits})
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

    def save(self, seg, body):
        meta, knobs = body.get("meta"), body.get("knobs")
        if meta:
            with open(os.path.join(seg, "meta.edited.json"), "w") as f:
                json.dump(meta, f, indent=1)
        if knobs:
            with open(os.path.join(seg, "knobs.json"), "w") as f:
                json.dump(sanitize_knobs(knobs), f, indent=1)
        self.send(200, {"ok": True})

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
            self.wfile.write(f.read(length))


def spawn_detached(workdir):
    log = os.path.join(workdir, "editor.log")
    offset = os.path.getsize(log) if os.path.exists(log) else 0
    child = subprocess.Popen([sys.executable, os.path.abspath(__file__), workdir],
                             stdout=open(log, "ab"), stderr=subprocess.STDOUT,
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
    args = [a for a in sys.argv[1:] if a != "--detach"]
    if not args:
        sys.exit("usage: python3 server.py [--detach] <workdir>")
    workdir = os.path.abspath(args[0])
    if not discover_segments(workdir):
        sys.exit(f"no segments found in {workdir} (need frames/ + meta.json)")
    if len(args) != len(sys.argv) - 1:
        return spawn_detached(workdir)
    Handler.workdir = workdir
    Handler.job = RenderJob()
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(f"demo-video editor: http://127.0.0.1:{httpd.server_address[1]}/  (workdir: {workdir})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
