# Prewall Reader (personal MV3 extension)

Snapshots article text + images before soft paywalls cover them. Opens a clean reader tab. Multi-capture safe (`prewall:article-<uuid>`, LRU cap 10).

## Load
1. `chrome://extensions` → Developer mode → Load unpacked → select this folder.
2. Accept `<all_urls>` warning (required for always-on pre-paywall snapshot).
3. Open an article, click extension → **Open reader view**.

## Test
- Normal article → reader tab with title, text, image grid, ↓.md / ↓.html / Copy.
- Double-click twice → two independent reader tabs (no overwrite).
- `chrome://` page → clean error, no crash.
- SPA navigation → cache resets (via `webNavigation.onHistoryStateUpdated`).

## Limits
- Hard paywalls (server snippet-only) cannot be recovered.
- Late clicks after freeze may be truncated — click early.
- `blob:` / unscrolled lazy images skipped; hotlink-blocked images drop from grid.
- Snapshots live in `chrome.storage.session` (10 total, ~10MB). Restart/eviction expires old captures.
