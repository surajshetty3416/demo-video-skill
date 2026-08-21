// One-button recorder: Record / Pause / Stop, nothing to fill in. The server
// is the stored URL or the default and is health-checked on open; the take
// name comes from the tab title. Live phase comes from storage.session.

const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "http://127.0.0.1:8787";
let timer = null, server = DEFAULT_SERVER, serverOk = false;

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

async function render() {
  const s = await getSession();
  clearInterval(timer);
  const main = $("main"), pause = $("pause");
  pause.hidden = true;
  main.disabled = false;
  const phase = s?.phase;
  if (phase === "starting") {
    main.textContent = "Starting…";
    main.disabled = true;
  } else if (phase === "recording" || phase === "paused") {
    pause.hidden = false;
    pause.textContent = phase === "paused" ? "Resume" : "Pause";
    main.textContent = "Stop";
    const tick = () => {
      const now = Date.now();
      const pausing = phase === "paused" ? now - s.pauseStart : 0;
      const label = phase === "paused" ? "Paused" : "Recording";
      status(`${label} ${fmt(now - s.t0 - (s.pausedMs || 0) - pausing)}`);
    };
    tick();
    timer = setInterval(tick, 500);
  } else if (phase === "uploading" || phase === "converting") {
    main.textContent = phase === "uploading" ? "Saving…" : "Converting…";
    main.disabled = true;
    status("");
  } else if (phase === "error") {
    main.textContent = "Record";
    status(s.error || "Recording failed", true);
  } else {
    main.textContent = "Record";
    main.disabled = !serverOk;
    status(serverOk ? "Server connected"
                    : `Server not running at ${server.replace(/^https?:\/\//, "")}`, !serverOk);
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

$("main").addEventListener("click", async () => {
  const s = await getSession();
  if (s && ["recording", "paused"].includes(s.phase)) {
    $("main").disabled = true;
    await chrome.runtime.sendMessage({ cmd: "stop" });
  } else {
    const r = await chrome.runtime.sendMessage({ cmd: "start", server, name: "", mode: "frames" });
    if (r?.error) return status(r.error, true);
    window.close();
  }
});

$("pause").addEventListener("click", async () => {
  const s = await getSession();
  await chrome.runtime.sendMessage({ cmd: s?.phase === "paused" ? "resume" : "pause" });
});

chrome.storage.session.onChanged.addListener(render);

render();
checkServer();
