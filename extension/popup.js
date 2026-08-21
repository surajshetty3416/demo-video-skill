// Orthodox transport controls: record, pause/resume, stop. Nothing to fill in;
// the server (stored URL or the default) is health-checked on open and status
// text only appears when something needs attention (or the timer, while
// recording). The take is named after the tab.

const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "http://127.0.0.1:8787";
let timer = null, server = DEFAULT_SERVER, serverOk = true;

function status(text, err) {
  $("status").textContent = text || "";
  $("status").className = err ? "err" : "";
}

async function getSession() {
  return (await chrome.storage.session.get("session")).session || null;
}

function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function show(rec, pause, stop) {
  $("rec").hidden = !rec;
  $("pause").hidden = !pause;
  $("stop").hidden = !stop;
}

async function render() {
  const s = await getSession();
  clearInterval(timer);
  $("rec").disabled = $("stop").disabled = false;
  const phase = s?.phase;
  if (phase === "starting") {
    show(true, false, false);
    $("rec").disabled = true;
    status("Starting…");
  } else if (phase === "recording" || phase === "paused") {
    show(false, true, true);
    const paused = phase === "paused";
    $("icoPause").toggleAttribute("hidden", paused);   // SVG has no .hidden property
    $("icoPlay").toggleAttribute("hidden", !paused);
    $("pause").title = paused ? "Resume" : "Pause";
    const tick = () => {
      const now = Date.now();
      const pausing = paused ? now - s.pauseStart : 0;
      status(`${paused ? "Paused" : "Recording"} ${fmt(now - s.t0 - (s.pausedMs || 0) - pausing)}`);
    };
    tick();
    if (!paused) timer = setInterval(tick, 500);
  } else if (phase === "uploading" || phase === "converting") {
    show(false, false, true);
    $("stop").disabled = true;
    status(phase === "uploading" ? "Saving…" : "Converting…");
  } else if (phase === "error") {
    show(true, false, false);
    status(s.error || "Recording failed", true);
  } else {
    show(true, false, false);
    $("rec").disabled = !serverOk;
    status(serverOk ? "" : `Server not running at ${server.replace(/^https?:\/\//, "")}`, true);
  }
}

async function checkServer() {
  const { server: stored } = await chrome.storage.local.get("server");
  server = (stored || DEFAULT_SERVER).replace(/\/+$/, "");
  try {
    await fetch(server + "/api/segments");
    serverOk = true;
  } catch {
    serverOk = false;
  }
  const s = await getSession();
  if (!s || !["starting", "recording", "paused", "uploading", "converting"].includes(s.phase))
    render();
}

$("rec").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ cmd: "start", server, name: "", mode: "frames" });
  if (r?.error) return status(r.error, true);
  window.close();
});

$("pause").addEventListener("click", async () => {
  const s = await getSession();
  await chrome.runtime.sendMessage({ cmd: s?.phase === "paused" ? "resume" : "pause" });
});

$("stop").addEventListener("click", async () => {
  $("stop").disabled = true;
  await chrome.runtime.sendMessage({ cmd: "stop" });
});

chrome.storage.session.onChanged.addListener(render);

render();
checkServer();
