# Demo Video Recorder (Chrome extension)

Record the current tab by hand and land it straight in the demo-video editor as
a normal segment: tab pixels plus an injected logger that stamps pointer moves,
clicks and shortcut presses. `ingest.py` converts the pair into the same
`frames/ + meta.json` bundle the Playwright capture produces, so the compositor
and editor need no changes — the recording gets the gradient/window/pulse
treatment plus an auto-framed camera derived from your clicks, and every shot
stays editable (zooms, focus, speed, trims) in the editor afterwards.

Capture goes through CDP screencast (`chrome.debugger`), whose pixels carry NO
cursor; the compositor draws its crisp vector cursor from the event log, so
cursor size/visibility stay editable (cursor-hide ranges work). Chrome shows a
"started debugging this browser" banner while recording — expected; dismissing
it stops the take (what already streamed is salvaged). Keep the tab focused: a
backgrounded tab stops producing frames. (A `tabCapture` webm path with the
baked OS cursor still exists in the code — `mode: "baked"` — but has no UI.)

While recording, a small always-on-top **REC pill** floats at the bottom right
of the screen (spawned by the editor server, `editor/recpill.py`): pulsing dot,
elapsed time, Stop button. It is a separate OS window, so it stays visible over
Chrome yet never appears in the recording — drag it anywhere. When a take
lands, the editor opens in a new tab automatically.

## Install (once)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick
   this `extension/` directory (symlinked at `~/Desktop/demo-recorder-extension`).
2. Pin "Demo Recorder" to the toolbar.

## Record

1. Start the editor server on a workdir (empty is fine) with a pinned port so
   the extension's default server URL just works:

   ```
   python3 editor/server.py --detach --port 8787 ~/demos/takes
   ```

2. Open the tab you want to record, click the extension icon, hit **Record**
   (the popup health-checks the server first — there is nothing to fill in;
   the take is named after the tab). The popup closes; the REC pill and
   toolbar badge appear.
3. Do the demo in the tab. **Pause/Resume** from the popup skips the paused
   stretch entirely — ingest excises the interval, so it never appears in the
   video.
4. Click **Stop** on the pill (or the popup). Frames streamed during
   recording, so saving is nearly instant; the segment appears in the editor
   rail and the editor opens in a new tab.

The server URL defaults to `http://127.0.0.1:8787`; to point elsewhere set it
once from the extension's service-worker console:
`chrome.storage.local.set({server: "http://127.0.0.1:9999"})`.

Then direct it in the editor: the click-cluster auto-framing gives a first
pass — reshape, split or flatten the camera blocks, speed up dead air, trim
the ends, hide the cursor where it distracts.

## What carries over vs. the scripted path

- Drawn mode gets the full treatment: crisp vector cursor at any zoom, click
  pulses, keycap hints, cursor-hide ranges.
- Static stretches collapse into `repeat` entries at ingest (the `still()`
  economy — screencast sends no frames while the page is idle, so stills are
  nearly free); identical frames hardlink to one file.
- Real-time capture can drop frames on a slow machine — the deterministic
  Playwright path remains the tool for perfectly repeatable showcases.

## Notes

- The recording is the tab's content only (no browser chrome) — that's what
  the compositor's synthetic window wraps. Don't resize the window mid-take.
- Retina displays record at devicePixelRatio 2, which is the DSF=2 zoom
  headroom the compositor wants.
- Pointer events inside cross-origin iframes can't be logged (the cursor
  holds its last position there); same-origin iframes are translated to
  top-viewport coordinates automatically.
- `<all_urls>` host access lets the logger re-inject itself across in-tab
  navigations and lets streaming reach the local server; the `debugger`
  permission powers drawn-mode capture. The extension only ever acts while
  you're recording.
