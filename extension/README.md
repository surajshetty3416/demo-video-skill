# Demo Video Recorder (Chrome extension)

Record the current tab by hand and land it straight in the demo-video editor as
a normal segment: tab pixels via `tabCapture`, plus an injected logger that
stamps pointer moves, clicks and shortcut presses. `ingest.py` converts the
pair into the same `frames/ + meta.json` bundle the Playwright capture
produces, so the compositor and editor need no changes — the recording gets
the gradient/window/pulse treatment plus an auto-framed camera derived from
your clicks, and every shot stays editable (zooms, focus, speed, trims) in the
editor afterwards.

## Install (once)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick
   this `extension/` directory.
2. Pin "Demo Recorder" to the toolbar.

## Record

1. Start the editor server on a workdir (empty is fine) with a pinned port so
   the extension's default server URL just works:

   ```
   python3 editor/server.py --detach --port 8787 ~/demos/takes
   ```

2. Open the tab you want to record, click the extension icon, check the server
   URL and take name, hit **Start recording**. The popup closes; the toolbar
   badge shows REC.
3. Do the demo in the tab.
4. Click the icon again → **Stop recording**. The extension uploads the webm +
   event log, the server converts it, and the segment appears in the editor
   rail (a fresh editor tab opens if "Open editor when done" is checked).

Then frame it in the editor: split camera blocks, set focus/zoom per shot,
speed up dead air, trim the ends — same workflow as a scripted capture.

## What carries over vs. the scripted path

- Chrome bakes the OS cursor into tab capture, so the recorded cursor is the
  one viewers see (no overlay is drawn — it would double). Clicks pulse and
  modifier shortcuts show keycaps automatically, from the event log.
- The camera comes out pre-framed from your clicks: one steady shot per click
  cluster, wide otherwise — reshape, split or flatten the blocks in the editor.
- Static stretches collapse into `repeat` entries at ingest (the `still()`
  economy, recovered after the fact); identical frames hardlink to one file.
- Real-time capture can drop frames on a slow machine — the deterministic
  Playwright path remains the tool for perfectly repeatable showcases.

## Notes

- The recording is the tab's content only (no browser chrome) — that's what
  the compositor's synthetic window wraps. Don't resize the window mid-take.
- Retina displays record at devicePixelRatio 2, which is the DSF=2 zoom
  headroom the compositor wants.
- Pointer events inside cross-origin iframes can't be logged (the cursor
  holds its last known position there); same-origin iframes are translated
  to top-viewport coordinates automatically.
- `<all_urls>` host access is what lets the logger re-inject itself across
  in-tab navigations and lets the upload reach the local server; the
  extension only ever acts while you're recording.
