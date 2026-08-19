// The popup owns the user gesture: it mints the tabCapture streamId and hands
// it to the service worker, then closes. Reopen it to stop; live phase comes
// from storage.session so it always reflects reality.

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
  if (!s || s.phase === "idle") {
    btn.textContent = "Start recording";
    status("");
  } else if (s.phase === "starting") {
    btn.textContent = "Starting…";
    btn.disabled = true;
  } else if (s.phase === "recording") {
    btn.textContent = "Stop recording";
    btn.className = "rec";
    const tick = () => {
      const secs = Math.max(0, Math.round((Date.now() - s.t0) / 1000));
      status(`Recording ${String(Math.floor(secs / 60))}:${String(secs % 60).padStart(2, "0")}`);
    };
    tick();
    timer = setInterval(tick, 500);
  } else if (s.phase === "uploading" || s.phase === "converting") {
    btn.textContent = s.phase === "uploading" ? "Uploading…" : "Converting…";
    btn.disabled = true;
  } else if (s.phase === "done") {
    btn.textContent = "Start recording";
    $("status").innerHTML = "";
    const a = document.createElement("a");
    a.href = s.server; a.target = "_blank"; a.textContent = "open editor";
    $("status").append(`Saved as ${s.segment} — `, a);
    $("status").className = "";
  } else if (s.phase === "error") {
    btn.textContent = "Start recording";
    status(s.error || "Recording failed", true);
  }
}

async function start() {
  const server = ($("server").value.trim() || DEFAULT_SERVER).replace(/\/+$/, "");
  const name = $("name").value.trim();
  const mode = document.querySelector("input[name=mode]:checked").value;
  await chrome.storage.local.set({ server, openEditor: $("open").checked, cursorMode: mode });
  status("Checking server…");
  try {
    await fetch(server + "/api/segments");
  } catch {
    return status(`Can't reach ${server} — is the editor server running?`, true);
  }
  let streamId = null;
  if (mode === "baked") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (e) {
      return status("Tab capture refused: " + (e?.message || e), true);
    }
  }
  const r = await chrome.runtime.sendMessage({ cmd: "start", streamId, server, name, mode });
  if (r?.error) return status(r.error, true);
  window.close();
}

async function stop() {
  $("main").disabled = true;
  await chrome.runtime.sendMessage({ cmd: "stop" });
}

$("main").addEventListener("click", async () => {
  const s = await getSession();
  if (s?.phase === "recording") stop();
  else start();
});

chrome.storage.session.onChanged.addListener(render);

(async () => {
  const { server, openEditor = true, cursorMode = "frames" } =
    await chrome.storage.local.get(["server", "openEditor", "cursorMode"]);
  $("server").value = server || DEFAULT_SERVER;
  $("open").checked = openEditor;
  const radio = document.querySelector(`input[name=mode][value=${cursorMode}]`);
  if (radio) radio.checked = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.title) $("name").value = tab.title;
  render();
})();
