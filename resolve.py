"""Shared meta resolver: bakes trim + per-clip speed (+ legacy pace) into plain
repeat counts. Entry k must keep mapping to frames/f{k:05d}.jpg, so interior
drops become repeat:0 and only the tail is truncated. Mirrored exactly by the
editor's JS preview (engine.js resolveMeta) — keep the math in lockstep."""
import math

RAMP_DEFAULT = 0.6  # seconds a speed transition eases over, unless meta overrides


def smooth_mults(mults, fps, ramp):
    """Raised-cosine smoothing of per-entry multipliers in log space, replicate-
    padded. The 1e-6 rounding collapses libm-vs-V8 ulp drift so Python and JS
    resample identical numbers. Uniform input returns untouched (identity)."""
    n = len(mults)
    if n == 0 or all(v == mults[0] for v in mults):
        return mults
    w = int(fps * max(ramp, 0) + 0.5) | 1
    if w <= 1:
        return mults
    half = (w - 1) // 2
    ker = [1 + math.cos(math.pi * d / (half + 1)) for d in range(-half, half + 1)]
    ksum = sum(ker)
    logs = [math.log(v) for v in mults]
    out = []
    for i in range(n):
        acc = 0.0
        for d in range(-half, half + 1):
            j = min(max(i + d, 0), n - 1)
            acc += ker[d + half] * logs[j]
        out.append(math.floor(math.exp(acc / ksum) * 1e6 + 0.5) / 1e6)
    return out


def resolve_meta(m):
    frames = [dict(f) for f in m["frames"]]
    n = len(frames)
    trim = m.get("trim") or {}
    tin, tout = int(trim.get("in", 0)), int(trim.get("out", n - 1))
    reps = [int(f.get("repeat", 1)) for f in frames]
    for i in range(n):
        if i < tin or i > min(tout, n - 1):
            reps[i] = 0
    pace = float(m.get("pace") or 1)
    mults = [pace if pace > 0 else 1.0] * n
    for sp in m.get("speed") or []:
        mult = float(sp["mult"])
        if mult <= 0:
            continue
        for i in range(max(0, int(sp["from"])), min(n, int(sp["to"]))):
            mults[i] *= mult
    ramp = m.get("speedRamp")
    mults = smooth_mults(mults, m.get("fps", 60), RAMP_DEFAULT if ramp is None else float(ramp))
    acc = 0.0
    for i in range(n):
        if reps[i] == 0:
            continue
        if mults[i] == 1:
            acc = 0.0
            continue
        acc += reps[i] / mults[i]
        k = int(acc)
        acc -= k
        reps[i] = k
    last = max((i for i in range(n) if reps[i] > 0), default=0)
    frames, reps = frames[:last + 1], reps[:last + 1]
    kept = [i for i in range(len(frames)) if reps[i] > 0]

    def snap(i):
        for k in kept:
            if k >= i:
                return k
        return kept[-1] if kept else None

    for i, f in enumerate(frames):
        f["repeat"] = reps[i]
    for r in m.get("cursorHide") or []:
        for i in range(max(0, int(r["from"])), min(len(frames), int(r["to"]))):
            frames[i]["mx"] = frames[i]["my"] = None
    for c in m.get("captions") or []:      # baked per entry; later regions win
        for i in range(max(0, int(c["from"])), min(len(frames), int(c["to"]))):
            frames[i]["cap"] = c["text"]
    out = {"dsf": m["dsf"], "fps": m.get("fps", 60), "clip": m["clip"], "frames": frames}
    for key in ("clicks", "keys"):
        evts = []
        for e in m.get(key) or []:
            j = snap(int(e["i"]))
            if j is None:
                continue
            e2 = dict(e)
            e2["i"] = j
            evts.append(e2)
        out[key] = evts
    return out


def needs_resolve(m):
    return bool(m.get("speed") or m.get("trim") or m.get("cursorHide") or m.get("captions")
                or (m.get("pace") and float(m["pace"]) != 1))
