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
root.overrideredirect(True)
root.attributes("-topmost", True)
W, H = 180, 44
root.geometry(f"{W}x{H}+{root.winfo_screenwidth() - W - 24}+{root.winfo_screenheight() - H - 70}")
root.configure(bg="#0f172a")

dot = tk.Canvas(root, width=12, height=12, bg="#0f172a", highlightthickness=0)
dot_id = dot.create_oval(1, 1, 11, 11, fill="#dc2626", outline="")
dot.place(x=14, y=(H - 12) // 2)
label = tk.Label(root, text="0:00", fg="#f8fafc", bg="#0f172a",
                 font=("Helvetica", 13))
label.place(x=34, y=(H - 20) // 2)
stop = tk.Label(root, text="Stop", fg="#f8fafc", bg="#334155",
                font=("Helvetica", 12, "bold"), padx=10, pady=3)
stop.place(x=W - 62, y=(H - 26) // 2)

state = {"stopping": False, "misses": 0, "on": True}

def request_stop(_=None):
    if state["stopping"]:
        return
    state["stopping"] = True
    label.config(text="Stopping…")
    stop.place_forget()
    api("/stop", post=True)

def blink():
    state["on"] = not state["on"]
    dot.itemconfigure(dot_id, fill="#dc2626" if state["on"] or state["stopping"] else "#7f1d1d")
    root.after(650, blink)

def tick():
    if not state["stopping"]:
        s = int(time.time() - T0)
        label.config(text=f"{s // 60}:{s % 60:02d}")
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
    root.after(1000, poll)

drag = {}
def press(e):
    drag["x"], drag["y"] = e.x_root - root.winfo_x(), e.y_root - root.winfo_y()
def move(e):
    root.geometry(f"+{e.x_root - drag['x']}+{e.y_root - drag['y']}")

for widget in (root, dot, label):
    widget.bind("<Button-1>", press)
    widget.bind("<B1-Motion>", move)
stop.bind("<Button-1>", request_stop)

blink()
tick()
root.after(1000, poll)
root.mainloop()
