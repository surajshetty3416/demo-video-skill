// Floating recording pill: lives in its own popup window so it is visible to
// the user but never part of the captured tab pixels. Shows elapsed time,
// stops on click, then reports upload/convert progress and closes itself.

const label = document.getElementById("label");
const btn = document.getElementById("stopBtn");
let timer = null;

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
  if (!s) return window.close();
  document.body.className = "";
  if (s.phase === "recording") {
    const tick = () => { label.textContent = fmt(Date.now() - s.t0); };
    tick();
    timer = setInterval(tick, 500);
    btn.style.display = "";
  } else if (s.phase === "uploading" || s.phase === "converting") {
    document.body.className = "busy";
    label.textContent = s.phase === "uploading" ? "Saving…" : "Converting…";
    btn.style.display = "none";
  } else if (s.phase === "done") {
    document.body.className = "done";
    label.textContent = "Saved ✓";
    btn.style.display = "none";
    setTimeout(() => window.close(), 1800);
  } else if (s.phase === "error") {
    document.body.className = "err";
    label.textContent = "Failed — see popup";
    btn.style.display = "none";
    setTimeout(() => window.close(), 4000);
  } else {
    window.close();
  }
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  await chrome.runtime.sendMessage({ cmd: "stop" });
});

chrome.storage.session.onChanged.addListener(render);
render();
