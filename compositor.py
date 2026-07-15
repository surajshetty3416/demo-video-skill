#!/usr/bin/env python3
"""Generic ScreenStudio-style compositor: clean captured frames + a camera
timeline -> polished demo.mp4 (gradient background, rounded panel, soft shadow,
vector cursor, smooth zoom/pan, extended ending). Pure Pillow + ffmpeg.

Renders with a worker pool and streams frames straight into one ffmpeg process:
no intermediate frames_out/ PNGs and no second encode pass. Identical still
frames (settled camera) are rendered once and repeated.

Input  (in WORKDIR):  meta.json  +  frames/f00000.jpg ...   (see capture_template.py)
Output (in WORKDIR):  demo.mp4   (+ ffmpeg.log)

meta.json = {"dsf":2, "fps":60, "clip":{"x","y","width","height"},
             "frames":[{"cx","cy","z", "mx"?,"my"?, "repeat"?}, ...],
             "clicks":[{"i","x","y"}, ...]?}   # frame index + position of each click;
                                               # an indigo pulse ring animates there
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
from multiprocessing import Pool
from PIL import Image, ImageDraw, ImageFilter

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
CURSOR_CSS_H = 34         # cursor height in page CSS px (enlarged for legibility)
PULSE_N = 18              # frames a click pulse ring lives (~0.3s)
PULSE_COLOR = (99,102,241)
CRF, PRESET = 18, "fast"  # libx264 quality/speed
WORKERS = max(2, (os.cpu_count() or 8) - 2)
# ---------------------------------------------------------------------------

WORKDIR = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("VIDEO_DIR", os.getcwd())
FR = os.path.join(WORKDIR, "frames")

meta = json.load(open(os.path.join(WORKDIR, "meta.json")))
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

# background (gradient + central lift + baked panel shadow), built small and
# upscaled — everything here is soft, so 1/8 scale is visually identical
def build_bg(ss=8):
    w, h = BG_W//ss, BG_H//ss
    bg = Image.new("RGB",(w,h)); px = bg.load(); diag = w+h
    for y in range(h):
        for x in range(w): px[x,y] = grad((x+y)/diag)
    vig = Image.new("L",(w,h),0)
    ImageDraw.Draw(vig).ellipse([-w*0.25,-h*0.25,w*1.25,h*1.25], fill=40)
    bg = Image.composite(Image.new("RGB",(w,h),(255,255,255)), bg,
                         vig.filter(ImageFilter.GaussianBlur(120//ss)))
    sh = Image.new("L",(w,h),0)
    off = 10*PANEL_SCALE//ss
    ImageDraw.Draw(sh).rounded_rectangle([MARGIN//ss, MARGIN//ss+off,
        (MARGIN+PANEL_W)//ss, (MARGIN+PANEL_H)//ss+off], radius=max(2,RAD//ss), fill=120)
    bg.paste(Image.new("RGB",(w,h),(15,23,42)), (0,0),
             sh.filter(ImageFilter.GaussianBlur(34*PANEL_SCALE//ss)))
    return bg.resize((BG_W,BG_H), Image.BILINEAR)

bg_base = build_bg()
mask = Image.new("L",(PANEL_W,PANEL_H),0)
ImageDraw.Draw(mask).rounded_rectangle([0,0,PANEL_W,PANEL_H], radius=RAD, fill=255)

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
    r = size*(0.55 + 1.7*(1-(1-t)**2)); a = round(170*(1-t))
    if a <= 0 or r < 2: return
    aa = 4; R = round(r*aa); w = max(aa, round(size*0.1*aa*(1-0.4*t))); D = 2*R+2*w
    ring = Image.new("RGBA",(D,D),(0,0,0,0))
    ImageDraw.Draw(ring).ellipse([w//2,w//2,D-w//2,D-w//2], outline=PULSE_COLOR+(a,), width=w)
    ring = ring.resize((D//aa,D//aa), Image.LANCZOS)
    img.alpha_composite(ring, (round(x-ring.width/2), round(y-ring.height/2)))

def clamp(v,a,b): return a if v<a else b if v>b else v
def focus_px(fr): return (fr["cx"]-clip["x"])*dsf, (fr["cy"]-clip["y"])*dsf

_cache = {}
def render(job):
    idx, zc, fx, fy, mx, my, pulses = job
    src = _cache.get(idx)
    if src is None:
        _cache.clear(); src = _cache[idx] = Image.open(srcpath(idx)).convert("RGB")
    cw, ch = SW/zc, SH/zc
    left = clamp(fx-cw/2, 0, SW-cw); top = clamp(fy-ch/2, 0, SH-ch)
    crop = src.crop((round(left),round(top),round(left+cw),round(top+ch))).resize((PANEL_W,PANEL_H), Image.LANCZOS)
    if mx is not None or pulses:
        scale = PANEL_W/cw
        size = max(8, round(CURSOR_CSS_H*dsf*scale))
        crop = crop.convert("RGBA")
        for (cx, cy, age) in pulses:
            draw_pulse(crop, ((cx-clip["x"])*dsf-left)*scale, ((cy-clip["y"])*dsf-top)*scale, age, size)
        if mx is not None:
            sp, pad = cursor_sprite(size)
            px = ((mx-clip["x"])*dsf-left)*scale; py = ((my-clip["y"])*dsf-top)*scale
            crop.alpha_composite(sp, (round(px-TIP[0]/24*size)-pad, round(py-TIP[1]/24*size)-pad))
        crop = crop.convert("RGB")
    out = bg_base.copy(); out.paste(crop, (MARGIN,MARGIN), mask)
    # near-lossless handoff to ffmpeg (4:4:4 q96); the x264 pass sets final quality
    b = io.BytesIO(); out.save(b, "JPEG", quality=96, subsampling=0)
    return b.getvalue()

def main():
    frames = meta["frames"]
    expanded = []
    for i, fr in enumerate(frames):
        expanded += [(i, fr)] * fr.get("repeat", 1)
    expanded += [(len(frames)-1, frames[-1])] * END_EXTRA

    by_entry = {}
    for c in meta.get("clicks", []):
        by_entry.setdefault(c["i"], []).append((c["x"], c["y"]))

    # precompute the eased camera path; settled frames dedup to one render
    zc = frames[0]["z"]; fx, fy = focus_px(frames[0])
    plan, jobs, prev, active, seen = [], [], None, [], set()
    for n, (idx, fr) in enumerate(expanded):
        if idx not in seen:
            seen.add(idx)
            active += [(x, y, n) for (x, y) in by_entry.get(idx, [])]
        pulses = tuple((x, y, n-s) for (x, y, s) in active if n-s < PULSE_N)
        zc += (fr["z"]-zc)*ZOOM_EMA
        tfx, tfy = focus_px(fr); fx += (tfx-fx)*PAN_EMA; fy += (tfy-fy)*PAN_EMA
        mx, my = fr.get("mx"), fr.get("my")
        key = (idx, round(zc,4), round(fx,2), round(fy,2), mx, my, pulses)
        if key == prev: plan.append(False)
        else: plan.append(True); jobs.append((idx, zc, fx, fy, mx, my, pulses)); prev = key

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
            if n % 240 == 0: print("frame", n, "/", len(plan))
    ff.stdin.close()
    if ff.wait() != 0: sys.exit(f"ffmpeg failed — see {WORKDIR}/ffmpeg.log")
    print(f"done {len(plan)} frames ({len(jobs)} rendered), {BG_W}x{BG_H} -> {out}")
    print(f"check: ffprobe -v error -select_streams v -show_entries "
          f"stream=width,height,r_frame_rate,pix_fmt -of csv {out}")

if __name__ == "__main__":
    main()
