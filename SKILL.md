---
name: demo-video
description: Produce a polished, ScreenStudio-style 60fps product demo video of a web app with a tiny, dependency-light pipeline — Playwright frame capture + a multiprocess Pillow compositor streaming into ffmpeg (no Node/Remotion). Drives the app one step per frame so playback is true 60fps regardless of capture speed, then renders a gradient background, rounded panel + shadow, a crisp vector cursor, and smooth cinematic zoom/pan that holds steady during the action and eases out at the end; HD=1 re-renders the same capture at retina resolution. Use whenever asked to create/record/improve a demo video, walkthrough, feature showcase, or screencast of a web UI.
---

# Demo video (deterministic frames → Pillow compositor → ffmpeg)

A lightweight, reproducible way to make a **crisp 60fps ScreenStudio-style** demo of a
web app. Two stages, all code, only Python + Pillow + ffmpeg:

```
capture_template.py  →  frames/f*.jpg  +  meta.json   (Playwright: 1 step per frame + camera/mouse timeline)
        │
compositor.py        →  demo.mp4                       (multiprocess Pillow render — bg + rounded panel +
                                                        shadow + crisp vector cursor + zoom/pan — streamed
                                                        straight into ffmpeg; 60fps H.264, bt709)
```

The compositor renders with a worker pool and pipes frames directly into one ffmpeg
process (no intermediate PNGs, no second pass). Default output is the classic panel
size; `HD=1 python compositor.py …` re-renders the SAME capture at retina resolution
(uses all pixels of a DSF=2 capture) when a crisper deliverable is worth ~3x the
composite time.

## Step 0: ask the user for the inputs — don't go discover them

The capture needs facts only the user reliably knows. Hunting for them (grepping configs
for dev-server URLs, guessing test credentials, probing routes) burns time and tokens and
often lands on the wrong instance. Before writing any code, ask for whatever is missing
from this list, in ONE batch:

1. **Target URL** — the running app / dev server to record (e.g. `http://myapp.localhost:8000`),
   and the specific page or route the demo starts on.
2. **Login** — credentials for a throwaway/test account, or an existing authenticated
   session/storage state, or "no login needed".
3. **What to show** — the feature/flow and the beats that matter (what must the viewer see?).
4. **Fixture policy** — is it OK to create and delete throwaway records via the app's
   API/UI on this instance? (Never demo against data the user cares about.)
5. **Output** — where to put the mp4, and whether they want the retina `HD=1` render.

Skip questions already answered by the request, project memory, or an obvious fixture
(e.g. a self-contained HTML page needs neither URL nor login). If the user gives a
production URL, confirm before creating any data on it.

## The core idea: deterministic frames = real 60fps

Do **not** rely on real-time screen recording or Playwright's built-in video (framerate
is machine-dependent and usually <60fps). Instead the capture script drives the UI **one
small step per frame and screenshots each frame**. Capture can take a minute of
wall-clock; playback is still a perfect 60fps because the frames are assembled at a fixed
rate. Motion smoothness is a function of *step size*, not capture speed.

Two kinds of pause, and picking the right one is both a speed and a correctness call:
**`still(n)`** takes ONE screenshot that stands for n frames (`repeat` in meta.json) — use
it whenever the page is static and only the virtual camera is settling or lingering; it
cuts capture time dramatically since settles/lingers dominate a storyline. **`hold(n)`**
captures n live frames — required whenever the APP itself is animating (post-click
transitions, drop animations, spinners), or the animation would freeze in the video.

## The camera lives in the compositor, not the app

The capture records a **focus point + zoom per frame** into `meta.json`; the compositor
crops+scales the recorded pixels to that virtual camera and eases toward it (EMA). So
**re-framing / re-pacing / re-zooming is a compositor re-run, not a re-shoot** — you almost
never need to re-capture just to change the camera. Never zoom the app's own canvas
(`Ctrl+=`/wheel); it's fragile and forces re-captures.

## Cinematography principles (the parts that took iteration to get right)

1. **Decouple the camera from the cursor.** Panning to follow the pointer looks *erratic*.
   Set `cam(z, focus)` to a **stable region** and leave it; the action moves, not the camera.
2. **Zoom in ONCE per shot, then hold steady through the action.** Use `fit_zoom([...])` to
   frame the working area, zoom to it, and don't touch the camera during the drags/clicks.
3. **Don't over-zoom.** Tight zoom loses context, feels claustrophobic, and blurs (see
   headroom below). Keep surrounding UI visible: a hold-zoom around **~1.5–1.9×** on a
   working region usually reads best. `fit_zoom(..., hi=1.75)` caps it. When in doubt, zoom *less*.
4. **Move the camera between shots, but let it SETTLE.** After `cam(z, focus)` add a short
   `hold(~20)` so the EMA reaches the new framing before the action starts. With slow easing
   and many shots the camera lags forever — `ZOOM_EMA≈0.11 / PAN_EMA≈0.13` reach targets
   within a ~20-frame hold while staying smooth.
5. **Close with a zoom-out + linger, never a hard cut.** End with `cam(1.0, FOCUS)` then a
   hold; the compositor's `END_EXTRA` renders extra tail frames on the final still so the
   closing zoom fully settles and holds a beat.
6. **Slow enough to read.** Drags ~1.2–1.5s (`move_to(..., ~72)`), a beat before/after each
   action, longer holds on the moment that matters (e.g. an indicator you want seen).
7. **Capture the COMPLETE interface** (full viewport) so it reads as "the real app"; the
   camera zooms into the action while keeping editor chrome visible for context.

## Determinism: seed and clean up your own fixture

