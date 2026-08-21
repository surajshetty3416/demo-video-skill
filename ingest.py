#!/usr/bin/env python3
"""Ingest a real-time browser recording into the capture bundle format.

The Chrome extension (extension/) records the active tab while an injected
logger stamps pointer moves, clicks and shortcut presses with wall-clock ms.
Two capture modes land here as a segment dir and come out as exactly what
capture_template.py produces — frames/f*.jpg + meta.json with an auto-framed
camera derived from the click log (one steady shot per click cluster, wide
otherwise) that the editor reshapes like any scripted capture:

- "frames" (default, drawn cursor): CDP screencast JPEGs streamed during
  recording (raw/r*.jpg + times.json). Screencast pixels carry NO cursor, so
  meta gets mx/my and the compositor draws its crisp vector cursor — cursor
  visibility stays editable. Timestamped frames resample onto the 60fps grid;
  idle gaps become `repeat` entries for free.
- "webm" (recorded cursor): a tabCapture MediaRecorder file (rec.webm).
  Chrome bakes the OS cursor into those pixels, so meta entries carry no
  mx/my (an overlay would double it). 60fps demux + byte-identical runs
  collapse into repeats.

In both modes identical frames hardlink to one file, click/key frames force
an entry boundary so pulses/keycaps land exactly, and the event log powers
pulses, keycaps and the collapse heuristic.

Usage:  python3 ingest.py <segment-dir>     (dir holding recording.json + raw
                                             frames or rec.webm)
"""
import hashlib, json, os, subprocess, sys
from bisect import bisect_left, bisect_right

from PIL import Image

FPS = 60
JPEG_Q = "2"              # ffmpeg -q:v, ~quality 92 — matches Playwright captures
STILL_PX = 1.0            # cursor drift below this collapses into a repeat
GAP_MS = 120.0            # sample gaps beyond this mean a parked cursor: hold,
                          # don't creep — then ease in over the last GAP_MS

CAM_LEAD = 45             # frames the camera starts moving before a shot's first click
CAM_TAIL = 70             # frames it lingers after the shot's last click
CAM_BRIDGE = 150          # a wide gap shorter than this carries straight to the next shot
CLUSTER_GAP = 5 * FPS     # clicks this far apart (frames) still share a shot
CLUSTER_R = 380           # ...if within this many CSS px of the shot centre
CAM_MARGIN = 150          # context kept around a shot's click spread (CSS px)
ZOOM_HI = 1.65            # hold-zoom cap (SKILL: ~1.5-1.9 reads best)
ZOOM_MIN = 1.2            # a shot that fits looser than this stays wide


def probe_size(video):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", video], text=True)
    w, h = out.strip().splitlines()[0].split(",")[:2]
    return int(w), int(h)


def clear_frames(frames_dir):
    os.makedirs(frames_dir, exist_ok=True)
    for f in os.listdir(frames_dir):
        if f.startswith("f") and f.endswith((".jpg", ".png")):
            os.remove(os.path.join(frames_dir, f))


def demux(video, frames_dir, sw, sh, log):
    clear_frames(frames_dir)
    subprocess.check_call(
        ["ffmpeg", "-y", "-i", video,
         "-vf", f"fps={FPS},scale={sw}:{sh}:flags=lanczos",
         "-start_number", "0", "-q:v", JPEG_Q,
         os.path.join(frames_dir, "f%05d.jpg")], stdout=log, stderr=log)
    n = sum(1 for f in os.listdir(frames_dir) if f.endswith(".jpg"))
    if not n:
        raise RuntimeError("demux produced no frames — is rec.webm a video?")
    return n


def mouse_track(events, t0, n, w, h):
    """Per-output-frame cursor position, linearly interpolated between samples
    (moves and clicks both count as samples)."""
    pts = sorted((e["t"], e["x"], e["y"]) for e in events if e.get("k") in ("m", "c"))
    if not pts:
        return [(round(w / 2, 1), round(h / 2, 1))] * n
    times = [p[0] for p in pts]
    out = []
    for k in range(n):
        t = t0 + k * 1000.0 / FPS
        i = bisect_left(times, t)
        if i == 0:
            p = pts[0][1:]
        elif i == len(pts):
            p = pts[-1][1:]
        else:
            (ta, xa, ya), (tb, xb, yb) = pts[i - 1], pts[i]
            ta = max(ta, tb - GAP_MS)
            u = min(1.0, max(0.0, (t - ta) / (tb - ta))) if tb > ta else 0.0
            p = (xa + (xb - xa) * u, ya + (yb - ya) * u)
        out.append((round(p[0], 1), round(p[1], 1)))
    return out


def frame_of(t, t0, n):
    return max(0, min(n - 1, int((t - t0) * FPS / 1000.0)))


