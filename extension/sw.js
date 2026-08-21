// Orchestrates both recording modes and the floating REC pill.
//
// "frames" (default, drawn cursor): chrome.debugger drives Page.startScreencast —
// cursor-free JPEGs stream to the editor server as they arrive, so memory stays
// flat and the compositor can draw its editable vector cursor. Logger events
// stream alongside. The debugger listeners are top-level, so frame events wake
// this worker if it was suspended.
//
// "baked" (recorded cursor): the popup mints a tabCapture streamId and the
// offscreen document records a webm (offscreen.js), uploading on stop.
//
// The pill (rec.html) is a separate popup window: visible to the user, never
// part of the captured tab pixels, and a one-click stop.

const S = chrome.storage.session;
const FLUSH_N = 12, FLUSH_MS = 600;
let frameBuf = [], eventBuf = [], flushTimer = null, lastSession = null, stopPoll = null;

async function session() {
  return (await S.get("session")).session || null;
}

async function patch(p) {
  lastSession = { ...((await session()) || {}), ...p };
  await S.set({ session: lastSession });
}

function badge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  handle(msg).then(respond).catch((e) => respond({ error: String(e?.message || e) }));
  return true;
});

async function handle(msg) {
  switch (msg.cmd) {
    case "start": return start(msg);
    case "stop": return stop();
    case "pause": return pauseCast();
    case "resume": return resumeCast();
    case "events": return onLoggerEvents(msg);
    case "rec-started":
      await patch({ phase: "recording", t0: msg.t0 });
      badge("REC", "#dc2626");
      openPill();
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

/* ---------- shared ---------- */

async function start({ streamId, server, name, mode }) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (mode === "baked") return startBaked(tab, streamId, server, name);
  return startCast(tab, server, name);
}

async function stop() {
  const s = await session();
  if (!s || !["starting", "recording", "paused"].includes(s.phase)) return { ok: true };
  clearInterval(stopPoll); stopPoll = null;
  if (s.tabId) chrome.tabs.sendMessage(s.tabId, { cmd: "logger-stop" }).catch(() => {});
  await patch({ phase: "uploading" });
  badge("↑", "#4f46e5");
  if (s.mode === "frames") finishCast(s).catch((e) => castError(e));
  else await chrome.runtime.sendMessage({ cmd: "offscreen-stop" });
  return { ok: true };
}

async function recDone(msg) {
  const s = await session();
  await patch({ phase: "done", segment: msg.segment });
  badge("✓", "#16a34a");
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 8000);
  if (s?.server) chrome.tabs.create({ url: s.server });
  chrome.offscreen.closeDocument().catch(() => {});
  return {};
}

function measurePage(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
                   title: document.title, url: location.href }),
  }).then(([inj]) => inj.result);
}

function injectLogger(tabId) {
  return chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, files: ["logger.js"] })
    .catch(() => {}); // restricted frames (chrome://, sandboxed) just skip
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const s = await session();
  if (s && ["recording", "starting", "paused"].includes(s.phase)
      && tabId === s.tabId && info.status === "complete") {
    injectLogger(tabId);
  }
});

/* ---------- REC pill window (baked mode only — frames mode gets the
   server-side topmost pill from editor/recpill.py instead) ---------- */

async function openPill() {
  const s = await session();
  if (!s?.tabId) return;
  try {
    const tab = await chrome.tabs.get(s.tabId);
    const win = await chrome.windows.get(tab.windowId);
    const pill = await chrome.windows.create({
      url: "rec.html", type: "popup", focused: false, width: 190, height: 64,
      left: Math.max(0, (win.left || 0) + (win.width || 800) - 210),
      top: Math.max(0, (win.top || 0) + (win.height || 600) - 110),
    });
    await patch({ pillWin: pill.id });
  } catch {}
}

/* ---------- baked mode (tabCapture + offscreen webm) ---------- */

async function startBaked(tab, streamId, server, name) {
  const page = await measurePage(tab.id);
  if (!(await chrome.offscreen.hasDocument?.())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: ["USER_MEDIA"],
      justification: "Record the captured tab with MediaRecorder",
    }).catch(() => {});
  }
  await patch({ phase: "starting", mode: "baked", tabId: tab.id, server, name,
                error: null, segment: null, pillWin: null });
  await chrome.runtime.sendMessage({ cmd: "offscreen-start", streamId, page, server,
                                     name: name || page.title });
  await injectLogger(tab.id);
  return { ok: true };
}

/* ---------- frames mode (CDP screencast, cursor-free) ---------- */

