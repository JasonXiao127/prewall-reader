/* Prewall Reader - reader tab. Loads prewall:article-<id>, sanitizes, renders. */
const PREFIX = "prewall:article-";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeHttpUrl(u, base) {
  try {
    if (!u) return null;
    const a = new URL(u, base || location.href).href;
    return a.startsWith("http://") || a.startsWith("https://") ? a : null;
  } catch { return null; }
}

function stripOnHandlers(root) {
  try {
    const els = [root, ...root.querySelectorAll("*")];
    for (const el of els) {
      for (const attr of Array.from(el.attributes || [])) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      }
    }
  } catch {}
}

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.style.display = "none";
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function main() {
  const rawId = new URLSearchParams(location.search).get("id");
  const titleEl = document.getElementById("title");
  const metaEl = document.getElementById("meta");
  const statusEl = document.getElementById("status");
  const articleEl = document.getElementById("article");
  const imagesEl = document.getElementById("images");
  const origEl = document.getElementById("orig");
  const dlMd = document.getElementById("dl-md");
  const dlHtml = document.getElementById("dl-html");
  const copyBtn = document.getElementById("copy");

  if (!rawId || !UUID_RE.test(rawId)) {
    titleEl.textContent = "No snapshot id";
    statusEl.textContent = "Open this page via the extension button. Direct visits have no valid ?id=.";
    return;
  }
  const id = rawId;
  let snap;
  try {
    const o = await chrome.storage.session.get(PREFIX + id);
    snap = o[PREFIX + id];
  } catch (e) {
    titleEl.textContent = "Storage unavailable";
    statusEl.textContent = String(e?.message || e);
    return;
  }
  if (!snap) {
    titleEl.textContent = "Snapshot expired";
    statusEl.textContent = "Session storage was cleared (browser restart) or the LRU evicted this capture (cap 10). Re-capture from the article tab.";
    return;
  }

  titleEl.textContent = snap.title || "Untitled";
  document.title = (snap.title || "Prewall Reader") + " — Prewall Reader";
  let when = "";
  try {
    const d = snap.capturedAt ? new Date(snap.capturedAt) : null;
    when = d && !isNaN(d.getTime()) ? d.toLocaleString() : "";
  } catch { when = ""; }
  metaEl.textContent = [snap.siteName, snap.byline, when, snap.frozen ? "frozen pre-paywall" : "live"].filter(Boolean).join(" · ");
  const origSafe = safeHttpUrl(snap.url);
  origEl.href = origSafe || "#";
  origEl.rel = "noopener noreferrer";
  if (!origSafe) origEl.style.display = "none";
  statusEl.textContent = "";

  // article body (sanitized) — export uses post-hardened DOM, not pre-clean
  // NOTE: relative URLs resolve against the article origin, NOT chrome-extension://
  const pageBase = safeHttpUrl(snap.url) || undefined;
  let clean = "";
  let finalHtml = "";
  try {
    clean = DOMPurify.sanitize(snap.html || "", { USE_PROFILES: { html: true } });
    articleEl.innerHTML = clean || "<p><i>No extractable text. The paywall likely removed content before capture — try clicking earlier.</i></p>";
    stripOnHandlers(articleEl);
    // media: http(s) src only, drop embeds that can't be validated
    articleEl.querySelectorAll("img, source, video, audio, track, iframe, object, embed").forEach((el) => {
      const tag = el.tagName;
      if (tag === "IFRAME" || tag === "OBJECT" || tag === "EMBED") { el.remove(); return; }
      const src = el.getAttribute("src");
      if (src) {
        const safe = safeHttpUrl(src, pageBase);
        if (!safe) el.removeAttribute("src");
        else el.setAttribute("src", safe);
      }
      const poster = el.getAttribute("poster");
      if (poster) {
        const safe = safeHttpUrl(poster, pageBase);
        if (!safe) el.removeAttribute("poster");
        else el.setAttribute("poster", safe);
      }
      el.removeAttribute("srcset");
      if (tag === "IMG") el.setAttribute("loading", "lazy");
    });
    // harden links: http(s) only + noopener/noreferrer, no tracking pings / forced downloads
    articleEl.querySelectorAll("a, area").forEach((a) => {
      const href = a.getAttribute("href");
      const safe = href ? safeHttpUrl(href, pageBase) : null;
      if (!safe) { a.removeAttribute("href"); }
      else { a.href = safe; a.target = "_blank"; a.rel = "noopener noreferrer"; }
      a.removeAttribute("ping");
      a.removeAttribute("download");
    });
    // forms: validate action, strip formaction overrides (phish hardening)
    articleEl.querySelectorAll("form").forEach((f) => {
      const act = f.getAttribute("action");
      if (act) {
        const safe = safeHttpUrl(act, pageBase);
        if (!safe) f.removeAttribute("action");
        else f.setAttribute("action", safe);
      }
    });
    articleEl.querySelectorAll("[formaction]").forEach((el) => el.removeAttribute("formaction"));
    finalHtml = articleEl.innerHTML;
  } catch {
    clean = "";
    finalHtml = "";
    articleEl.textContent = snap.text || "(no content)";
  }

  // image grid (http(s) links only, resolved against article origin)
  if (Array.isArray(snap.images) && snap.images.length) {
    let pending = 0;
    let shown = 0;
    const frag = document.createDocumentFragment();
    const maybeDone = () => { if (pending === 0) imagesEl.hidden = shown === 0; };
    for (const im of snap.images.slice(0, 40)) {
      const src = safeHttpUrl(im.src, pageBase);
      if (!src) continue;
      pending++;
      const fig = document.createElement("figure");
      const a = document.createElement("a");
      a.href = src; a.target = "_blank"; a.rel = "noopener noreferrer";
      const img = document.createElement("img");
      img.loading = "lazy"; img.alt = im.alt || "";
      img.onerror = () => { fig.remove(); pending = Math.max(0, pending - 1); shown = Math.max(0, shown - 1); maybeDone(); };
      img.onload = () => { pending = Math.max(0, pending - 1); maybeDone(); };
      img.src = src;
      a.appendChild(img);
      fig.appendChild(a);
      if (im.alt) {
        const cap = document.createElement("figcaption");
        cap.textContent = im.alt;
        fig.appendChild(cap);
      }
      frag.appendChild(fig);
      shown++;
    }
    if (shown > 0) {
      imagesEl.appendChild(frag);
      imagesEl.hidden = false;
    }
  }

  const base = (snap.title || "article").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "article";
  const htmlBody = finalHtml || clean || (snap.text ? "<p>" + esc(snap.text).replace(/\n\n/g, "</p><p>") + "</p>" : "");
  dlMd.disabled = dlHtml.disabled = copyBtn.disabled = false;
  dlMd.onclick = () => download(base + ".md", `# ${snap.title || ""}\n\n> Source: ${origSafe || ""}\n\n${snap.markdown || snap.text || ""}\n`, "text/markdown");
  dlHtml.onclick = () => download(base + ".html",
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>" + esc(snap.title || "") + "</title></head><body><h1>" +
    esc(snap.title || "") + "</h1><p><a href=\"" + esc(origSafe || "") + "\">" + esc(origSafe || "") +
    "</a></p>" + htmlBody + "</body></html>", "text/html");
  let copying = false;
  let copyTimer = null;
  copyBtn.onclick = async () => {
    if (copying) return;
    copying = true;
    try { await navigator.clipboard.writeText(snap.markdown || snap.text || ""); copyBtn.textContent = "Copied"; }
    catch { copyBtn.textContent = "Copy failed"; }
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copyBtn.textContent = "Copy"; copying = false; copyTimer = null; }, 1500);
  };
}

main();
