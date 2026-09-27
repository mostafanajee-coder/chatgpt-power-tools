# ⚡ TurboGPT - Chat Speed Booster & Power Tools for ChatGPT

<p align="center">
  <img src="icons/icon128.png" alt="TurboGPT Logo" width="100" height="100" />
</p>

<p align="center">
  <strong>The ultimate speed accelerator and productivity toolkit for ChatGPT.</strong><br>
  Eliminate UI lag &amp; freezing in long conversations, export chats, navigate with a Table of Contents, pin important replies, and organize chats into folders.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-3.13.0-blue.svg?style=flat-square" alt="Version 3.13.0" />
  <img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/Privacy-100%25%20Local-emerald.svg?style=flat-square" alt="100% Local" />
  <img src="https://img.shields.io/badge/Dependencies-Zero-brightgreen.svg?style=flat-square" alt="Zero dependencies" />
</p>

---

## 🌟 Key Features

### 📊 1. Real-Time Context Window & Token Consumption Meter
- **Live Gauge in Popup**: View the exact percentage of context capacity used, percentage remaining, and estimated tokens left (calibrated for a 110,000 safe token ceiling).
- **Dynamic Animated Progress Bar**: Smooth color transitions reflecting conversation load:
  - 🟢 **Healthy** (≤70%): Normal, optimal performance.
  - 🟠 **Heavy** (70-85%): Large conversation reaching memory limits.
  - 🔴 **Critical** (>85%): High risk of hitting OpenAI context limit errors.
- **In-Chat Floating Dock Badge**: Real-time consumption percentage displayed right inside ChatGPT with one-click token breakdown toast.
- **Server Pagination Extrapolation**: Accurately scales full-conversation context estimates when older pages are stored on the server and not yet loaded into the DOM.

### 🚀 2. Long Chat Speed Booster (Zero Lag)
- **Instant Acceleration**: Trims heavy historical messages from the browser DOM while preserving full context on ChatGPT's servers.
- **Configurable Live Auto-Trim**: By default, turns are trimmed comfortably on page load/refresh so ongoing chats are never abruptly hidden. A dedicated toggle lets users enable live instant auto-trimming as new messages arrive if preferred.
- **Smart Turn Trimming**: Automatically renders only the most recent Q&A turns for maximum typing and scrolling smoothness.

### ⚡ 3. Seamless Auto-Load on Scroll Up (Gemini-Style Lazy Loading)
- **Zero-Click Reveal**: As you scroll up towards the beginning of the conversation, older turns reveal themselves automatically without pressing buttons.
- **Micro Loading Spinner**: Displays a sleek glassmorphic loading indicator (`Loading older messages...`) right inline as new batches arrive.
- **Pixel-Perfect Scroll Anchoring**: Exact viewport compensation (`newTop - oldTop`) guarantees the reading position never jitters or jumps.
- **Optional Floating Pill**: The floating `↑ Load +5 older turns` pill is preserved as an optional manual shortcut with its own dedicated toggle.

### 🧭 3. Chat Navigator & Table of Contents (Outline)
- Floating outline drawer on the right side listing all your prompts in the conversation (`#1`, `#2`, `#3`...).
- **1-Click Smooth Jump**: Clicking any question scrolls straight to that turn with a radiant glowing highlight.

### ⭐️ 4. Response Bookmarks & Pinning
- Adds a **⭐️ Pin button** to every AI assistant reply.
- Pinned responses are stored locally and accessible from the **⭐️ Pinned** tab in the Navigator for instant reference.
- Automatically unhides target message if it was hidden by the DOM turn limiter.

### 🔍 5. Full-History Archive & Quick Search (`Alt + F`)
- **Dual Search Modes**:
  - `🌐 All History`: Searches across the entire conversation archive via the background API without flooding the browser DOM.
  - `📄 In-Screen`: Instant real-time search across messages currently visible.
- **Keyword Highlighting & Snippet Previews**: Visual `<mark>` tags, author badges (`User` / `ChatGPT`), and match indicators.
- **Interactive Navigation**: Keyboard arrows (`▲` / `▼`), `Enter` / `Shift+Enter`, and `Escape`.
- **Historical Preview Modal**: Inspect and copy full messages from earlier history with one click.

