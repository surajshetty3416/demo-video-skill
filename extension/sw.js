// Orchestration only: the popup supplies a tabCapture streamId (user gesture),
// the offscreen document records and uploads, this worker injects the event
// logger (and re-injects it across in-tab navigations) and keeps badge state.
// Event batches flow content script -> offscreen directly; this worker ignores them.

const S = chrome.storage.session;

async function session() {
  return (await S.get("session")).session || null;
}

async function patch(p) {
  await S.set({ session: { ...((await session()) || {}), ...p } });
}

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  handle(msg).then(respond).catch((e) => respond({ error: String(e?.message || e) }));
  return true;
});

async function handle(msg) {
  switch (msg.cmd) {
    case "start": return start(msg);
    case "stop": return stop();
    case "rec-started":
      await patch({ phase: "recording", t0: msg.t0 });
      badge("REC", "#dc2626");
      return {};
    case "rec-phase":
      await patch({ phase: msg.phase });
      return {};
    case "rec-done": return recDone(msg);
    case "rec-error":
      await patch({ phase: "error", error: msg.error });
      badge("ERR", "#b91c1c");
      return {};
  }
  return {};
}

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record the captured tab with MediaRecorder",
  }).catch(() => {});
}

function injectLogger(tabId) {
  return chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: ["logger.js"] })
    .catch(() => {}); // restricted frames (chrome://, sandboxed) just skip
}

async function start({ streamId, server, name }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
                   title: document.title, url: location.href }),
  });
  const page = inj.result;
  await ensureOffscreen();
  await S.set({ session: { phase: "starting", tabId: tab.id, server, name, error: null, segment: null } });
  await chrome.runtime.sendMessage({ cmd: "offscreen-start", streamId, page, server,
                                     name: name || page.title });
  await injectLogger(tab.id);
  return { ok: true };
}

async function stop() {
  const s = await session();
  if (s?.tabId) chrome.tabs.sendMessage(s.tabId, { cmd: "logger-stop" }).catch(() => {});
  await patch({ phase: "uploading" });
  badge("↑", "#4f46e5");
  await chrome.runtime.sendMessage({ cmd: "offscreen-stop" });
  return { ok: true };
}

async function recDone(msg) {
  const s = await session();
  await patch({ phase: "done", segment: msg.segment });
  badge("✓", "#16a34a");
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 8000);
  const { openEditor = true } = await chrome.storage.local.get("openEditor");
  if (openEditor && s?.server) chrome.tabs.create({ url: s.server });
  chrome.offscreen.closeDocument().catch(() => {});
  return {};
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const s = await session();
  if (s && (s.phase === "recording" || s.phase === "starting")
      && tabId === s.tabId && info.status === "complete") {
    injectLogger(tabId);
  }
});
