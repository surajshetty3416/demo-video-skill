#!/usr/bin/env python3
"""Ingest a real-time browser recording into the capture bundle format.

The Chrome extension (extension/) records the active tab with tabCapture (raw
page pixels, no OS cursor) while an injected logger stamps pointer moves,
clicks and shortcut presses with wall-clock ms. This turns that pair —
rec.webm + recording.json in one segment dir — into exactly what
capture_template.py produces: frames/f*.jpg + meta.json with a flat z=1
camera (frame the shots afterwards in the editor).

Frames demux at a constant 60fps. Runs of byte-identical frames under a
parked cursor collapse into `repeat` entries (the still() economy, recovered
after the fact); identical frames under a moving cursor stay separate entries
but hardlink to one file, so disk cost stays near the collapsed size. Frames
carrying a click/key always start their own entry, so pulses and keycaps land
on the exact frame they happened.

Usage:  python3 ingest.py <segment-dir>     (dir holding rec.webm + recording.json)
"""
import hashlib, json, os, subprocess, sys
from bisect import bisect_left

FPS = 60
JPEG_Q = "2"              # ffmpeg -q:v, ~quality 92 — matches Playwright captures
STILL_PX = 1.0            # cursor drift below this collapses into a repeat
GAP_MS = 120.0            # sample gaps beyond this mean a parked cursor: hold,
                          # don't creep — then ease in over the last GAP_MS


def probe_size(video):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", video], text=True)
    w, h = out.strip().splitlines()[0].split(",")[:2]
    return int(w), int(h)


def demux(video, frames_dir, sw, sh, log):
    os.makedirs(frames_dir, exist_ok=True)
    for f in os.listdir(frames_dir):
        if f.startswith("f") and f.endswith((".jpg", ".png")):
            os.remove(os.path.join(frames_dir, f))
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


def file_hashes(frames_dir, n):
    hs = []
    for k in range(n):
        with open(os.path.join(frames_dir, f"f{k:05d}.jpg"), "rb") as f:
            hs.append(hashlib.md5(f.read()).hexdigest())
    return hs


def build_entries(hashes, mice, breaks):
    """Group demuxed frames into meta entries: identical pixels + parked
    cursor extend a repeat; frames in `breaks` (click/key) start their own."""
    entries, i, n = [], 0, len(hashes)
    while i < n:
        j = i + 1
        while (j < n and j not in breaks and hashes[j] == hashes[i]
               and abs(mice[j][0] - mice[i][0]) <= STILL_PX
               and abs(mice[j][1] - mice[i][1]) <= STILL_PX):
            j += 1
        entries.append({"src": i, "repeat": j - i})
        i = j
    return entries


def materialize(entries, frames_dir, hashes, n):
    """Rewrite frames so entry j maps to f{j:05d}.jpg. Entry index never
    exceeds its source index, so renaming in ascending order can't clobber an
    unconsumed source; equal content becomes hardlinks (one copy on disk)."""
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


def ingest_dir(seg):
    video = os.path.join(seg, "rec.webm")
    rec = json.load(open(os.path.join(seg, "recording.json")))
    page, t0, events = rec["page"], rec["t0"], rec.get("events") or []
    cssw, cssh = int(page["w"]), int(page["h"])
    log = open(os.path.join(seg, "ingest.log"), "w")
    vw, vh = probe_size(video)
    dsf = max(1, round(vw / cssw))
    n = demux(video, os.path.join(seg, "frames"), cssw * dsf, cssh * dsf, log)

    mice = mouse_track(events, t0, n, cssw, cssh)
    clicks = [(frame_of(e["t"], t0, n), e["x"], e["y"]) for e in events if e.get("k") == "c"]
    keys = [(frame_of(e["t"], t0, n), e["text"]) for e in events
            if e.get("k") == "k" and e.get("text")]
    breaks = {f for f, _, _ in clicks} | {f for f, _ in keys}

    hashes = file_hashes(os.path.join(seg, "frames"), n)
    entries = build_entries(hashes, mice, breaks)
    materialize(entries, os.path.join(seg, "frames"), hashes, n)
    f2e = [0] * n
    for j, e in enumerate(entries):
        for k in range(e["src"], e["src"] + e["repeat"]):
            f2e[k] = j

    frames = []
    for e in entries:
        mx, my = mice[e["src"]]
        fr = {"cx": round(cssw / 2, 1), "cy": round(cssh / 2, 1), "z": 1.0, "mx": mx, "my": my}
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
    summary = {"frames": n, "entries": len(entries), "dsf": dsf,
               "clicks": len(clicks), "keys": len(keys)}
    print(f"ingested {seg}: {summary}", file=log, flush=True)
    return summary


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: python3 ingest.py <segment-dir>  (with rec.webm + recording.json)")
    print(ingest_dir(sys.argv[1]))