### 💾 6. Backup & Restore Data (JSON)
- **Export Backup**: Save all your custom folders, pinned bookmarks, and preferences into a clean JSON file with one click.
- **Import & Restore**: Instantly restore folders and pinned chats on any browser or machine without cloud dependencies.

### 📁 7. Sidebar Folder Organizer
- Create custom folders directly in ChatGPT's sidebar to organize your chats.
- **Add/remove the current chat** to any folder with one click (`＋` / `✓` on hover).
- **Expand a folder** to see its saved chats with real titles and open them directly; remove chats from folders anytime.
- Rename (`✎`) or delete (`🗑`) folders - deleting a folder never deletes your chats.
- All folder data is stored locally per browser.

### 📄 8. Selective Chat Exporter
- Pick exactly which messages to export via checkboxes (select all / none supported), then export to:
  - **Microsoft Word (.docx)** - genuine OOXML document built from scratch with zero libraries; code blocks are preserved in monospace with shading.
  - **Formatted PDF** (print view)
  - **Markdown (`.md`)**
  - **Plain Text (`.txt`)**
  - **Structured JSON**
- **Structure survives**: fenced code blocks keep their language, links keep their URLs, and lists, tables, headings and quotes are preserved - not flattened into plain text.
- Selective exports cover the messages currently loaded in the chat.

### 💾 9. Local Conversation Archive (instant export, with images)

Exporting a long chat by asking OpenAI for it again can be refused, rate-limited or cut short. The local archive removes that request entirely:

- **Captured from what ChatGPT already loads**: when a chat opens, ChatGPT fetches the whole conversation for itself. TurboGPT keeps a copy of that response on your device, with no extra request.
- **Kept up to date as you chat**: each new message is saved from the page as soon as it finishes streaming.
- **Older history filled in the background**: ChatGPT now opens a chat with only its latest turns. TurboGPT saves the older pages one at a time, one request every few seconds, using exactly the request ChatGPT makes itself. Each page is saved the moment it arrives, so if a request is refused nothing is lost and the next visit resumes from the oldest saved page. The Export window says whether the archive is complete from the first message.
- **Images included**: pictures you upload and images ChatGPT generates are saved as real image files on your device while their links are still valid. Images from older turns that were never displayed are fetched once through ChatGPT's own file endpoint.
- **Two instant exports** in the Export window, read only from your device:
  - **HTML (.html, with images)**: one self-contained file with every image embedded. It opens offline in any browser, forever.
  - **Markdown (.md, text only)**: clean text with a note where each image was.
- **Your control**: on by default, with a toggle, archive size, and a *Delete archive* button in the popup. Nothing ever leaves your device. Temporary chats are never archived.

### 🗄️ 10. Whole-Conversation Export & Continuation

For a chat that hit ChatGPT's length limit and won't accept new messages:

- **📚 Full conversation (.md)** - fetches *every* turn from the conversation API, including ones trimmed for speed, **without** loading them into the page. The API returns the model's original markdown, so the archive is a faithful round-trip.
- **🔗 Continuation prompt** - copies a ready-to-paste block with the last N turns (default `10`, set in the popup) plus an instruction telling the model to continue rather than restart.

Start a new chat, attach the `.md`, paste the continuation prompt, and carry on where you stopped. If the full fetch can't complete, the export says exactly how far it got and why - a partial archive is never presented as complete.

---

## 🔒 100% Private & Local-Only

- **Zero Telemetry**: No tracking, analytics, or external API servers.
- **No Token Access**: The extension never reads or stores your ChatGPT auth token.
- **Offline First**: All processing, trimming, and exports run 100% locally in your browser.
- **Minimal Permissions**: `storage`, `unlimitedStorage` (for the local archive), and `activeTab`. Host access is limited to ChatGPT and OpenAI's image file host.
- **No Account Required**: Free forever for everyone.

---

## 📥 Installation (Developer Mode / Unpacked)

1. **Clone or Download** this repository:
   ```bash
   git clone https://github.com/mostafanajee-coder/chatgpt-power-tools.git
   ```
