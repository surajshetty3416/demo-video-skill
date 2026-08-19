// The popup starts/stops takes; recording always uses the drawn-cursor
// screencast mode and the editor opens itself when a take lands. Live phase
// comes from storage.session so it always reflects reality.

const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "http://127.0.0.1:8787";
let timer = null;

function status(text, err) {
  $("status").textContent = text || "";
  $("status").className = err ? "err" : "";
}

async function getSession() {
  return (await chrome.storage.session.get("session")).session || null;
}

async function render() {
  const s = await getSession();
  const btn = $("main");
  clearInterval(timer);
  btn.disabled = false;
  btn.className = "";
  const busy = s && ["starting", "recording", "uploading", "converting"].includes(s.phase);
  $("server").disabled = $("name").disabled = !!busy;
  if (s?.phase === "starting") {
    btn.textContent = "Starting…";
    btn.disabled = true;
  } else if (s?.phase === "recording") {
    btn.textContent = "Stop recording";
    btn.className = "rec";
    const tick = () => {
      const secs = Math.max(0, Math.round((Date.now() - s.t0) / 1000));
      status(`Recording ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`);
    };
    tick();
    timer = setInterval(tick, 500);
  } else if (s?.phase === "uploading" || s?.phase === "converting") {
    btn.textContent = s.phase === "uploading" ? "Saving…" : "Converting…";
    btn.disabled = true;
    status("");
  } else if (s?.phase === "error") {
    btn.textContent = "Start recording";
    status(s.error || "Recording failed", true);
  } else {
    btn.textContent = "Start recording";
    status("");
  }
}

async function start() {
  const server = ($("server").value.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
  const name = $("name").value.trim();
  await chrome.storage.local.set({ server });
  status("Checking server…");
  try {
    await fetch(server + "/api/segments");
  } catch {
    return status(`Can't reach ${server} — is the editor server running?`, true);
  }
  const r = await chrome.runtime.sendMessage({ cmd: "start", server, name, mode: "frames" });
  if (r?.error) return status(r.error, true);
  window.close();
}

$("main").addEventListener("click", async () => {
  const s = await getSession();
  if (s?.phase === "recording") {
    $("main").disabled = true;
    await chrome.runtime.sendMessage({ cmd: "stop" });
  } else {
    start();
  }
});

chrome.storage.session.onChanged.addListener(render);

(async () => {
  const { server } = await chrome.storage.local.get("server");
  $("server").value = server || DEFAULT_SERVER;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.title) $("name").value = tab.title;
  render();
})();
