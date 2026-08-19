// Injected into every frame of the recorded tab. Logs pointer moves, clicks
// and shortcut presses with wall-clock ms to the offscreen recorder; coords
// translate to top-viewport space by walking same-origin frame offsets, and
// frames whose offset can't be known (cross-origin ancestors) stay silent.
(() => {
  if (window.__demoRecLog) return;
  const G = { Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←",
              ArrowRight: "→", " ": "Space" };
  let buf = [], last = 0, off = { x: 0, y: 0 }, offOk = true;

  function measure() {
    let x = 0, y = 0, w = window;
    try {
      while (w !== w.parent) {
        const fe = w.frameElement;
        if (!fe) { offOk = false; return; }
        const r = fe.getBoundingClientRect();
        x += r.left; y += r.top; w = w.parent;
      }
    } catch { offOk = false; return; }
    off = { x, y }; offOk = true;
  }

  function flush() {
    if (buf.length) {
      try { chrome.runtime.sendMessage({ cmd: "events", batch: buf.splice(0) }); } catch {}
    }
    measure(); // refresh the frame offset between batches (parent may scroll)
  }

  const move = (e) => {
    const t = Date.now();
    if (t - last < 16 || !offOk) return;
    last = t;
    buf.push({ t, k: "m", x: e.clientX + off.x, y: e.clientY + off.y });
  };
  const down = (e) => {
    if (!offOk) return;
    buf.push({ t: Date.now(), k: "c", x: e.clientX + off.x, y: e.clientY + off.y });
  };
  const key = (e) => {
    if (!e.metaKey && !e.ctrlKey && !e.altKey) return;
    if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
    const mods = [e.metaKey && "⌘", e.ctrlKey && "⌃", e.altKey && "⌥", e.shiftKey && "⇧"]
      .filter(Boolean);
    const k = G[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    buf.push({ t: Date.now(), k: "k", text: [...mods, k].join("+") });
  };

  measure();
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mousedown", down, true);
  window.addEventListener("keydown", key, true);
  const iv = setInterval(flush, 500);

  window.__demoRecLog = () => {
    clearInterval(iv);
    flush();
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mousedown", down, true);
    window.removeEventListener("keydown", key, true);
    delete window.__demoRecLog;
  };
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.cmd === "logger-stop" && window.__demoRecLog) window.__demoRecLog();
  });
})();