A run that mutates shared state (autosaved drafts, existing docs) drifts between takes. The
reliable pattern for app demos: **create a throwaway fixture via the app's API in a `try`,
point `START_URL` at it, and delete it in `finally`.** Same input → identical frames → the
compositor is a pure function of the capture.

## The multi-case "tile" pattern (showcasing several behaviors)

To demo N related behaviors in one video, build ONE fixture page laid out as a grid of
labeled **tiles**, each a minimal example of one case, sized so they ALL fit in the
viewport — the compositor can only zoom into pixels that were captured, so off-screen
content can't be revealed. Then one **beat per tile**: `frame_tile(sel)` → `hold` to settle
→ perform the real interaction → `hold`, then move on. Give each tile a text label so the
case is self-explanatory, and linger on the finale. `example-multicase.py` is a complete
working instance (a canvas block-reorder demo: 5 layout tiles + a center-drop finale).

## Gotchas learned the hard way

- **Drag-and-drop: read destination coords LIVE, after pickup.** Picking a block up can
  reflow siblings, so coords read *before* `mouse.down()` may miss. Read the target's
  `bounding_box()` *after* the drag starts (always safe).
- **Cross the drag threshold explicitly.** Most engines need a few px of movement after
  `mouse.down()` before a drag "starts" — nudge (`move_to(x+9, y, 6)`) before moving to the
  target, or the press is treated as a click.
- **One element per breakpoint.** If the app renders multiple responsive canvases, select
  the element for the breakpoint you mean (`[data-block-id="X"][data-breakpoint="desktop"]`);
  the same block exists once per visible canvas.
- **Zoom headroom = capture resolution.** To zoom to `z` and stay sharp, the source crop
  (≈ `viewport*dsf / z`) must be ≥ the panel width. Get more pixels via a bigger `VIEWPORT`
  or higher `DSF` (2 = crisp) — not by upscaling in the compositor, and not by over-zooming.
- **The cursor is drawn by the compositor, not the page.** Capture records `mx,my` per
  frame; the compositor composites a vector arrow at final resolution, so it stays crisp
  at any zoom (a DOM-injected cursor blurs when the camera zooms — don't reintroduce one).
- **still() vs hold() is a correctness call**: a `still()` during an app animation freezes
  it in the video. When unsure whether something is still animating, use `hold()`.
- **ffprobe the output** — the compositor prints the exact check line; confirm
  `r_frame_rate=60/1`. Colors are tagged bt709/limited-range explicitly so players don't
  wash them out. JPEG source (`quality≈92`) keeps ~1000-frame captures fast; the final
  H.264 pass (`crf 18`) is what matters for quality.

## Steps

0. **Gather inputs** (Step 0 above): target URL, login, flow, fixture policy, output prefs —
   ask the user in one batch rather than discovering them.
1. **Copy the scripts** next to a scratch workdir: `capture_template.py`, `compositor.py`
   (and `example-multicase.py` if doing a tile demo).
2. **Edit `capture_template.py` CONFIG** — `BASE`, `START_URL`, optional `LOGIN`, `VIEWPORT`
   (bigger = more zoom headroom), `DSF` (2). For app demos, seed a fixture (see above).
3. **Write the STORYLINE** with the harness verbs (below), pointing at a **live dev server**.
4. **Capture:** `VIDEO_DIR=/abs/workdir python capture_template.py` (long captures: run in the
   background, poll `frames/` count).
5. **Composite + encode:** `python compositor.py /abs/workdir` → `demo.mp4` directly
   (multiprocess render streamed into ffmpeg; `HD=1` for retina output on demand). To
   re-frame/re-zoom without re-capturing, edit the `z` values in `meta.json` (or the
   compositor knobs) and re-run this step only.
6. **Verify:** run the ffprobe line the compositor prints (`r_frame_rate=60/1`) and
   spot-check a zoomed frame + the last frame (extract with `ffmpeg -ss … -frames:v 1`).

## Harness verbs (in `capture_template.py`)

- `cap()` — screenshot the current frame + log camera/mouse state.
- `hold(n)` — n LIVE frames (app animating). `still(n)` — n frames from ONE screenshot
  (page static: camera settles, lingers, endings) — much faster to capture.
- `cam(z, (fx,fy))` — set the camera **target** (zoom + focus in page px); compositor eases to it.
- `move_to(x, y, n)` — ease the mouse to (x,y) over n captured frames (the main "action" verb).
  `jump(x,y)` — teleport without capturing.
- `center(sel)` / `box(sel)` — element center / bounding box (Playwright selector).
- `fit_zoom([box,...], margin_px, lo, hi)` → `(zoom, focus)` framing those elements (cap `hi`
  to avoid over-zoom).
- Real actions use raw Playwright between frames: `pg.mouse.down()/up()/click()`,
  `pg.keyboard.press(...)`, `pg.locator(...)`.

## Tuning knobs (top of `compositor.py`)

- `HD=1` env (or `PANEL_SCALE=2`) — retina output: 2x panel from the DSF=2 capture pixels.
  Default (scale 1) is the classic size and composites ~3x faster; same capture serves both.
- `PANEL_BASE_W`, `MARGIN`, `RAD` — panel size, background border, corner radius (the
  latter two auto-scale with `PANEL_SCALE`).
- `GRAD` — background gradient stops (soft indigo→violet default; swap for brand/dark).
- `ZOOM_EMA` / `PAN_EMA` — camera easing (0.11 / 0.13: reaches per-shot framing within a short
  hold; lower = gentler but laggier).
- `END_EXTRA` — tail frames so the closing zoom-out settles + lingers.
- `CRF` / `PRESET` — libx264 quality/speed (18 / fast). `WORKERS` — render pool size.
- `CURSOR_CSS_H` — drawn cursor size in page px (26 matches the old baked cursor).
