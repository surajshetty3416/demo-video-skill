#!/usr/bin/env python3
# EXAMPLE (illustrative) — the multi-case "tile" pattern from SKILL.md, applied to
# Frappe Builder's on-canvas reorder engine. Shows: seed a throwaway fixture via the
# app API (deleted in `finally`), lay out labeled tiles that all fit the viewport, one
# camera beat per tile at a gentle hold-zoom (fit_zoom hi=1.75), read drag targets live,
# cross the drag threshold, linger on the center-drop finale, then a zoom-out ending.
# still() for camera settles (page static); hold() around drags (the app animates).
# Adapt CONFIG + the block fixture + the STORYLINE to your own app; the harness verbs
# and camera timeline are identical to capture_template.py.

"""Deterministic capture of ALL reorder cases -> frames/ + meta.json (pairs with compositor.py)."""
import json, os, urllib.request, urllib.parse, http.cookiejar
from playwright.sync_api import sync_playwright

WORKDIR = os.environ.get("VIDEO_DIR", os.getcwd())
BASE = "http://builder.test:8080"; HOST = "builder.test"
VIEWPORT = (1600, 1000); DSF = 2; FPS = 60

# ---------- build fixture ----------
COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#14b8a6"]
def box(bid, color, w=64, h=64, extra=None):
    s = {"width": f"{w}px", "height": f"{h}px", "backgroundColor": color, "borderRadius": "8px"}
    if extra: s.update(extra)
    return {"blockId": bid, "element": "div", "children": [], "baseStyles": s}
def label(bid, text):
    return {"blockId": bid, "element": "p", "innerHTML": text, "children": [],
            "baseStyles": {"fontSize": "13px", "fontWeight": "600", "color": "#475569", "margin": "0px"}}
def tile(bid, title, inner):
    return {"blockId": bid, "element": "div", "children": [label(bid+"-lbl", title), inner],
            "baseStyles": {"display": "flex", "flexDirection": "column", "gap": "12px", "padding": "18px",
                           "backgroundColor": "#ffffff", "border": "1px solid #e2e8f0", "borderRadius": "14px",
                           "width": "400px", "boxSizing": "border-box", "boxShadow": "0 1px 2px rgba(0,0,0,0.05)"}}
def card(bid, color):
    bar = {"blockId": bid+"-bar", "element": "div", "children": [],
           "baseStyles": {"width": "100%", "height": "18px", "backgroundColor": "#00000026", "borderRadius": "4px"}}
    return {"blockId": bid, "element": "div", "children": [bar],
            "baseStyles": {"width": "88px", "height": "88px", "display": "flex", "flexDirection": "column",
                           "justifyContent": "flex-end", "padding": "8px", "boxSizing": "border-box",
                           "backgroundColor": color}}

row_inner = {"blockId": "row", "element": "div", "children": [box(f"r{i}", COLORS[i]) for i in range(4)],
             "baseStyles": {"display": "flex", "flexDirection": "row", "gap": "12px"}}
col_inner = {"blockId": "col", "element": "div", "children": [box(f"c{i}", COLORS[i], 130, 34) for i in range(3)],
             "baseStyles": {"display": "flex", "flexDirection": "column", "gap": "10px"}}
grid_inner = {"blockId": "grid", "element": "div", "children": [box(f"g{i}", COLORS[i], 56, 48) for i in range(6)],
              "baseStyles": {"display": "grid", "gridTemplateColumns": "repeat(3, 56px)", "gap": "10px"}}
cards_inner = {"blockId": "cards", "element": "div", "children": [card("k0", "#ef4444"), card("k1", "#22c55e"), card("k2", "#3b82f6")],
               "baseStyles": {"display": "flex", "flexDirection": "row", "gap": "0px"}}
nest_inner = {"blockId": "nest", "element": "div",
              "children": [box("nbox", "#f59e0b"),
                           {"blockId": "nzone", "element": "div", "children": [],
                            "baseStyles": {"width": "165px", "height": "120px", "border": "2px dashed #94a3b8",
                                           "borderRadius": "10px", "backgroundColor": "#f8fafc", "boxSizing": "border-box",
                                           "display": "flex", "justifyContent": "center", "alignItems": "center"}}],
              "baseStyles": {"display": "flex", "flexDirection": "row", "gap": "18px", "alignItems": "center"}}

tiles = [tile("tile1", "Flex row — reorder", row_inner),
         tile("tile2", "Flex column — reorder", col_inner),
         tile("tile3", "CSS grid — 2D reorder", grid_inner),
         tile("tile4", "Flush cards — edge reorders, core nests", cards_inner),
         tile("tile5", "Center drop — indicator follows justify/align", nest_inner)]
wrap = {"blockId": "wrap", "element": "div", "children": tiles,
        "baseStyles": {"display": "flex", "flexWrap": "wrap", "gap": "22px", "justifyContent": "center", "maxWidth": "858px"}}
heading = {"blockId": "hd", "element": "p", "innerHTML": "Canvas block reorder", "children": [],
           "baseStyles": {"fontSize": "22px", "fontWeight": "700", "color": "#0f172a", "margin": "0px"}}
ROOT = {"blockId": "root", "element": "div", "children": [heading, wrap],
        "baseStyles": {"display": "flex", "flexDirection": "column", "alignItems": "center", "gap": "22px",
                       "minHeight": "100vh", "padding": "44px 24px", "backgroundColor": "#f1f5f9"}}