def pause_map(events):
    """Pause markers (k:"p"/"r") from the extension excise their interval from
    the recording's timeline: returns the intervals and a monotonic remapper."""
    marks = sorted((e["t"], e["k"]) for e in events if e.get("k") in ("p", "r"))
    ivs, start = [], None
    for t, k in marks:
        if k == "p" and start is None:
            start = t
        elif k == "r" and start is not None:
            ivs.append((start, t)); start = None
    if start is not None:
        ivs.append((start, float("inf")))    # paused straight into stop

    def eff(t):
        cut = 0.0
        for a, b in ivs:
            if t > b:
                cut += b - a
            elif t > a:
                cut += t - a
        return t - cut
    return ivs, eff


def cluster_clicks(clicks):
    groups = []
    for f, x, y in clicks:
        g = groups[-1] if groups else None
        if (g and f - g["last"] <= CLUSTER_GAP
                and abs(x - g["cx"]) <= CLUSTER_R and abs(y - g["cy"]) <= CLUSTER_R):
            g["pts"].append((x, y)); g["last"] = f
            g["cx"] = sum(p[0] for p in g["pts"]) / len(g["pts"])
            g["cy"] = sum(p[1] for p in g["pts"]) / len(g["pts"])
        else:
            groups.append({"pts": [(x, y)], "first": f, "last": f, "cx": x, "cy": y})
    return groups


def shot_zoom(g, w, h):
    xs = [p[0] for p in g["pts"]]
    ys = [p[1] for p in g["pts"]]
    z = min(w / (max(xs) - min(xs) + 2 * CAM_MARGIN),
            h / (max(ys) - min(ys) + 2 * CAM_MARGIN))
    return min(ZOOM_HI, z) if z >= ZOOM_MIN else 1.0


def camera_track(clicks, n, w, h):
    """Auto-framing per the skill's cinematography rules: one steady shot per
    click cluster — the camera targets the cluster centre a beat before its
    first click, holds through the action, releases after — wide everywhere
    else. Short wide gaps carry straight to the next shot (no pumping)."""
    cam = [(w / 2, h / 2, 1.0)] * n
    spans = []
    for g in cluster_clicks(clicks):
        z = shot_zoom(g, w, h)
        if z <= 1.0:
            continue
        spans.append([max(0, g["first"] - CAM_LEAD), min(n, g["last"] + CAM_TAIL),
                      (g["cx"], g["cy"], z)])
    for i, (a, b, t) in enumerate(spans):
        if i and 0 < a - spans[i - 1][1] < CAM_BRIDGE:
            a = spans[i - 1][1]
        for k in range(a, b):
            cam[k] = t
    return cam


def event_tracks(rec, t0, n, cssw, cssh):
    events = rec.get("events") or []
    mice = mouse_track(events, t0, n, cssw, cssh)
    clicks = [(frame_of(e["t"], t0, n), e["x"], e["y"]) for e in events if e.get("k") == "c"]
    keys = [(frame_of(e["t"], t0, n), e["text"]) for e in events
            if e.get("k") == "k" and e.get("text")]
    cam = camera_track(clicks, n, cssw, cssh)
    breaks = {f for f, _, _ in clicks} | {f for f, _ in keys}
    breaks |= {k for k in range(1, n) if cam[k] != cam[k - 1]}
    return mice, clicks, keys, cam, breaks


def file_hashes(frames_dir, n):
    hs = []
    for k in range(n):
        with open(os.path.join(frames_dir, f"f{k:05d}.jpg"), "rb") as f:
            hs.append(hashlib.md5(f.read()).hexdigest())
    return hs


def build_entries(pix, mice, breaks):
    """Group output frames into meta entries: identical pixels + parked cursor
    extend a repeat; frames in `breaks` (click/key/camera change) start their
    own. `pix` is any per-frame pixel identity (content hash or raw index)."""
    entries, i, n = [], 0, len(pix)
    while i < n:
        j = i + 1
        while (j < n and j not in breaks and pix[j] == pix[i]
               and abs(mice[j][0] - mice[i][0]) <= STILL_PX
               and abs(mice[j][1] - mice[i][1]) <= STILL_PX):
            j += 1
        entries.append({"src": i, "repeat": j - i})
        i = j
    return entries


def materialize(entries, frames_dir, hashes, n):
    """Rewrite demuxed frames so entry j maps to f{j:05d}.jpg. Entry index
    never exceeds its source index, so renaming in ascending order can't
    clobber an unconsumed source; equal content becomes hardlinks."""
    first = {}
    path = lambda k: os.path.join(frames_dir, f"f{k:05d}.jpg")
    for j, e in enumerate(entries):
        h, dst, srcp = hashes[e["src"]], path(j), path(e["src"])
        if h in first:
            if os.path.exists(dst):
                os.remove(dst)
            os.link(first[h], dst)
        else:
            if dst != srcp:
                os.replace(srcp, dst)
            first[h] = dst
    for k in range(len(entries), n):
        if os.path.exists(path(k)):
            os.remove(path(k))


