#!/usr/bin/env python3
"""Always-on-top recording pill, spawned by server.py when a streamed
(drawn-cursor) recording starts. A separate OS window floats over the browser
— always visible, never part of the captured tab pixels. Stop posts a flag
the extension picks up on its next flush/poll; the pill closes itself once
the import leaves the recording state.

Usage: python3 recpill.py <import-id> <server-port>
"""
import json, sys, time, urllib.request

try:
    import tkinter as tk
except ImportError:
    sys.exit(0)

IMPORT_ID, PORT = sys.argv[1], sys.argv[2]
BASE = f"http://127.0.0.1:{PORT}/api/import/{IMPORT_ID}"
T0 = time.time()

def api(path, post=False):
    try:
        req = urllib.request.Request(BASE + path, data=b"{}" if post else None,
                                     headers={"Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=2).read())
    except Exception:
        return None

root = tk.Tk()
root.withdraw()
# borderless non-activating HUD: on macOS Tk 9 NEITHER call works alone —
# the style strips the title bar only once overrideredirect is also set
try:
    root.tk.call("::tk::unsupported::MacWindowStyle", "style", root._w, "help", "noActivates")
except tk.TclError:
    pass
root.overrideredirect(True)
root.attributes("-topmost", True)

W, H = 176, 46
try:
    root.attributes("-transparent", True)
    BG = "systemTransparent"
except tk.TclError:
    BG = "#191919"
root.config(bg=BG)
cv = tk.Canvas(root, width=W, height=H, bg=BG, highlightthickness=0)
cv.pack()

def rrect(x0, y0, x1, y1, r, **kw):
    pts = [x0 + r, y0, x1 - r, y0, x1, y0, x1, y0 + r, x1, y1 - r, x1, y1,
           x1 - r, y1, x0 + r, y1, x0, y1, x0, y1 - r, x0, y0 + r, x0, y0]
    return cv.create_polygon(pts, smooth=True, **kw)

body = rrect(0, 0, W, H, 23, fill="#191919", outline="")
dot = cv.create_oval(18, H / 2 - 5, 28, H / 2 + 5, fill="#dc2626", outline="")
timer = cv.create_text(40, H / 2, text="0:00", anchor="w", fill="#f8f8f8",
                       font=("Helvetica", 14))
stop_bg = rrect(W - 70, 9, W - 12, H - 9, 14, fill="#383838", outline="")
stop_tx = cv.create_text(W - 41, H / 2, text="Stop", fill="#f8f8f8",
                         font=("Helvetica", 12, "bold"))

state = {"stopping": False, "misses": 0, "on": True, "paused_at": None, "paused_total": 0.0}

def request_stop(_=None):
    if state["stopping"]:
        return
    state["stopping"] = True
    cv.itemconfigure(stop_bg, state="hidden")
    cv.itemconfigure(stop_tx, state="hidden")
    cv.itemconfigure(timer, text="Stopping…")
    api("/stop", post=True)

def blink():
    if state["paused_at"] is not None:
        cv.itemconfigure(dot, fill="#737373")
    else:
        state["on"] = not state["on"]
        cv.itemconfigure(dot, fill="#dc2626" if state["on"] else "#7f1d1d")
    root.after(650, blink)

def tick():
    if not state["stopping"]:
        now = time.time()
        pausing = now - state["paused_at"] if state["paused_at"] is not None else 0.0
        s = int(now - T0 - state["paused_total"] - pausing)
        label = f"{s // 60}:{s % 60:02d}"
        if state["paused_at"] is not None:
            label += "  ⏸"
        cv.itemconfigure(timer, text=label)
    root.after(500, tick)

def poll():
    st = api("/status")
    if st is None:
        state["misses"] += 1
        if state["misses"] > 3:
            return root.destroy()
    else:
        state["misses"] = 0
        if st.get("status") != "recording":
            return root.destroy()
        paused = bool(st.get("paused"))
        if paused and state["paused_at"] is None:
            state["paused_at"] = time.time()
        elif not paused and state["paused_at"] is not None:
            state["paused_total"] += time.time() - state["paused_at"]
            state["paused_at"] = None
    root.after(1000, poll)

drag = {}
def press(e):
    drag["x"], drag["y"] = e.x_root - root.winfo_x(), e.y_root - root.winfo_y()
def move(e):
    root.geometry(f"+{e.x_root - drag['x']}+{e.y_root - drag['y']}")

for item in (body, dot, timer):
    cv.tag_bind(item, "<Button-1>", press)
    cv.tag_bind(item, "<B1-Motion>", move)
for item in (stop_bg, stop_tx):
    cv.tag_bind(item, "<Button-1>", request_stop)

root.geometry(f"{W}x{H}+{root.winfo_screenwidth() - W - 24}+{root.winfo_screenheight() - H - 70}")
root.deiconify()
blink()
tick()
root.after(1000, poll)
root.mainloop()
