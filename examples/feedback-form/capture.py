#!/usr/bin/env python3
"""Hero demo capture: feedback form fixture (page.html) -> frames/ + meta.json.
Chip toggles + typing + submit spinner + success checkmark, with click pulses."""
import json, os
from playwright.sync_api import sync_playwright

WORKDIR = os.environ.get("VIDEO_DIR", os.getcwd())
START_URL = "file://" + os.path.join(os.path.dirname(os.path.abspath(__file__)), "page.html")
VIEWPORT = (1440, 900)
DSF = 2
FPS = 60

FR = os.path.join(WORKDIR, "frames"); os.makedirs(FR, exist_ok=True)
for f in os.listdir(FR):
    if f.startswith("f") and f.endswith(".jpg"): os.remove(os.path.join(FR, f))

meta = {"dsf": DSF, "fps": FPS, "clip": {"x": 0, "y": 0, "width": VIEWPORT[0], "height": VIEWPORT[1]},
        "frames": [], "clicks": []}

with sync_playwright() as p:
    browser = p.chromium.launch(args=[f"--force-device-scale-factor={DSF}"])
    ctx = browser.new_context(viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]}, device_scale_factor=DSF)
    pg = ctx.new_page()
    pg.goto(START_URL, wait_until="domcontentloaded")
    pg.wait_for_timeout(800)

    st = {"n": 0, "z": 1.0, "fx": VIEWPORT[0]/2, "fy": VIEWPORT[1]/2}
    mouse = {"x": VIEWPORT[0]/2, "y": VIEWPORT[1]/2}
    def entry(): return {"cx": round(st["fx"], 1), "cy": round(st["fy"], 1), "z": round(st["z"], 3),
                         "mx": round(mouse["x"], 1), "my": round(mouse["y"], 1)}
    def shot():
        pg.screenshot(path=os.path.join(FR, f"f{st['n']:05d}.jpg"), type="jpeg", quality=92,
                      clip={"x": 0, "y": 0, "width": VIEWPORT[0], "height": VIEWPORT[1]})
        st["n"] += 1
    def cap():
        shot(); meta["frames"].append(entry())
    def cam(z, focus): st["z"] = z; st["fx"], st["fy"] = focus
    def hold(n):
        for _ in range(n): cap()
    def still(n):
        shot(); meta["frames"].append({**entry(), "repeat": n})
    def ease(t): return 2*t*t if t < 0.5 else 1-((-2*t+2)**2)/2
    def move_to(x, y, n):
        x0, y0 = mouse["x"], mouse["y"]
        for i in range(1, n+1):
            e = ease(i/n); mx, my = x0+(x-x0)*e, y0+(y-y0)*e
            pg.mouse.move(mx, my); mouse["x"], mouse["y"] = mx, my; cap()
    def jump(x, y): pg.mouse.move(x, y); mouse["x"], mouse["y"] = x, y
    def box(sel): return pg.locator(sel).first.bounding_box()
    def center(sel): b = box(sel); return b["x"]+b["width"]/2, b["y"]+b["height"]/2
    def fit_zoom(boxes, margin_px=120, lo=1.1, hi=1.6):
        x0 = min(b["x"] for b in boxes); x1 = max(b["x"]+b["width"] for b in boxes)
        y0 = min(b["y"] for b in boxes); y1 = max(b["y"]+b["height"] for b in boxes)
        z = min((VIEWPORT[0]*DSF)/((x1-x0)*DSF+2*margin_px), (VIEWPORT[1]*DSF)/((y1-y0)*DSF+2*margin_px))
        return max(lo, min(hi, z)), ((x0+x1)/2, (y0+y1)/2)
    def click(x, y):
        pg.mouse.click(x, y)
        meta["clicks"].append({"i": len(meta["frames"]), "x": round(x, 1), "y": round(y, 1)})
    def type_text(text, per_char=3):
        for ch in text:
            pg.keyboard.type(ch)
            hold(per_char)

    # ---- STORYLINE ----
    Z, FOCUS = fit_zoom([box(".card"), box(".stats")], margin_px=150, hi=1.45)
    jump(180, 260); cam(1.0, FOCUS); cap(); still(26)      # overview beat
    cam(Z, FOCUS); still(24)                                # single zoom-in, hold steady

    x, y = center("#chip-friend"); move_to(x, y, 30); still(4)
    click(x, y); hold(16)                                   # chip fills dark + pulse
    x, y = center("#chip-social"); move_to(x, y, 22); still(4)
    click(x, y); hold(16)

    x, y = center("#note"); move_to(x, y - 14, 26); still(4)
    click(x, y - 14); hold(12)                               # focus ring eases in
    type_text("Loving the new editor!", per_char=3)
    still(12)

    x, y = center("#send"); move_to(x, y, 26); still(6)
    click(x, y); hold(46)                                    # spinner -> success swap
    hold(34)                                                 # checkmark draws, count pops
    still(26)                                                # linger on the payoff

    cam(1.0, FOCUS); still(46)                               # graceful zoom-out ending

    json.dump(meta, open(os.path.join(WORKDIR, "meta.json"), "w"))
    print("captured", st["n"], "screenshots /", sum(f.get("repeat", 1) for f in meta["frames"]), "frames ->", WORKDIR)
    browser.close()