2. Open Chrome (or Edge / Brave / Opera) and navigate to `chrome://extensions`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked**.
5. Select the `chatgpt-power-tools` folder.
6. Navigate to [ChatGPT](https://chatgpt.com) and enjoy instant, lag-free conversations!

---

## 🛠️ Architecture

- **Manifest V3**: Modern, secure Chrome Extension architecture.
- **`src/page/mainWorld.js`**: `MAIN` world `fetch` interceptor that trims ChatGPT's conversation API payloads before React renders them.
- **`src/content/index.js`**: In-page UI suite (Floating Pill, Navigator, Search, Bookmarks, Sidebar Folders, Export engine) driven by a debounced `MutationObserver`.
- **`src/popup/`**: Clean, modern light/dark popup settings dashboard.
- **DOCX engine**: Minimal ZIP writer (STORE method + CRC32) generating valid OOXML documents inline - no dependencies.

### 🧪 Tests

```bash
node tests/run.mjs
```

No dependencies and no build step. Each suite loads the **real** extension source into `node:vm` with stubbed browser globals, then drives it with a scripted network and DOM - covering payload trimming, backwards pagination, turn counting, older-message hydration, stats plumbing, temporary chats, and the top-bar Export button.

---

## 📜 Changelog

### v3.13.0
Live-verified against a real account through Chrome's remote debugging (Chrome 153, 2026-09-25).
- 🩹 **Fixed: server walks and "Full conversation (.md)" stopping after one page.** ChatGPT's current client opens a chat with `GET /backend-api/conversations/<id>?num_turns=10` and pages older history from a *separate* path, `GET /backend-api/conversations/<id>/messages?before=<start_cursor>&num_turns=10`. Every earlier strategy put the cursor on the opening URL, which the server ignores. The backward walk (turn counter, "Load more" hydration, full export) now uses the real endpoint whenever the opening request carries `num_turns`, and skips parameter guessing entirely.
- 💾 **Local archive: background history fill.** When the newest page is all the chat loaded, older pages are fetched one at a time (1.5 s apart, ChatGPT's own request shape and headers), each saved as it arrives, resuming from the oldest saved page on the next visit and stopping for the session on any refusal. Live run: all requests 200, no refusals, 90 messages and their images saved within 70 s.
- 🩹 **Fixed: the archive did nothing while the speed booster was switched off.** The interceptor passed conversation requests straight through before the archive code. With the booster off, responses are now cloned for the archive and handed to ChatGPT untouched.
- ✅ **Live results on a 285-question chat:** the background fill reached the first message (756 messages, 11/11 images) in about 7 minutes with every request answered 200; the HTML export embedded all 11 images with zero missing, zero duplicates, correct order and right-to-left Arabic. The repaired server "Full conversation (.md)" also completed (754 messages, 59 pages), but takes minutes, while the local export is instant.
- 🧹 **ChatGPT citation tokens removed from exports.** Raw ChatGPT markdown carries private-use citation markers (`U+E200 filecite … U+E201`, 262 in the test chat) that rendered as boxes and junk text. They are now stripped from the local archive exports and from the server full export.
- 🖼️ ChatGPT's own "load older messages" pages are archived too, in both booster modes. Verified image path: images are same-origin `chatgpt.com/backend-api/estuary/content?id=file_…` URLs, their ids match the API's `sediment://file_…` pointers, and `/backend-api/files/download/<id>` returns a fresh link for images never displayed.
- 🧩 **Current ChatGPT app DOM compatibility.** Turn limiting, stats, navigation and visible-message export now recognize the newer `data-turn-key` / `data-user-message-bubble` renderer, and changing Visible Messages (including `1 ↔ 2`) applies immediately without reloading the tab.
- 🧪 Added `tests/app-dom-v313.test.mjs`, covering the current renderer and the `Visible Messages = 1` hide/show contract.

### v3.12.0
- 💾 **Local conversation archive, on by default.** Exporting no longer depends on a second request to OpenAI that can be refused or cut short. The conversation payload ChatGPT already loads on open is copied to `chrome.storage.local` before trimming (all four intercepted paths: mapping tree and paginated, on open and on server export), and every new message is captured from the page once it finishes streaming. Merging is by message id: server text always wins over page-reconstructed text, an edited branch replaces the abandoned one, a message sent after the last snapshot is kept, and a "complete" response that is shorter than the archive with no new id is treated as truncated so nothing is ever lost.
- 🖼️ **Images saved locally.** Uploaded and generated images are stored as bytes while their signed URLs are valid: from the rendered page first (same-origin fetch, or the service worker for OpenAI's file host), then, for images in turns never displayed, through ChatGPT's own file download endpoint, one throttled request per missing image and never repeated once stored. Page URLs and API asset pointers resolve to the same file id, and a content hash stops the same picture being attached twice.
- 📤 **Two new instant export buttons** in the Export window: *Local archive (.html, with images)* builds one self-contained, offline HTML file with every image embedded and right-to-left text shown correctly; *Local archive (.md, text only)* marks where each image was. Both capture what is on screen first, then read only from local storage.
- ⚙️ **Popup**: new *Local Archive* toggle, archive size, and a *Delete archive* button. Backups no longer pull the archive into memory. Existing installs get the new default without losing their own settings.
- 🔒 New permissions: `unlimitedStorage` and host access to `*.oaiusercontent.com` (images only). The background image fetcher accepts only https URLs on ChatGPT/OpenAI hosts and only from the extension's own scripts. Exported HTML escapes all text and refuses any malformed image data.
- 🧪 New suite `tests/archive-v3120.test.mjs` (72 checks).

### v3.11.0
- ⚡ **Smoothness overhaul: the page can finally go idle.** Profiling a long chat showed TurboGPT itself was the biggest source of stutter. Every render pass it made (folders list, floating dock, load pill, sentinel) mutated the DOM, which re-triggered its own MutationObserver, which ran the render pass again - a permanent 350ms loop that never stopped, even with the tab sitting still. All TurboGPT-owned nodes are now tagged (`data-turbogpt`) and mutations inside or of them are ignored by the observer, so ticks only happen when ChatGPT itself changes something.
- 🧊 **No more forced layout on every tick.** The context/token meter read `innerText` of every turn on each pass (twice per tick), which forces a synchronous layout of the whole conversation. It now reads `textContent` (no layout) and memoises per-turn statistics, re-reading only the two newest turns that can still be streaming.
- 🖱️ **Scroll and wheel handlers are cheap.** The wheel listener was registered twice (window and document) and, on every upward wheel event, re-resolved the scroll container via several attribute-substring selectors plus a `getComputedStyle` walk and re-counted hidden turns with a document-wide `querySelectorAll`. Gestures now coalesce to one check per animation frame, the scroll container is cached until React replaces it, and the hidden-turn count is cached between DOM writes.
- 📁 **Sidebar folders rebuild only when something changed** (folders, current chat, or open/closed state) instead of being wiped and recreated on every tick. Also **fixed: folders could never actually be expanded** - the open flag lived on an object that was re-read from storage on every render, so it was lost immediately.
- 🎯 **Hide/show writes are idempotent.** Turn-limit enforcement used to rewrite `class` and `style` on every turn each pass; it now touches only turns whose state actually changes.
- 🌙 **Background tabs stay quiet.** While the tab is hidden, only navigation is tracked; the full render pass runs once when the tab becomes visible again.
- 🔧 **Fetch interceptor overhead trimmed** (`mainWorld.js`): the config is parsed from `localStorage` at most once per second rather than on every one of ChatGPT's many `fetch` calls; the mapping-tree walk uses `push` + `reverse` instead of quadratic `unshift`; the rewritten response now *removes* stale `content-length`/`content-encoding` headers instead of setting them to the literal string `"undefined"`.
- 🧪 New test suite `tests/perf-v3110.test.mjs` (46 checks) covers the observer filter, the caches, memoisation, idempotent hide/show and the header fix.

### v3.10.3
- 🔧 **Message Count Alert default lowered from 1200 to 120.** A real conversation of the user's was verified (via the now-fixed full export) to hit ChatGPT's actual length limit at exactly 120 user messages — dense/technical chats can exhaust the context window in far fewer turns than a casual one. Still fully configurable in the popup.

### v3.10.2
- 🩹 **Full export time budget raised from 3 to 10 minutes.** Live-tested against a real chat that hit ChatGPT's actual length limit: the 3.9.2 pagination-discovery fix correctly found the right cursor parameter and walked 296+ messages back, but the 3-minute budget cut it off before reaching the true start (`INCOMPLETE: time-budget`). The walk itself is a fixed per-page cost now that the parameter is known upfront, so a longer budget is just letting a genuinely huge, patiently-requested archive finish.

### v3.10.1
- 🩹 **Fixed: Message Count Alert froze until the page was refreshed.** It was reading only the last server-verified total, which ChatGPT does not refresh after every turn (no new GET request happens for a normal send). It now grows live from the DOM turn count as you keep chatting, plus a fixed backlog for any older history trimmed out of the DOM entirely — no refresh needed.

### v3.10.0
- 🔢 **Message Count Alert**: a new, simple message counter in the in-chat floating dock, built on the real server-verified total turn count (not a language-dependent token estimate). Fires a one-time toast when the conversation crosses a threshold you set (default 1200, configurable in the popup under "Message Count Alert") — a stable, exact companion to the more approximate context-window meter.

### v3.9.4
- ✅ **Confirmed fix, diagnostic logging turned back off.** Live-tested the 3.9.2 pagination-discovery fix against a real maxed-out conversation: "Full conversation (.md)" now reports `complete` and reaches the true start of the chat (30 messages / 2 pages, no `INCOMPLETE` flag) instead of stopping after the first page. `DEBUG_COUNT` reset to `false`.

### v3.9.3
- 🔎 **Temporary diagnostic logging enabled** (`DEBUG_COUNT = true` in `mainWorld.js`) to trace why the 3.9.2 pagination-discovery fix still stops early (`no-progress`) on some accounts after successfully finding a working parameter name for the first older page. Logs the pagination stage, page index, and cursor *field name* only - never values, headers, tokens, or message content. Meant to be flipped back to `false` once the underlying cause is confirmed.

### v3.9.2
- 🩹 **Fixed: "Full conversation (.md)" export failing on long chats with `INCOMPLETE: no-progress`.** The backward-pagination walk used to guess a single query-parameter name for "load older messages" and give up immediately if that guess was wrong (common on accounts where ChatGPT's own infinite-scroll never fires, since the speed booster disables it). It now tries every plausible parameter name once on the first page, keeps whichever one actually returns new messages, and caches that discovery so every later page - and every future export - uses it directly with no guessing and no extra requests.

### v3.9.1
- ⚡ **Real-Time Context Window & Token Consumption Meter**: Live gauge in popup displaying `% Used`, `% Left`, and estimated tokens remaining (calibrated for a 110,000 safe token window).
- 🚥 **Tri-State Status Badges**: `Healthy` (≤70%), `Heavy` (70-85%), `Critical` (>85%) with dynamic gradient progress bars.
- 🧭 **In-Chat Floating Dock Badge**: Instant percentage visibility in the floating dock with one-click token breakdown toast.
- 📈 **Server-Side Turn Extrapolation**: Accurately scales full-conversation context estimates when older pages haven't yet been loaded into DOM.
- 🎨 **Brand New 2D Flat Vector Identity**: Clean 2D speedometer gauge with custom turbocharger compressor iconography.

### v3.6.0
- 🗄️ **Export the whole conversation, even the trimmed parts.** A new *Full conversation (.md)* action fetches every turn straight from the conversation API - including messages never rendered - **without** loading them into the page, so the speed booster stays on. Built for archiving a chat that hit ChatGPT's length limit.
- 🔗 **Continuation prompt**: one click copies a ready-to-paste block containing the last N turns (default 10, configurable) plus an instruction telling the model to continue rather than restart. Pair it with the exported file to resume a maxed-out conversation in a fresh chat.
- 🧱 **Exports keep their structure now.** Extraction walks the DOM instead of flattening it with `innerText`: fenced code blocks with their language, links with their URLs, lists, tables, headings and quotes all survive. Previously everything became plain text - which also meant the `.docx` monospace/shaded code path could never trigger and the PDF's code styling was dead. Both work now.
- 🧹 ChatGPT's own UI chrome (Copy/Edit buttons, code-block language labels) is no longer captured as if it were message content.
- 🧪 Third test suite added (`tests/export.test.mjs`); the runner now covers 157 assertions.

### v3.5.0
- 🔧 **"Load More" / "Load All" actually work now.** They previously could not reveal anything beyond the first API page, so in long chats "Load All" silently did nothing. TurboGPT now fetches older pages and merges them in before rendering - using the same proven backwards-pagination path as the counter.
- ⏱️ Hydration runs **only** after an explicit click (never on a normal chat open, so zero-lag opening is unchanged), is strictly sequential, and is bounded by a 20-second budget plus a page circuit breaker. If it cannot reach the start, the chat still renders and a notice says how far it got and why.
- 🧮 The floating pill no longer invents a hidden count from one API page: it shows `N older` only when a verified-complete count exists, and counts **turns**, not backend records.
- ✅ **Test suite moved into the repo** (`node tests/run.mjs`) - 129 assertions that load the real extension source and run it against a scripted network and DOM. Still zero dependencies.

### v3.4.0
- 📤 **Export button in the chat top bar**, right beside ChatGPT's own Share button - no need to open the extension popup to export. Works in normal *and* temporary chats, and keeps working even when the turn counter is partial or unavailable.
- 🔍 **Pagination contract is now learned, not guessed**: TurboGPT reads the shape (parameter names only) of ChatGPT's own "load older messages" request before blocking it, and reuses that exact contract for background counting. Parameter names such as `cursor` / `before` / `after` are detected instead of assumed.
- 🩺 **Partial counts now say why**: the popup shows the concrete reason (`Partial - pagination cursor unavailable`, `rate limited by ChatGPT`, `server returned no older messages`, …) instead of a generic "not final".
- ♻️ Bounded retry with backoff (500ms → 1s → 2s) for `429` / `5xx` responses during counting; still strictly sequential, never a request flood, and never reported as complete after exhausting retries.

### v3.3.0
- 🔢 **Real conversation counter**: the stats ratio is now `visible user turns / total user turns` across the *whole* paginated conversation (e.g. `2 / 703`). Previously it showed backend record counts from a single API page (`6 / 14`), which never reflected the real chat size.
- 🧮 Counting runs on a separate background path: it walks the conversation's own pagination with the untouched `fetch`, counts unique user-message IDs, and **never** injects those pages into the DOM - the speed booster is unchanged.
- 🛡️ Honest count states - `Counting…`, `Partial count`, `Full count unavailable`, `recount pending`. A total is only reported as final when the walk provably reached the end with reliable de-duplication; it never guesses a cursor direction.
- 🐛 Fixed stats showing `0 / 0`: the status broadcast could be emitted before the content script was listening and was then lost. It is now recoverable on demand, and missing data renders as `- / -` (“Waiting for chat data”) instead of a fake zero total.
- 🕵️ **Temporary chat support** (`?temporary-chat=true`): export works fully without a conversation ID, with a `ChatGPT-Temporary-<date>` filename fallback; the counter reports locally-known turns, clearly labelled as local-only.
- 📊 `Memory Saved` renamed to `History Reduced` - it measures trimmed chat history, not browser RAM.

### v3.2.0
- ✅ Fixed: popup settings now persist correctly across page reloads (storage key mismatch).
- 🔒 Security: all dynamic content is escaped before DOM injection (XSS hardening); removed unused Bearer-token interception entirely.
- ⚡ Performance: replaced 2-second polling with a debounced MutationObserver; UI elements rebuild only when their state actually changes (no flicker).
- 📁 Folders: full organizer - expand/open/remove chats, rename/delete folders, auto-captured titles.
- 📄 Export: selective message export with checkboxes + genuine `.docx` generation (OOXML) with monospace code preservation; PDF export escapes content properly.
- 🎨 Full dark-mode support for navigator, search bar, and export modal.
- 📍 "Load More" restores your scroll position after reload.

---

## 📜 License

This project is licensed under the **MIT License** - free and open for personal and commercial use.
