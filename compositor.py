#!/usr/bin/env python3
"""Generic ScreenStudio-style compositor: clean captured frames + a camera
timeline -> polished demo.mp4 (gradient background, rounded window with a soft
shadow that scales with the zoom, vector cursor, click pulses, shortcut keycaps,
smooth zoom/pan, extended ending). Pure Pillow + ffmpeg.

Renders with a worker pool and streams frames straight into one ffmpeg process:
no intermediate frames_out/ PNGs and no second encode pass. Identical still
frames (settled camera) are rendered once and repeated.

Input  (in WORKDIR):  meta.json  +  frames/f00000.jpg ...   (see capture_template.py)
Output (in WORKDIR):  demo.mp4   (+ ffmpeg.log)

meta.json = {"dsf":2, "fps":60, "clip":{"x","y","width","height"},
             "frames":[{"cx","cy","z", "mx"?,"my"?, "repeat"?}, ...],
             "clicks":[{"i","x","y"}, ...]?,   # frame index + position of each click;
                                               # an indigo pulse ring animates there
             "keys":[{"i","text"}, ...]?}      # frame index + shortcut ("⌘+Enter"):
                                               # keycaps fade in at the bottom of the frame
  cx,cy = camera FOCUS point in page(CSS) px; z = zoom (1.0 = whole capture).
  mx,my = mouse position (CSS px): the cursor is drawn HERE, crisp at any zoom.
          Absent (old captures with the DOM cursor baked in) -> no overlay drawn.
  repeat = this captured frame stands for N output frames (written by still();
  the camera keeps easing across the repeats). Old metas without it still work.

Usage:  python compositor.py [WORKDIR]        (WORKDIR defaults to $VIDEO_DIR or cwd)
        HD=1 python compositor.py [WORKDIR]   (on-demand retina output: 2x panel,
                                               uses ALL pixels of a DSF=2 capture)
"""
import io, json, os, subprocess, sys
from math import ceil, floor
from multiprocessing import Pool
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---- knobs -----------------------------------------------------------------
PANEL_SCALE = int(os.environ.get("PANEL_SCALE", "2" if os.environ.get("HD") == "1" else "1"))
PANEL_BASE_W = 1460       # panel width at scale 1; height derives from aspect
MARGIN    = 80 * PANEL_SCALE   # background border around the panel
RAD       = 20 * PANEL_SCALE   # panel corner radius
ZOOM_EMA  = 0.11          # camera easing (smaller = gentler/slower). pan below
PAN_EMA   = 0.13          # too small and multi-shot moves never reach their target
END_EXTRA = 95            # extra tail frames rendered on the LAST frame so a closing
                          # zoom-out fully settles + lingers (no abrupt cut)
