/* Prewall Reader - background service worker (MV3) */
const LRU_KEY = "prewall:lru";
const PREFIX = "prewall:article-";
const MAX_KEEP = 10;

function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function getLRU() {
  try {
    const o = await chrome.storage.session.get(LRU_KEY);
    const v = o[LRU_KEY];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

// Serialize ALL LRU read-modify-write through one queue (track + evict + trim)
let lruQueue = Promise.resolve();
function mutateLRU(fn) {
  const job = lruQueue.then(fn);
  lruQueue = job.catch(() => {});
  return job;
}
function trackId(id) {
  return mutateLRU(async () => {
    const lru = await getLRU();
    const next = [id, ...lru.filter((x) => x !== id)].slice(0, MAX_KEEP);
    const evicted = lru.filter((x) => !next.includes(x));
    // remove-first: crash between ops leaves dangling LRU (safe expired error)
    // rather than orphan keys silently eating quota
    if (evicted.length) {
      try { await chrome.storage.session.remove(evicted.map((x) => PREFIX + x)); } catch {}
    }
    await chrome.storage.session.set({ [LRU_KEY]: next });
  });
}

function evictOldest() {
  return mutateLRU(async () => {
    const lru = await getLRU();
    const oldest = lru[lru.length - 1];
    if (!oldest) return false;
    try { await chrome.storage.session.remove(PREFIX + oldest); } catch {}
    try { await chrome.storage.session.set({ [LRU_KEY]: lru.slice(0, -1) }); } catch {}
    return true;
  });
}

function badUrl(url) {
  if (!url) return "No active tab URL.";
  if (/^(chrome|edge|about|chrome-extension|brave|opera):/i.test(url)) return "Cannot run on browser system pages. Open a normal http(s) article.";
  if (!/^https?:/i.test(url)) return "Only http(s) pages are supported.";
  return null;
}

function sendWithTimeout(tabId, msg, ms = 10000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) { done = true; resolve({ ok: false, error: "Timed out waiting for page. Reload and retry." }); }
    }, ms);
    try {
      chrome.tabs.sendMessage(tabId, msg, (r) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(r || { ok: false, error: "Empty response from page." });
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(t); resolve({ ok: false, error: String(e?.message || e) }); }
    }
  });
}

async function ping(tabId, ms = 3000) {
  const r = await sendWithTimeout(tabId, { type: "PING" }, ms);
  return r?.ok ? r : null;
}

async function ensureContentScript(tabId) {
  let r = await ping(tabId, 800);
  if (r) return;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["lib/Readability.js", "lib/Turndown.js", "content.js"]
  });
  // bounded ~8s total; fast 800ms pings so CAPTURE (15s GET budget) can't overrun
  for (let i = 0; i < 10; i++) {
    await new Promise((res) => setTimeout(res, 200));
    r = await ping(tabId, 800);
    if (r) return;
  }
  throw new Error("Content script did not start. Reload the page and retry.");
}

// Serialize captures so concurrent clicks don't corrupt LRU or double-charge extraction
let captureQueue = Promise.resolve();
function enqueueCapture(fn) {
  const job = captureQueue.then(fn);
  captureQueue = job.catch(() => {});
  return job;
}

async function doCapture() {
  return enqueueCapture(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab.");
    const err = badUrl(tab.url);
    if (err) throw new Error(err);
    await ensureContentScript(tab.id);
    const id = uuid();
    const resp = await sendWithTimeout(tab.id, { type: "GET_SNAPSHOT", id }, 15000);
    if (!resp?.ok) throw new Error(resp?.error || "Extraction failed. Reload the page and click earlier.");
    const stored = await chrome.storage.session.get(PREFIX + id);
    if (!stored[PREFIX + id]) throw new Error("Snapshot write failed (storage quota full). Close old reader tabs and retry.");
    await trackId(id);
    await chrome.tabs.create({ url: chrome.runtime.getURL("reader.html") + "?id=" + encodeURIComponent(id) });
    return id;
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "CAPTURE") {
        try { await doCapture(); sendResponse({ ok: true }); }
        catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
      } else if (msg?.type === "EVICT_OLDEST") {
        try { sendResponse({ ok: true, evicted: await evictOldest() }); }
        catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
      }
    } catch (e) {
      try { sendResponse({ ok: false, error: String(e?.message || e) }); } catch {}
    }
  })();
  return true;
});

// SPA support: forward client-side navigations; content.js decides if reset is warranted
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  try {
    chrome.tabs.sendMessage(details.tabId, { type: "RESET", url: details.url }, () => void chrome.runtime.lastError);
  } catch {}
});

// trim LRU on startup (through the same queue)
chrome.runtime.onStartup.addListener(() => {
  mutateLRU(async () => {
    try {
      const lru = await getLRU();
      if (lru.length > MAX_KEEP) {
        const keep = lru.slice(0, MAX_KEEP);
        const drop = lru.slice(MAX_KEEP);
        try { await chrome.storage.session.remove(drop.map((x) => PREFIX + x)); } catch {}
        await chrome.storage.session.set({ [LRU_KEY]: keep });
      }
    } catch {}
  });
});
