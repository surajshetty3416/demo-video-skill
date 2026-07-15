#!/usr/bin/env python3
"""Deterministic frame capture for a polished demo video (pairs with compositor.py).

Drives any web app with Playwright, ONE STEP PER FRAME, screenshotting each — so the
result is true 60fps regardless of how slow capture is (wall-clock != playback time).
Records a camera timeline (focus + zoom per frame) AND the mouse position to meta.json;
the compositor turns raw frames into the ScreenStudio look and draws a crisp vector
cursor (no cursor is baked into the page). Fill in CONFIG + the STORYLINE section.

Run:  VIDEO_DIR=/abs/workdir python capture_template.py
Then: python compositor.py $VIDEO_DIR        (HD=1 for on-demand retina output)
"""
import json, os
from playwright.sync_api import sync_playwright

# ---- CONFIG ----------------------------------------------------------------
WORKDIR   = os.environ.get("VIDEO_DIR", os.getcwd())
BASE      = "http://localhost:8080"
START_URL = BASE + "/"
LOGIN     = None            # e.g. {"url": BASE+"/api/method/login", "usr":"admin","pwd":"admin", "host":"app.test"}
VIEWPORT  = (1440, 900)     # capture the COMPLETE interface; bigger viewport = more zoom headroom
DSF       = 2              # device scale factor (2 = crisp / more pixels to zoom into)
FPS       = 60
# ---------------------------------------------------------------------------

FR = os.path.join(WORKDIR, "frames"); os.makedirs(FR, exist_ok=True)
for f in os.listdir(FR):
    if f.startswith("f") and f.endswith(".jpg"): os.remove(os.path.join(FR, f))

meta = {"dsf": DSF, "fps": FPS, "clip": {"x":0,"y":0,"width":VIEWPORT[0],"height":VIEWPORT[1]}, "frames": []}

with sync_playwright() as p:
    browser = p.chromium.launch(args=[f"--force-device-scale-factor={DSF}"])
    ctx = browser.new_context(viewport={"width":VIEWPORT[0],"height":VIEWPORT[1]}, device_scale_factor=DSF)
    if LOGIN:
        ctx.request.post(LOGIN["url"], form={"usr":LOGIN["usr"],"pwd":LOGIN["pwd"]},
                         headers=({"Host":LOGIN["host"]} if LOGIN.get("host") else {}))
    pg = ctx.new_page()
    pg.goto(START_URL, wait_until="domcontentloaded")
    pg.wait_for_timeout(1500)               # let the app settle

    # ---- camera + capture harness (camera is DECOUPLED from the mouse) ----
    st = {"n":0, "z":1.0, "fx":VIEWPORT[0]/2, "fy":VIEWPORT[1]/2}
    mouse = {"x": VIEWPORT[0]/2, "y": VIEWPORT[1]/2}
    def entry(): return {"cx":round(st["fx"],1),"cy":round(st["fy"],1),"z":round(st["z"],3),
                         "mx":round(mouse["x"],1),"my":round(mouse["y"],1)}
    def shot():
        pg.screenshot(path=os.path.join(FR,f"f{st['n']:05d}.jpg"), type="jpeg", quality=92,
                      clip={"x":0,"y":0,"width":VIEWPORT[0],"height":VIEWPORT[1]})
        st["n"] += 1
    def cap():
        shot(); meta["frames"].append(entry())
    def cam(z, focus): st["z"]=z; st["fx"],st["fy"]=focus     # set camera TARGET (compositor eases to it)
    def hold(n):                                              # n LIVE frames — use while the APP animates
        for _ in range(n): cap()
    def still(n):                                             # n frames from ONE screenshot — use for camera
        shot(); meta["frames"].append({**entry(), "repeat": n})   # settles/lingers on a static page (fast)
    def ease(t): return 2*t*t if t<0.5 else 1-((-2*t+2)**2)/2
    def move_to(x, y, n):                                     # smooth mouse move, one capture per frame
        x0,y0 = mouse["x"],mouse["y"]
        for i in range(1,n+1):
            e=ease(i/n); mx,my=x0+(x-x0)*e, y0+(y-y0)*e
            pg.mouse.move(mx,my); mouse["x"],mouse["y"]=mx,my; cap()
    def jump(x, y): pg.mouse.move(x,y); mouse["x"],mouse["y"]=x,y
    def box(sel): return pg.locator(sel).first.bounding_box()
    def center(sel): b=box(sel); return b["x"]+b["width"]/2, b["y"]+b["height"]/2
    def fit_zoom(boxes, margin_px=110, lo=1.15, hi=1.6):     # steady zoom that frames given elements
        x0=min(b["x"] for b in boxes); x1=max(b["x"]+b["width"] for b in boxes)
        y0=min(b["y"] for b in boxes); y1=max(b["y"]+b["height"] for b in boxes)
        z=min((VIEWPORT[0]*DSF)/((x1-x0)*DSF+2*margin_px), (VIEWPORT[1]*DSF)/((y1-y0)*DSF+2*margin_px))
        return max(lo,min(hi,z)), ((x0+x1)/2,(y0+y1)/2)

    # ======================= STORYLINE (edit me) =======================
    # Principles (learned the hard way — see SKILL.md):
    #  - DECOUPLE camera from cursor: set cam() to a stable region, not the pointer.
    #  - Zoom in ONCE up front; hold it STEADY through the action. Don't zoom per-step.
    #  - still(n) for camera settles / lingers (page static: 1 screenshot, n frames).
    #    hold(n) when the APP is animating (post-click/drop transitions): live frames.
    #  - For drag-and-drop, read the target element's coords LIVE (after the drag
    #    starts) — the layout shifts when you pick something up.
    #  - Close with a zoom-OUT + linger (compositor's END_EXTRA finishes the settle).

    Z, FOCUS = fit_zoom([box("body")])          # e.g. fit_zoom([box("#a"), box("#b")])
    jump(120, 200); cam(1.0, FOCUS); cap(); still(30)
    cam(Z, FOCUS); still(26)                    # single zoom-in, then hold steady

    # --- example beat: move to something and click ---
    # x,y = center("text=Some Button"); move_to(x,y,34); still(6); pg.mouse.click(x,y); hold(24)

    # --- example beat: drag-and-drop (read destination LIVE after pickup) ---
    # sx,sy = center("#item"); move_to(sx,sy,30); pg.mouse.down(); move_to(sx+10,sy,10)
    # d = box("#target"); move_to(d["x"]+d["width"]/2, d["y"]+d["height"]/2, 90); hold(20)
    # pg.mouse.up(); hold(24)

    cam(1.0, FOCUS); still(40)                  # graceful zoom-out ending
    # ===================================================================

    json.dump(meta, open(os.path.join(WORKDIR,"meta.json"),"w"))
    print("captured", st["n"], "screenshots /", sum(f.get("repeat",1) for f in meta["frames"]), "frames ->", WORKDIR)
    browser.close()
