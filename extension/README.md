# Demo Video Recorder (Chrome extension)

Record the current tab by hand and land it straight in the demo-video editor as
a normal segment: tab pixels plus an injected logger that stamps pointer moves,
clicks and shortcut presses. `ingest.py` converts the pair into the same
`frames/ + meta.json` bundle the Playwright capture produces, so the compositor
and editor need no changes — the recording gets the gradient/window/pulse
treatment plus an auto-framed camera derived from your clicks, and every shot
stays editable (zooms, focus, speed, trims) in the editor afterwards.

Two cursor modes (popup toggle):

- **Drawn (default)** — captures via CDP screencast (`chrome.debugger`), whose
  pixels carry NO cursor; the compositor draws its crisp vector cursor from
  the event log, so cursor size/visibility stay editable (cursor-hide ranges
  work). Chrome shows a "started debugging this browser" banner while
  recording — expected; dismissing it stops the take (what already streamed
  is salvaged). Keep the tab focused: a backgrounded tab stops producing
  frames.
- **As recorded** — captures via `tabCapture` + MediaRecorder. Chrome bakes
  the OS cursor into those pixels, so what you see is what you get (no
  overlay is drawn; it would double). Use when the debugger banner is
  unacceptable.

While recording, a small floating **REC pill** (its own tiny window, bottom
right of the browser window) shows a pulsing dot + elapsed time and stops the
take on click. It is a separate window, so it never appears in the recording —
drag it anywhere.

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

2. Open the tab you want to record, click the extension icon, check the server
   URL, take name and cursor mode, hit **Start recording**. The popup closes;
   the REC pill and toolbar badge appear.
3. Do the demo in the tab.
4. Click **Stop** on the pill (or the toolbar icon → Stop). In drawn mode
   frames streamed during recording, so saving is nearly instant; the segment
   appears in the editor rail (a fresh editor tab opens if "Open editor when
   done" is checked).

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