def materialize_raw(entries, grid, seg, sw, sh):
    """Write frames/ for a streamed-frames recording: entry j hardlinks the
    raw screencast JPEG it shows (resized once if its dims drifted)."""
    fdir = os.path.join(seg, "frames")
    clear_frames(fdir)
    done = {}
    for j, e in enumerate(entries):
        r = grid[e["src"]]
        dst = os.path.join(fdir, f"f{j:05d}.jpg")
        if r in done:
            os.link(done[r], dst)
            continue
        src = os.path.join(seg, "raw", f"r{r:06d}.jpg")
        with Image.open(src) as img:
            if img.size != (sw, sh):
                img.convert("RGB").resize((sw, sh), Image.LANCZOS).save(dst, quality=92)
            else:
                os.link(src, dst)
        done[r] = dst


def emit_meta(seg, rec, entries, cam, mice, clicks, keys, cssw, cssh, dsf, n, cursor):
    f2e = [0] * n
    for j, e in enumerate(entries):
        for k in range(e["src"], e["src"] + e["repeat"]):
            f2e[k] = j
    frames = []
    for e in entries:
        cx, cy, z = cam[e["src"]]
        fr = {"cx": round(cx, 1), "cy": round(cy, 1), "z": round(z, 3)}
        if cursor:
            fr["mx"], fr["my"] = mice[e["src"]]
        if e["repeat"] > 1:
            fr["repeat"] = e["repeat"]
        frames.append(fr)
    meta = {"dsf": dsf, "fps": FPS,
            "clip": {"x": 0, "y": 0, "width": cssw, "height": cssh},
            "frames": frames, "source": "recording",
            "clicks": [{"i": f2e[f], "x": round(x, 1), "y": round(y, 1)} for f, x, y in clicks],
            "keys": [{"i": f2e[f], "text": t} for f, t in keys]}
    if rec.get("name") and rec["name"] != os.path.basename(os.path.abspath(seg)):
        meta["label"] = rec["name"]
    tmp = os.path.join(seg, "meta.json.tmp")
    json.dump(meta, open(tmp, "w"))
    os.replace(tmp, os.path.join(seg, "meta.json"))
    return {"frames": n, "entries": len(entries), "dsf": dsf,
            "clicks": len(clicks), "keys": len(keys), "cursor": "drawn" if cursor else "baked"}


def ingest_webm(seg, rec):
    page, t0 = rec["page"], rec["t0"]
    cssw, cssh = int(page["w"]), int(page["h"])
    log = open(os.path.join(seg, "ingest.log"), "w")
    vw, vh = probe_size(os.path.join(seg, "rec.webm"))
    dsf = max(1, round(vw / cssw))
    fdir = os.path.join(seg, "frames")
    n = demux(os.path.join(seg, "rec.webm"), fdir, cssw * dsf, cssh * dsf, log)
    mice, clicks, keys, cam, breaks = event_tracks(rec, t0, n, cssw, cssh)
    hashes = file_hashes(fdir, n)
    entries = build_entries(hashes, mice, breaks)
    materialize(entries, fdir, hashes, n)
    return emit_meta(seg, rec, entries, cam, mice, clicks, keys, cssw, cssh, dsf, n, cursor=False)


def ingest_frames(seg, rec):
    page = rec["page"]
    cssw, cssh = int(page["w"]), int(page["h"])
    times = json.load(open(os.path.join(seg, "times.json")))
    if not times:
        raise RuntimeError("no frames were streamed")
    ivs, eff = pause_map(rec.get("events") or [])
    if ivs:
        times = [eff(t) for t in times]
        rec = {**rec, "events": [{**e, "t": eff(e["t"])} for e in rec.get("events") or []]}
    t0 = times[0]
    n = max(1, int((times[-1] - t0) * FPS / 1000.0) + 1)
    grid = [max(0, bisect_right(times, t0 + k * 1000.0 / FPS) - 1) for k in range(n)]
    mice, clicks, keys, cam, breaks = event_tracks(rec, t0, n, cssw, cssh)
    entries = build_entries(grid, mice, breaks)
    with Image.open(os.path.join(seg, "raw", "r000000.jpg")) as im:
        dsf = max(1, round(im.width / cssw))
    materialize_raw(entries, grid, seg, cssw * dsf, cssh * dsf)
    return emit_meta(seg, rec, entries, cam, mice, clicks, keys, cssw, cssh, dsf, n, cursor=True)


def ingest_dir(seg):
    rec = json.load(open(os.path.join(seg, "recording.json")))
    if rec.get("mode") == "frames":
        return ingest_frames(seg, rec)
    return ingest_webm(seg, rec)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python3 ingest.py <segment-dir>")
    print(ingest_dir(sys.argv[1]))