async function startCast(tab, server, name) {
  await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  await sleep(350); // the debugger infobar resizes the viewport; measure after
  const page = await measurePage(tab.id);
  const r = await fetch(server + "/api/import", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "frames", name: name || page.title, page }),
  });
  if (!r.ok) {
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    throw new Error("import: " + (await r.text()));
  }
  const { id } = await r.json();
  frameBuf = []; eventBuf = [];
  await patch({ phase: "recording", mode: "frames", tabId: tab.id, server, name, id, page,
                t0: Date.now(), pausedMs: 0, pauseStart: null,
                error: null, segment: null, pillWin: null });
  await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.startScreencast", {
    format: "jpeg", quality: 85, everyNthFrame: 1,
    maxWidth: Math.ceil(page.w * page.dpr), maxHeight: Math.ceil(page.h * page.dpr),
  });
  badge("REC", "#dc2626");
  await injectLogger(tab.id);
  // the server-side topmost pill requests stop out of band; frames-flush
  // responses carry the flag too, this poll covers fully static pages
  stopPoll = setInterval(async () => {
    const s = lastSession || (await session());
    if (!s?.id || !["recording", "paused"].includes(s.phase)) return;
    const st = await fetch(`${s.server}/api/import/${s.id}/status`)
      .then((r) => r.json()).catch(() => null);
    if (st?.stop) stop();
  }, 2000);
  return { ok: true };
}

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method !== "Page.screencastFrame") return;
  chrome.debugger.sendCommand(src, "Page.screencastFrameAck",
                              { sessionId: params.sessionId }).catch(() => {});
  const t = params.metadata?.timestamp ? Math.round(params.metadata.timestamp * 1000)
                                       : Date.now();
  frameBuf.push({ t, d: params.data });
  if (frameBuf.length >= FLUSH_N) flushCast();
  else scheduleFlush();
});

chrome.debugger.onDetach.addListener(async (src) => {
  const s = await session();
  if (s?.mode === "frames" && ["recording", "paused"].includes(s.phase) && src.tabId === s.tabId) {
    // banner dismissed or tab closed: salvage what already streamed
    await patch({ phase: "uploading" });
    finishCast(s, true).catch((e) => castError(e));
  }
});

async function onLoggerEvents(msg) {
  const s = lastSession || (await session());
  if (s?.mode === "frames" && s.phase !== "paused") { // only paused input is dropped
    eventBuf.push(...msg.batch);
    scheduleFlush();
  }
  return {}; // baked mode: the offscreen document consumes the same message
}

// pause stops the screencast and stamps a marker; ingest excises the interval
async function pauseCast() {
  const s = await session();
  if (s?.mode !== "frames" || s.phase !== "recording") return {};
  await chrome.debugger.sendCommand({ tabId: s.tabId }, "Page.stopScreencast").catch(() => {});
  eventBuf.push({ t: Date.now(), k: "p" });
  scheduleFlush();
  await patch({ phase: "paused", pauseStart: Date.now() });
  badge("II", "#737373");
  return {};
}

async function resumeCast() {
  const s = await session();
  if (s?.mode !== "frames" || s.phase !== "paused") return {};
  eventBuf.push({ t: Date.now(), k: "r" });
  await patch({ phase: "recording",
                pausedMs: (s.pausedMs || 0) + (Date.now() - s.pauseStart), pauseStart: null });
  await chrome.debugger.sendCommand({ tabId: s.tabId }, "Page.startScreencast", {
    format: "jpeg", quality: 85, everyNthFrame: 1,
    maxWidth: Math.ceil(s.page.w * s.page.dpr), maxHeight: Math.ceil(s.page.h * s.page.dpr),
  }).catch((e) => castError(e));
  badge("REC", "#dc2626");
  return {};
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushCast, FLUSH_MS);
}

async function flushCast() {
  clearTimeout(flushTimer); flushTimer = null;
  const s = lastSession || (await session());
  if (!s?.id) return;
  const base = `${s.server}/api/import/${s.id}`;
  if (frameBuf.length) {
    const frames = frameBuf.splice(0);
    const res = await fetch(base + "/frames", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frames }) })
      .then((r) => r.json())
      .catch(() => (frameBuf.unshift(...frames), null));
    if (res?.stop) stop();
  }
  if (eventBuf.length) {
    const events = eventBuf.splice(0);
    await fetch(base + "/events", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }) }).catch(() => eventBuf.unshift(...events));
  }
}

async function finishCast(s, detached) {
  clearInterval(stopPoll); stopPoll = null;
  if (!detached) {
    await chrome.debugger.sendCommand({ tabId: s.tabId }, "Page.stopScreencast").catch(() => {});
    await sleep(500); // let the logger's final batch land
  }
  await flushCast();
  if (!detached) await chrome.debugger.detach({ tabId: s.tabId }).catch(() => {});
  const base = `${s.server}/api/import/${s.id}`;
  let r = await fetch(base + "/finish", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error("finish: " + (await r.text()));
  await patch({ phase: "converting" });
  for (;;) {
    await sleep(1500);
    const st = await (await fetch(base + "/status")).json();
    if (st.status === "done") break;
    if (st.status === "error") throw new Error(st.error || "conversion failed");
  }
  await recDone({ segment: s.id });
}

async function castError(e) {
  await patch({ phase: "error", error: String(e?.message || e) });
  badge("ERR", "#b91c1c");
}