GRAD = [(0.0,(238,242,255)), (0.5,(237,233,254)), (1.0,(250,232,255))]  # diagonal stops
SHADOW_SS = 8             # the window shadow is soft: blur it at 1/8 scale
SHADOW_ALPHA = 120        # shadow strength (0..255)
SHADOW_BLUR = 34          # shadow blur radius (scaled by PANEL_SCALE)
CURSOR_CSS_H = 34         # cursor height in page CSS px (enlarged for legibility)
PULSE_N = 18              # frames a click pulse ring lives (~0.3s)
PULSE_COLOR = (99,102,241)
KEY_H = 46                # keycap height in output px (scaled by PANEL_SCALE)
KEY_INSET = 34            # gap between the keycap row and the bottom of the frame
KEY_N = 58                # frames a shortcut hint stays on screen (~1s)
KEY_FONTS = ["/System/Library/Fonts/SFNSRounded.ttf", "/System/Library/Fonts/SFNS.ttf",
             "/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial Unicode.ttf",
             "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]
CRF, PRESET = 18, "fast"  # libx264 quality/speed
WORKERS = max(2, (os.cpu_count() or 8) - 2)
# KNOBS_JSON: path to a json whose keys override the constants above (editor/).
if os.environ.get("KNOBS_JSON"):
    globals().update(json.load(open(os.environ["KNOBS_JSON"])))
# ---------------------------------------------------------------------------

WORKDIR = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VIDEO_DIR", os.getcwd())
FR = os.path.join(WORKDIR, "frames")

# META_FILE: alternate meta json (editor renders meta.render.json; default unchanged)
meta = json.load(open(os.environ.get("META_FILE") or os.path.join(WORKDIR, "meta.json")))
clip, dsf, FPS = meta["clip"], meta["dsf"], meta.get("fps", 60)
SW, SH = clip["width"]*dsf, clip["height"]*dsf

EXT = ".jpg" if os.path.exists(os.path.join(FR, "f00000.jpg")) else ".png"
def srcpath(i): return os.path.join(FR, f"f{i:05d}{EXT}")

PANEL_W = min(PANEL_BASE_W*PANEL_SCALE, SW); PANEL_W -= PANEL_W % 2
PANEL_H = round(PANEL_W*SH/SW); PANEL_H -= PANEL_H % 2
BG_W = (PANEL_W+2*MARGIN); BG_W -= BG_W % 2
BG_H = (PANEL_H+2*MARGIN); BG_H -= BG_H % 2

def lerp(a,b,t): return tuple(round(a[i]+(b[i]-a[i])*t) for i in range(3))
def grad(t):
    for i in range(len(GRAD)-1):
        (t0,c0),(t1,c1) = GRAD[i], GRAD[i+1]
        if t <= t1: return lerp(c0,c1,(t-t0)/(t1-t0))
    return GRAD[-1][1]

# background (gradient + central lift), built small and upscaled — everything
# here is soft, so 1/8 scale is visually identical
def build_bg(ss=8):
    w, h = BG_W//ss, BG_H//ss
    bg = Image.new("RGB",(w,h)); px = bg.load(); diag = w+h
    for y in range(h):
        for x in range(w): px[x,y] = grad((x+y)/diag)
    vig = Image.new("L",(w,h),0)
    ImageDraw.Draw(vig).ellipse([-w*0.25,-h*0.25,w*1.25,h*1.25], fill=40)
    bg = Image.composite(Image.new("RGB",(w,h),(255,255,255)), bg,
                         vig.filter(ImageFilter.GaussianBlur(120//ss)))
    return bg.resize((BG_W,BG_H), Image.BILINEAR)

bg_base = build_bg()
DARK = Image.new("RGB",(BG_W,BG_H),(15,23,42))

# the window's drop shadow follows it as it scales/pans. Drawn at full res, then
# blurred at 1/8 scale: the downscale keeps the sub-pixel position, so the shadow
# glides with the window instead of stepping in 8px jumps.
def shadow(ox, oy, pw, ph, z):
    off = 10*PANEL_SCALE*z
    m = Image.new("L",(BG_W,BG_H),0)
    ImageDraw.Draw(m).rounded_rectangle([ox, oy+off, ox+pw, oy+ph+off],
                                        radius=max(1,round(RAD*z)), fill=SHADOW_ALPHA)
    m = m.resize((BG_W//SHADOW_SS, BG_H//SHADOW_SS), Image.BILINEAR)
    return m.filter(ImageFilter.GaussianBlur(SHADOW_BLUR*PANEL_SCALE/SHADOW_SS)).resize((BG_W,BG_H), Image.BILINEAR)

# vector cursor sprite (macOS-style arrow: black fill, white outline, soft shadow),
# rendered at the exact final size per frame — crisp at any zoom. Cached per size.
CUR_PATH = [(6.4,2),(6.4,18.9),(10.4,15.1),(12.9,20.9),(15.7,19.7),(13.2,13.9),(18.6,13.9)]
TIP = (6.4, 2)
_sprites = {}
def cursor_sprite(size):
    sp = _sprites.get(size)
    if sp: return sp
    aa, pad = 4, 6
    s = size*aa/24.0; box = (size+2*pad)*aa
    pts = [((x+pad*24.0/size)*s, (y+pad*24.0/size)*s) for x,y in CUR_PATH]
    sh = Image.new("L",(box,box),0)
    ImageDraw.Draw(sh).polygon([(x,y+2*s) for x,y in pts], fill=110)
    img = Image.new("RGBA",(box,box),(0,0,0,0))
    img.paste((15,23,42,255),(0,0), sh.filter(ImageFilter.GaussianBlur(3*s)))
    m = Image.new("L",(box,box),0)
    ImageDraw.Draw(m).polygon(pts, fill=255)
    rim = m.filter(ImageFilter.MaxFilter(2*max(1,round(1.1*s))+1))  # dilate: white rim outside
    img.paste((255,255,255,255),(0,0), rim)
    img.paste((10,10,12,255),(0,0), m)

    sp = _sprites[size] = (img.resize((box//aa,box//aa), Image.LANCZOS), pad)
    return sp

def draw_pulse(img, x, y, age, size):
    t = age/PULSE_N
    r = size*(0.42 + 1.15*(1-(1-t)**2)); a = round(170*(1-t))
    if a <= 0 or r < 2: return
    aa = 4; R = round(r*aa); w = max(aa, round(size*0.1*aa*(1-0.4*t))); D = 2*R+2*w
    ring = Image.new("RGBA",(D,D),(0,0,0,0))
    ImageDraw.Draw(ring).ellipse([w//2,w//2,D-w//2,D-w//2], outline=PULSE_COLOR+(a,), width=w)
    ring = ring.resize((D//aa,D//aa), Image.LANCZOS)
    img.alpha_composite(ring, (round(x-ring.width/2), round(y-ring.height/2)))

# keyboard-shortcut HUD: a row of keycaps at the bottom of the frame ("⌘+Enter" ->
# two caps), rendered 3x and downscaled so the corners and glyphs stay smooth.
_keycaps, _fonts = {}, {}
def key_font(px):
    f = _fonts.get(px)
    if f is None:
        for path in KEY_FONTS:
            try: f = ImageFont.truetype(path, px)
            except OSError: continue
            try: f.set_variation_by_name("Semibold")
            except Exception: pass
            break
        f = _fonts[px] = f or ImageFont.load_default(px)
    return f

def key_sprite(text):
    sp = _keycaps.get(text)
    if sp: return sp
    aa = 3; h = round(KEY_H*PANEL_SCALE)*aa
    font = key_font(round(h*0.42))
    caps = [c.strip() for c in text.split("+") if c.strip()]
    pad, gap, rad, blur = round(h*0.34), round(h*0.18), round(h*0.27), round(h*0.13)
    boxes = [font.getbbox(c) for c in caps]
    ws = [max(h, b[2]-b[0]+2*pad) for b in boxes]
    m = 3*blur
    img = Image.new("RGBA", (sum(ws)+gap*(len(caps)-1)+2*m, h+2*m), (0,0,0,0))
    d = ImageDraw.Draw(img); x = m
    for c, b, w in zip(caps, boxes, ws):
        d.rounded_rectangle([x, m, x+w, m+h], radius=rad, fill=(15,23,42,240))
        d.text((x+w/2-(b[0]+b[2])/2, m+h/2-(b[1]+b[3])/2), c, font=font, fill=(255,255,255,255))
        x += w+gap
    sh = Image.new("RGBA", img.size, (0,0,0,0))
    sh.paste((15,23,42,150), (0, round(blur*0.8)), img.getchannel("A").filter(ImageFilter.GaussianBlur(blur)))
    img = Image.alpha_composite(sh, img)
    sp = _keycaps[text] = img.resize((img.width//aa, img.height//aa), Image.LANCZOS)
    return sp

def draw_keys(img, keys):
    text, age = keys[-1]                     # newest hint wins if two overlap
    a = min(1.0, age/5) * min(1.0, (KEY_N-age)/12)
    if a <= 0: return
    sp = key_sprite(text)
    if a < 1: sp = sp.copy(); sp.putalpha(sp.getchannel("A").point(lambda v: round(v*a)))
    rise = round((1-min(1.0, age/9))*12*PANEL_SCALE)   # eases up into place
    img.paste(sp, ((BG_W-sp.width)//2, BG_H-KEY_INSET*PANEL_SCALE-sp.height+rise), sp)

def clamp(v,a,b): return a if v<a else b if v>b else v
def focus_px(fr): return (fr["cx"]-clip["x"])*dsf, (fr["cy"]-clip["y"])*dsf

def place(want, span, bound):
    """Window origin on one axis: follow the focus, but never pull an edge inside the
    content area — so a settled z=1 lands back in exactly the classic framing."""
    lo, hi = sorted((MARGIN, bound-MARGIN-span))
    return clamp(want, lo, hi)

_cache = {}
def render(job):
    idx, zc, fx, fy, mx, my, pulses, keys = job
    src = _cache.get(idx)
    if src is None:
        _cache.clear(); src = _cache[idx] = Image.open(srcpath(idx)).convert("RGB")
    # the whole window scales with the zoom (frame, corners and shadow included) and
    # pans so the focus point sits at the centre; it bleeds off-frame when zoomed in.
    s = PANEL_W*zc/SW                                  # source px -> output px
    pw, ph = PANEL_W*zc, PANEL_H*zc
    ox, oy = place(BG_W/2-fx*s, pw, BG_W), place(BG_H/2-fy*s, ph, BG_H)
    x0, y0 = max(0, ceil(ox)), max(0, ceil(oy))        # visible slice of the window
    x1, y1 = min(BG_W, floor(ox+pw)), min(BG_H, floor(oy+ph))
    view = src.resize((x1-x0, y1-y0), Image.LANCZOS,
                      box=((x0-ox)/s, (y0-oy)/s, min(SW,(x1-ox)/s), min(SH,(y1-oy)/s)))
    if (mx is not None or pulses) and CURSOR_CSS_H > 0:
        size = max(8, round(CURSOR_CSS_H*dsf*s))
        view = view.convert("RGBA")
        for (cx, cy, age) in pulses:
            draw_pulse(view, ox+(cx-clip["x"])*dsf*s-x0, oy+(cy-clip["y"])*dsf*s-y0, age, size)
        if mx is not None:
            sp, pad = cursor_sprite(size)
            px = ox+(mx-clip["x"])*dsf*s-x0; py = oy+(my-clip["y"])*dsf*s-y0
            view.alpha_composite(sp, (round(px-TIP[0]/24*size)-pad, round(py-TIP[1]/24*size)-pad))
        view = view.convert("RGB")
    if (x1-x0, y1-y0) == (BG_W, BG_H):                 # window fills the frame
        out = view
    else:
        out = bg_base.copy()
        out.paste(DARK, (0,0), shadow(ox, oy, pw, ph, zc))
        m = Image.new("L",(x1-x0, y1-y0),0)
        ImageDraw.Draw(m).rounded_rectangle([ox-x0, oy-y0, ox+pw-x0, oy+ph-y0],
                                            radius=max(1,round(RAD*zc)), fill=255)
        out.paste(view, (x0,y0), m)
    if keys: draw_keys(out, keys)
    # near-lossless handoff to ffmpeg (4:4:4 q96); the x264 pass sets final quality
    b = io.BytesIO(); out.save(b, "JPEG", quality=96, subsampling=0)
    return b.getvalue()

def main():
    frames = meta["frames"]
    expanded = []
    for i, fr in enumerate(frames):
        expanded += [(i, fr)] * fr.get("repeat", 1)
    expanded += [(len(frames)-1, frames[-1])] * END_EXTRA

    by_entry, keys_by_entry = {}, {}
    for c in meta.get("clicks", []):
        by_entry.setdefault(c["i"], []).append((c["x"], c["y"]))
    for k in meta.get("keys", []):
        keys_by_entry.setdefault(k["i"], []).append(k["text"])

    # precompute the eased camera path; settled frames dedup to one render
    zc = frames[0]["z"]; fx, fy = focus_px(frames[0])
    plan, jobs, prev, active, shown, seen = [], [], None, [], [], set()
    for n, (idx, fr) in enumerate(expanded):
        if idx not in seen:
            seen.add(idx)
            active += [(x, y, n) for (x, y) in by_entry.get(idx, [])]
            shown += [(t, n) for t in keys_by_entry.get(idx, [])]
        pulses = tuple((x, y, n-s) for (x, y, s) in active if n-s < PULSE_N)
        keys = tuple((t, n-s) for (t, s) in shown if n-s < KEY_N)
        zc += (fr["z"]-zc)*ZOOM_EMA
        tfx, tfy = focus_px(fr); fx += (tfx-fx)*PAN_EMA; fy += (tfy-fy)*PAN_EMA
        mx, my = fr.get("mx"), fr.get("my")
        key = (idx, round(zc,4), round(fx,2), round(fy,2), mx, my, pulses, keys)
        if key == prev: plan.append(False)
        else: plan.append(True); jobs.append((idx, zc, fx, fy, mx, my, pulses, keys)); prev = key

    out = os.path.join(WORKDIR, "demo.mp4")
    log = open(os.path.join(WORKDIR, "ffmpeg.log"), "w")
    ff = subprocess.Popen(
        ["ffmpeg","-y","-f","image2pipe","-vcodec","mjpeg","-framerate",str(FPS),"-i","-",
         "-vf","scale=in_range=full:out_range=limited,format=yuv420p",
         "-c:v","libx264","-preset",PRESET,"-crf",str(CRF),
         "-colorspace","bt709","-color_primaries","bt709","-color_trc","bt709","-color_range","tv",
         "-r",str(FPS),"-movflags","+faststart",out],
        stdin=subprocess.PIPE, stdout=log, stderr=log)
    with Pool(WORKERS) as pool:
        it = pool.imap(render, jobs, chunksize=4)
        buf = None
        for n, fresh in enumerate(plan):
            if fresh: buf = next(it)
            ff.stdin.write(buf)
            if n % 60 == 0: print("frame", n, "/", len(plan))
    ff.stdin.close()
    if ff.wait() != 0: sys.exit(f"ffmpeg failed — see {WORKDIR}/ffmpeg.log")
    print(f"done {len(plan)} frames ({len(jobs)} rendered), {BG_W}x{BG_H} -> {out}")
    print(f"check: ffprobe -v error -select_streams v -show_entries "
          f"stream=width,height,r_frame_rate,pix_fmt -of csv {out}")

if __name__ == "__main__":
    main()