FIX = json.dumps([ROOT])

cj = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
def api(path, payload):
    return json.load(op.open(urllib.request.Request(BASE+path, data=json.dumps(payload).encode(),
                     headers={"Host": HOST, "Content-Type": "application/json"})))
op.open(urllib.request.Request(BASE+"/api/method/login", data=urllib.parse.urlencode({"usr": "Administrator", "pwd": "admin"}).encode(), headers={"Host": HOST}))
PAGE = api("/api/method/frappe.client.insert", {"doc": {"doctype": "Builder Page", "page_title": "Reorder Demo", "blocks": FIX, "draft_blocks": FIX}})["message"]["name"]
print("fixture:", PAGE)
START_URL = f"{BASE}/builder/page/{PAGE}"

FR = os.path.join(WORKDIR, "frames"); os.makedirs(FR, exist_ok=True)
for f in os.listdir(FR):
    if f.startswith("f") and f.endswith(".jpg"): os.remove(os.path.join(FR, f))

meta = {"dsf": DSF, "fps": FPS, "clip": {"x": 0, "y": 0, "width": VIEWPORT[0], "height": VIEWPORT[1]}, "frames": []}
sel = lambda bid: f'[data-block-id="{bid}"][data-breakpoint="desktop"]'

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[f"--force-device-scale-factor={DSF}"])
        ctx = browser.new_context(viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]}, device_scale_factor=DSF)
        ctx.request.post(BASE+"/api/method/login", form={"usr": "Administrator", "pwd": "admin"}, headers={"Host": HOST})
        pg = ctx.new_page()
        pg.goto(START_URL, wait_until="domcontentloaded")
        pg.wait_for_selector(sel("r0"), timeout=25000); pg.wait_for_timeout(1600)

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
        def hold(n):                                   # live frames: app may be animating
            for _ in range(n): cap()
        def still(n):                                  # static page: 1 screenshot stands for n frames
            shot(); meta["frames"].append({**entry(), "repeat": n})
        def ease(t): return 2*t*t if t < 0.5 else 1-((-2*t+2)**2)/2
        def move_to(x, y, n):
            x0, y0 = mouse["x"], mouse["y"]
            for i in range(1, n+1):
                e = ease(i/n); mx, my = x0+(x-x0)*e, y0+(y-y0)*e
                pg.mouse.move(mx, my); mouse["x"], mouse["y"] = mx, my; cap()
        def jump(x, y): pg.mouse.move(x, y); mouse["x"], mouse["y"] = x, y
        def box(s): return pg.locator(s).first.bounding_box()
        def fit_zoom(boxes, margin_px=130, lo=1.1, hi=1.75):
            x0 = min(b["x"] for b in boxes); x1 = max(b["x"]+b["width"] for b in boxes)
            y0 = min(b["y"] for b in boxes); y1 = max(b["y"]+b["height"] for b in boxes)
            z = min((VIEWPORT[0]*DSF)/((x1-x0)*DSF+2*margin_px), (VIEWPORT[1]*DSF)/((y1-y0)*DSF+2*margin_px))
            return max(lo, min(hi, z)), ((x0+x1)/2, (y0+y1)/2)

        def frame_tile(tsel):
            z, f = fit_zoom([box(tsel)]); cam(z, f); still(20)
        def do_drag(pid, top_grab, tid, fx, fy, approach=26, dragN=72, settle=10):
            b = box(sel(pid)); px = b["x"]+b["width"]/2; py = b["y"]+(14 if top_grab else b["height"]/2)
            move_to(px, py, approach); pg.mouse.down(); move_to(px+9, py, 6)
            d = box(sel(tid)); tx = d["x"]+d["width"]*fx; ty = d["y"]+d["height"]*fy
            move_to(tx, ty, dragN); hold(settle); pg.mouse.up(); hold(22)
        def deselect():
            pg.keyboard.press("Escape"); hold(6)

        # ---- STORYLINE ----
        Z_ALL, FOCUS_ALL = fit_zoom([box(sel("wrap"))], margin_px=90, lo=1.0, hi=1.25)
        jump(140, 240); cam(1.0, FOCUS_ALL); cap(); still(30)     # overview

        frame_tile(sel("tile1")); do_drag("r0", False, "r3", 0.90, 0.5); deselect()      # flex row
        frame_tile(sel("tile2")); do_drag("c2", False, "c0", 0.50, 0.14); deselect()     # flex column
        frame_tile(sel("tile3")); do_drag("g0", False, "g4", 0.75, 0.5); deselect()      # grid 2D
        frame_tile(sel("tile4")); do_drag("k0", True, "k2", 0.85, 0.5); deselect()       # flush cards edge
        frame_tile(sel("tile5")); do_drag("nbox", False, "nzone", 0.5, 0.5, settle=34); deselect()  # center drop

        cam(1.0, FOCUS_ALL); still(46)                             # graceful zoom-out + linger

        json.dump(meta, open(os.path.join(WORKDIR, "meta.json"), "w"))
        print("captured", st["n"], "screenshots /", sum(f.get("repeat", 1) for f in meta["frames"]), "frames ->", WORKDIR)
        browser.close()
finally:
    api("/api/method/frappe.client.delete", {"doctype": "Builder Page", "name": PAGE})
    print("deleted fixture", PAGE)
