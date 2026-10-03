/* Prewall Reader - content script.
 * Phase A (document_start): install observer only, no DOM reads.
 * Phase B (DOM ready): Readability + image extraction, freeze on paywall signals.
 * Writes directly to chrome.storage.session on GET_SNAPSHOT to avoid message size limits.
 */
(() => {
  if (window.__prewallInstalled) return;
  window.__prewallInstalled = true;

  const PREFIX = "prewall:article-";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // NB: bare "meter" removed (matched parameter/diameter). Use explicit metered variants.
  const PAYWALL_RE = /paywall|pay-wall|metered|meter-wall|article-meter|subscribe|subscription|registration-wall|regwall|overlay-subscribe|premium-wall|soft-wall/i;
  const TARGET_SELECTOR = '[class*="paywall" i], [id*="paywall" i], [class*="regwall" i], [class*="subscribe" i], [class*="subscription" i], [class*="premium-wall" i], [class*="soft-wall" i], [class*="metered" i], [class*="meter-wall" i], [class*="article-meter" i]';

  let frozen = false;
  let cached = null;
  let generation = 0;
  let lastExtractAt = 0;
  let lastCheckAt = 0;
  let observer = null;
  let phaseBDone = false;
  let lastUrl = location.href;

  // Generic overlay/modal alone (cookie banners, nav) must NOT freeze.
  // Only a locked-looking node counts, and generic overlays additionally need
  // paywall-ish text to avoid cookie-banner false positives.
  const PAYWALL_TEXT_RE = /paywall|subscribe|subscription|premium|members? only|sign.?in|register|continue reading|already a subscriber/i;

  function bodyLocked() {
    try {
      const b = document.body;
      if (!b) return false;
      const locked = (el) => {
        try {
          const cs = getComputedStyle(el);
          return cs && (cs.overflow === "hidden" || cs.overflowY === "hidden");
        } catch { return false; }
      };
      if (!(locked(b) || (document.documentElement && locked(document.documentElement)))) return false;
      // paywall-specific locked node → freeze
      const t = document.querySelector(TARGET_SELECTOR);
      if (t) {
        try {
          const s = (t.className && typeof t.className === "string" ? t.className : "") + " " + (t.id || "");
          if (PAYWALL_RE.test(s) && nodeLooksLocked(t)) return true;
        } catch {}
      }
      // generic overlay/modal → freeze only if locked-looking AND paywall text
      const generics = document.querySelectorAll('[class*="overlay" i], [class*="modal" i], [id*="overlay" i]');
      const n = Math.min(generics.length, 20);
      for (let i = generics.length - 1; i >= Math.max(0, generics.length - n); i--) {
        const el = generics[i];
        try {
          if (!nodeLooksLocked(el)) continue;
          const txt = (el.textContent || "").slice(0, 800);
          if (PAYWALL_TEXT_RE.test(txt)) return true;
        } catch {}
      }
    } catch { /* ignore */ }
    return false;
  }

  function nodeLooksLocked(el) {
    try {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const pos = cs.position;
      if (pos === "fixed" || pos === "absolute" || pos === "sticky") {
        if (r.height > 60 && r.width > 80) return true;
      }
      if (r.height > 80 && r.width > 100) return true;
    } catch { return false; }
    return false;
  }

  function hasPaywallNode() {
    try {
      if (!document.body) return false;
      // 1. targeted check first (cheap, order-independent)
      const t = document.querySelector(TARGET_SELECTOR);
      if (t) {
        try {
          const s = (t.className && typeof t.className === "string" ? t.className : "") + " " + (t.id || "");
          if (PAYWALL_RE.test(s) && nodeLooksLocked(t)) return true;
        } catch { /* fall through to scan */ }
      }
      // 2. full scan in REVERSE (paywall overlays are appended last)
      const els = document.querySelectorAll("[class], [id]");
      const total = els.length;
      const budget = Math.min(total, 800);
      for (let k = 0; k < budget; k++) {
        const el = els[total - 1 - k];
        const s = (el.className && typeof el.className === "string" ? el.className : "") + " " + (el.id || "");
        if (PAYWALL_RE.test(s) && nodeLooksLocked(el)) return true;
      }
      return false;
    } catch { return false; }
  }

  function checkFreeze() {
    if (frozen || !document.body) return frozen;
    const now = Date.now();
    if (now - lastCheckAt < 500) return frozen; // throttle layout-forcing scan
    lastCheckAt = now;
    if (hasPaywallNode() || bodyLocked()) {
      frozen = true;
      if (!cached) {
        try { extractAndCache(true); } catch {}
      } else cached.frozen = true;
      if (observer) { try { observer.disconnect(); } catch {} observer = null; }
    }
    return frozen;
  }

  function absUrl(u) {
    try {
      if (!u) return null;
      const s = String(u).trim();
      if (!s || s.startsWith("blob:") || s.startsWith("javascript:") || s.startsWith("data:")) return null;
      const a = new URL(s, location.href).href;
      return (a.startsWith("http://") || a.startsWith("https://")) ? a : null;
    } catch { return null; }
  }

  function bestFromSrcset(ss) {
    try {
      const parts = String(ss).split(",").map((p) => p.trim().split(" ")[0]).filter(Boolean);
      // srcset is usually ascending; take the LAST http candidate (largest)
      for (let i = parts.length - 1; i >= 0; i--) {
        const a = absUrl(parts[i]);
        if (a) return a;
      }
    } catch {}
    return null;
  }

  function pickSrc(img) {
    const cands = [
      img.currentSrc, img.src,
      img.getAttribute("data-src"), img.getAttribute("data-lazy-src"),
      img.getAttribute("data-original"), img.getAttribute("data-image")
    ];
    for (const c of cands) {
      const a = c && absUrl(c);
      if (a) return a;
    }
    // <picture><source srcset> — use the parent picture's best source
    try {
      const pic = img.parentElement && img.parentElement.tagName === "PICTURE" ? img.parentElement : null;
      if (pic) {
        const sources = pic.querySelectorAll("source[srcset]");
        for (let i = sources.length - 1; i >= 0; i--) {
          const a = bestFromSrcset(sources[i].getAttribute("srcset"));
          if (a) return a;
        }
      }
    } catch {}
    const ss = img.getAttribute("srcset") || img.getAttribute("data-srcset");
    if (ss) {
      const a = bestFromSrcset(ss);
      if (a) return a;
    }
    return null;
  }

  function collectImages(limit = 40) {
    const out = [];
    const seen = new Set();
    try {
      const imgs = document.querySelectorAll("img");
      for (const img of imgs) {
        if (out.length >= limit) break;
        const src = pickSrc(img);
        if (!src || seen.has(src)) continue;
        try {
          const u = new URL(src);
          const base = u.pathname.split("/").pop() || "";
          if (/^(pixel|tracker|spacer|transparent|1x1)(\.|-|_)/i.test(base)) continue;
          if (/tracking|beacon/i.test(u.pathname + u.search)) continue;
        } catch { continue; }
        const w = img.naturalWidth || parseInt(img.getAttribute("width") || "0", 10) || 0;
        const h = img.naturalHeight || parseInt(img.getAttribute("height") || "0", 10) || 0;
        // 0 = lazy/unrendered → keep; only drop explicitly-small placeholders
        if (w > 0 && w < 120) continue;
        if (h > 0 && h < 80) continue;
        seen.add(src);
        out.push({ src, alt: (img.alt || "").slice(0, 200) });
      }
    } catch { /* ignore */ }
    return out;
  }

  function fallbackExtract() {
    const root = document.querySelector("article") || document.querySelector("main") || document.body;
    if (!root) return null;
    const title = (document.title || "").trim();
    const paras = Array.from(root.querySelectorAll("p"))
      .map((p) => (p.textContent || "").trim())
      .filter((t) => t.length > 40)
      .slice(0, 200);
    const html = "<div>" + paras.map((t) => "<p>" + escapeHtml(t) + "</p>").join("") + "</div>";
    return { title, excerpt: paras[0]?.slice(0, 200) || "", html, text: paras.join("\n\n") };
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 300k caps keep worst-case object ~0.9MB so several fit in 10MB session quota
  const CAP = 300000;

  function extractAndCache(force = false) {
    try {
      if (!document.body) return null;
      if (frozen && cached) return cached;
      const now = Date.now();
      if (!force && cached && now - lastExtractAt < 1500) return cached;
      lastExtractAt = now;
      let parsed = null;
      try {
        if (typeof Readability !== "undefined") {
          const clone = document.cloneNode(true);
          parsed = new Readability(clone, { charThreshold: 100 }).parse();
        }
      } catch { parsed = null; }
      let fb = null;
      try { fb = parsed ? null : fallbackExtract(); } catch { fb = null; }
      let text = "";
      try {
        text = (parsed?.textContent || fb?.text || document.body.textContent || "").trim().slice(0, CAP);
      } catch { text = (cached?.text || ""); }
      const title = (parsed?.title || fb?.title || document.title || "Untitled").trim().slice(0, 300);
      const html = (parsed?.content || fb?.html || "").slice(0, CAP);
      let markdown = "";
      try {
        if (typeof TurndownService !== "undefined" && html) {
          markdown = new TurndownService({ headingStyle: "atx" }).turndown(html.slice(0, CAP)).slice(0, CAP);
        } else {
          markdown = text;
        }
      } catch { markdown = text; }
      cached = {
        title,
        url: location.href,
        excerpt: (parsed?.excerpt || fb?.excerpt || "").slice(0, 500),
        byline: (parsed?.byline || "").slice(0, 200),
        siteName: (parsed?.siteName || location.hostname).slice(0, 200),
        html, markdown, text,
        images: collectImages(),
        capturedAt: new Date().toISOString(),
        frozen
      };
      return cached;
    } catch (e) {
      return cached; // never throw into messenger; caller replies with error if null
    }
  }

  function sendMessageTimeout(msg, ms = 4000) {
    return new Promise((resolve) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve(r);
        });
      } catch { if (!done) { done = true; clearTimeout(t); resolve(null); } }
    });
  }

  async function writeWithEvictRetry(key, value, retries = 3) {
    let lastErr = null;
    for (let i = 0; i < retries; i++) {
      try {
        await chrome.storage.session.set({ [key]: value });
        return;
      } catch (e) {
        lastErr = e;
        if (!/quota/i.test(String(e?.message || e))) throw e;
        // ask background to evict oldest LRU entry, then retry (bounded wait)
        try {
          await sendMessageTimeout({ type: "EVICT_OLDEST" }, 4000);
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw lastErr || new Error("quota exceeded");
  }

  function samePath(a, b) {
    try {
      const ua = new URL(a), ub = new URL(b);
      return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search;
    } catch { return a === b; }
  }

  function initObserver() {
    const root = document.documentElement || document;
    if (observer) return;
    try {
      observer = new MutationObserver(() => {
        if (frozen) return;
        if (checkFreeze()) return;
        if (document.body && Date.now() - lastExtractAt > 4000) {
          try { extractAndCache(); } catch {}
        }
      });
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "id"] });
    } catch { /* ignore */ }
  }

  function initPhaseB() {
    if (phaseBDone) return;
    if (!document.body) return;
    phaseBDone = true;
    initObserver();
    checkFreeze();
    try { extractAndCache(true); } catch {}
  }

  // Phase A: run immediately (document_start -> documentElement may just exist)
  initObserver();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPhaseB, { once: true });
    const bootGen = generation;
    setTimeout(() => { if (bootGen !== generation) return; try { initPhaseB(); } catch {} }, 2500);
  } else {
    initPhaseB();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === "PING") {
          sendResponse({ ok: true, hasCache: !!cached, frozen });
        } else if (msg?.type === "GET_SNAPSHOT") {
          const id = msg.id;
          if (!id || !UUID_RE.test(String(id))) { sendResponse({ ok: false, error: "invalid id" }); return; }
          const gen = generation;
          if (!frozen) { checkFreeze(); }
          const snap = extractAndCache(true);
          if (gen !== generation) { sendResponse({ ok: false, error: "page navigated during capture, retry" }); return; }
          if (!snap) { sendResponse({ ok: false, error: "no content yet" }); return; }
          snap.frozen = frozen;
          try {
            await writeWithEvictRetry(PREFIX + id, snap);
            if (gen !== generation) {
              try { await chrome.storage.session.remove(PREFIX + id); } catch {}
              sendResponse({ ok: false, error: "page navigated during capture, retry" });
              return;
            }
            sendResponse({ ok: true, uuid: id });
          } catch (e) {
            sendResponse({ ok: false, error: "storage quota full even after eviction. " + String(e?.message || e) });
          }
        } else if (msg?.type === "RESET") {
          const nextUrl = msg.url || location.href;
          // dedup: same origin+path+search as last RESET → skip (covers identical
          // duplicates and hash-only / tab-switch pushStates)
          if (samePath(nextUrl, lastUrl)) {
            sendResponse({ ok: true, skipped: true });
            return;
          }
          generation++;
          lastUrl = nextUrl;
          frozen = false;
          cached = null;
          lastExtractAt = 0;
          lastCheckAt = 0;
          phaseBDone = false;
          if (observer) { try { observer.disconnect(); } catch {} observer = null; }
          initObserver();
          // delay re-extract until SPA content renders; abort if a newer RESET wins
          const myGen = generation;
          setTimeout(() => {
            if (myGen !== generation) return;
            try { initPhaseB(); } catch {}
          }, 800);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "unknown message" });
        }
      } catch (e) {
        try { sendResponse({ ok: false, error: String(e?.message || e) }); } catch {}
      }
    })();
    return true;
  });
})();
