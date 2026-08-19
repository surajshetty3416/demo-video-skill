// Records the tab stream with MediaRecorder and accumulates the logger's event
// batches, then uploads both to the editor server and polls the conversion.
// Lives in an offscreen document so recording survives popup close and
// service-worker suspension.

let rec = null, stream = null, chunks = [], events = [], job = null, t0 = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.cmd === "events" && rec) events.push(...msg.batch);
  else if (msg.cmd === "offscreen-start") start(msg).catch(fail);
  else if (msg.cmd === "offscreen-stop" && rec && rec.state !== "inactive") rec.stop();
});

function fail(e) {
  chrome.runtime.sendMessage({ cmd: "rec-error", error: String(e?.message || e) });
  cleanup();
}

function cleanup() {
  stream?.getTracks().forEach((t) => t.stop());
  rec = null; stream = null; chunks = []; events = [];
}

function constraints(streamId, px, py, exact) {
  return { audio: false, video: { mandatory: {
    chromeMediaSource: "tab", chromeMediaSourceId: streamId, maxFrameRate: 60,
    ...(exact ? { minWidth: px, minHeight: py, maxWidth: px, maxHeight: py }
              : { maxWidth: px, maxHeight: py }),
  } } };
}

async function start(msg) {
  job = msg; chunks = []; events = [];
  const px = Math.round(msg.page.w * msg.page.dpr);
  const py = Math.round(msg.page.h * msg.page.dpr);
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints(msg.streamId, px, py, true));
  } catch {
    stream = await navigator.mediaDevices.getUserMedia(constraints(msg.streamId, px, py, false));
  }
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    .find((m) => MediaRecorder.isTypeSupported(m));
  rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 24e6 });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstart = () => {
    t0 = Date.now();
    chrome.runtime.sendMessage({ cmd: "rec-started", t0 });
  };
  rec.onstop = () => upload().catch(fail);
  rec.onerror = (e) => fail(e.error || new Error("MediaRecorder error"));
  rec.start(1000);
}

async function upload() {
  await sleep(400); // let the logger's final batch land
  stream?.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: "video/webm" });
  const server = job.server.replace(/\/+$/, "");
  chrome.runtime.sendMessage({ cmd: "rec-phase", phase: "uploading" });
  let r = await fetch(server + "/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: job.name, page: job.page, t0, events }),
  });
  if (!r.ok) throw new Error("import: " + (await r.text()));
  const { id } = await r.json();
  r = await fetch(`${server}/api/import/${id}/video`, { method: "POST", body: blob });
  if (!r.ok) throw new Error("video upload: " + (await r.text()));
  chrome.runtime.sendMessage({ cmd: "rec-phase", phase: "converting" });
  for (;;) {
    await sleep(1500);
    const st = await (await fetch(`${server}/api/import/${id}/status`)).json();
    if (st.status === "done") break;
    if (st.status === "error") throw new Error(st.error || "conversion failed");
  }
  cleanup();
  chrome.runtime.sendMessage({ cmd: "rec-done", segment: id });
}
