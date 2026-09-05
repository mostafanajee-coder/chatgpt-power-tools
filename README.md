# ⚡ TurboGPT – Chat Speed Booster & Power Tools for ChatGPT

<p align="center">
  <img src="icons/icon128.png" alt="TurboGPT Logo" width="100" height="100" />
</p>

<p align="center">
  <strong>The ultimate speed accelerator and productivity toolkit for ChatGPT.</strong><br>
  Eliminate UI lag &amp; freezing in long conversations, export chats, navigate with a Table of Contents, pin important replies, and organize chats into folders.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-3.8.1-blue.svg?style=flat-square" alt="Version 3.8.1" />
  <img src="https://img.shields.io/badge/License-MIT-green.svg?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/Privacy-100%25%20Local-emerald.svg?style=flat-square" alt="100% Local" />
  <img src="https://img.shields.io/badge/Dependencies-Zero-brightgreen.svg?style=flat-square" alt="Zero dependencies" />
</p>

---

## 🌟 Key Features

### 🚀 1. Long Chat Speed Booster (Zero Lag)
- **Instant Acceleration**: Trims heavy historical messages from the browser DOM while preserving full context on ChatGPT's servers.
- **Configurable Live Auto-Trim**: By default, turns are trimmed comfortably on page load/refresh so ongoing chats are never abruptly hidden. A dedicated toggle lets users enable live instant auto-trimming as new messages arrive if preferred.
- **Smart Turn Trimming**: Automatically renders only the most recent Q&A turns for maximum typing and scrolling smoothness.
- **Strict Scroll-Lock**: Prevents unwanted infinite-scroll loading freezes when navigating up.

### 📑 2. Floating "Load More" Button
- A floating glassmorphic pill docked at the top of the chat: `↑ Load +5 older turns`.
- **In-DOM Unhiding with Scroll Anchoring**: If turns were hidden locally, loads them instantaneously without a page reload and without visual jumps.
- **Reaches real history**: Older turns are fetched from the conversation API and merged in when navigating deep history.
- **Configurable Batch Size**: Customize how many turns to load per click (2, 5, 10…) in extension settings.

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
- Rename (`✎`) or delete (`🗑`) folders — deleting a folder never deletes your chats.
- All folder data is stored locally per browser.

### 📄 8. Selective Chat Exporter
- Pick exactly which messages to export via checkboxes (select all / none supported), then export to:
  - **Microsoft Word (.docx)** — genuine OOXML document built from scratch with zero libraries; code blocks are preserved in monospace with shading.
  - **Formatted PDF** (print view)
  - **Markdown (`.md`)**
  - **Plain Text (`.txt`)**
  - **Structured JSON**
- **Structure survives**: fenced code blocks keep their language, links keep their URLs, and lists, tables, headings and quotes are preserved — not flattened into plain text.
- Selective exports cover the messages currently loaded in the chat.

### 🗄️ 9. Whole-Conversation Export & Continuation

For a chat that hit ChatGPT's length limit and won't accept new messages:

- **📚 Full conversation (.md)** — fetches *every* turn from the conversation API, including ones trimmed for speed, **without** loading them into the page. The API returns the model's original markdown, so the archive is a faithful round-trip.
- **🔗 Continuation prompt** — copies a ready-to-paste block with the last N turns (default `10`, set in the popup) plus an instruction telling the model to continue rather than restart.

Start a new chat, attach the `.md`, paste the continuation prompt, and carry on where you stopped. If the full fetch can't complete, the export says exactly how far it got and why — a partial archive is never presented as complete.

---

## 🔒 100% Private & Local-Only

- **Zero Telemetry**: No tracking, analytics, or external API servers.
- **No Token Access**: The extension never reads or stores your ChatGPT auth token.
- **Offline First**: All processing, trimming, and exports run 100% locally in your browser.
- **Minimal Permissions**: Only `storage` and `activeTab`.
- **No Account Required**: Free forever for everyone.

---

## 📥 Installation (Developer Mode / Unpacked)

1. **Clone or Download** this repository:
   ```bash
   git clone https://github.com/mostafanajee-coder/turbogpt.git
   ```
2. Open Chrome (or Edge / Brave / Opera) and navigate to `chrome://extensions`.
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** (تحميل إضافة تم فك حزمتها).
5. Select the `turbogpt` folder.
6. Navigate to [ChatGPT](https://chatgpt.com) and enjoy instant, lag-free conversations!

---

## 🛠️ Architecture

- **Manifest V3**: Modern, secure Chrome Extension architecture.
- **`src/page/mainWorld.js`**: `MAIN` world `fetch` interceptor that trims ChatGPT's conversation API payloads before React renders them.
- **`src/content/index.js`**: In-page UI suite (Floating Pill, Navigator, Search, Bookmarks, Sidebar Folders, Export engine) driven by a debounced `MutationObserver`.
- **`src/popup/`**: Clean, modern light/dark popup settings dashboard.
- **DOCX engine**: Minimal ZIP writer (STORE method + CRC32) generating valid OOXML documents inline — no dependencies.

### 🧪 Tests

```bash
node tests/run.mjs
```

No dependencies and no build step. Each suite loads the **real** extension source into `node:vm` with stubbed browser globals, then drives it with a scripted network and DOM — covering payload trimming, backwards pagination, turn counting, older-message hydration, stats plumbing, temporary chats, and the top-bar Export button.

---

## 📜 Changelog

### v3.6.0
- 🗄️ **Export the whole conversation, even the trimmed parts.** A new *Full conversation (.md)* action fetches every turn straight from the conversation API — including messages never rendered — **without** loading them into the page, so the speed booster stays on. Built for archiving a chat that hit ChatGPT's length limit.
- 🔗 **Continuation prompt**: one click copies a ready-to-paste block containing the last N turns (default 10, configurable) plus an instruction telling the model to continue rather than restart. Pair it with the exported file to resume a maxed-out conversation in a fresh chat.
- 🧱 **Exports keep their structure now.** Extraction walks the DOM instead of flattening it with `innerText`: fenced code blocks with their language, links with their URLs, lists, tables, headings and quotes all survive. Previously everything became plain text — which also meant the `.docx` monospace/shaded code path could never trigger and the PDF's code styling was dead. Both work now.
- 🧹 ChatGPT's own UI chrome (Copy/Edit buttons, code-block language labels) is no longer captured as if it were message content.
- 🧪 Third test suite added (`tests/export.test.mjs`); the runner now covers 157 assertions.

### v3.5.0
- 🔧 **"Load More" / "Load All" actually work now.** They previously could not reveal anything beyond the first API page, so in long chats "Load All" silently did nothing. TurboGPT now fetches older pages and merges them in before rendering — using the same proven backwards-pagination path as the counter.
- ⏱️ Hydration runs **only** after an explicit click (never on a normal chat open, so zero-lag opening is unchanged), is strictly sequential, and is bounded by a 20-second budget plus a page circuit breaker. If it cannot reach the start, the chat still renders and a notice says how far it got and why.
- 🧮 The floating pill no longer invents a hidden count from one API page: it shows `N older` only when a verified-complete count exists, and counts **turns**, not backend records.
- ✅ **Test suite moved into the repo** (`node tests/run.mjs`) — 129 assertions that load the real extension source and run it against a scripted network and DOM. Still zero dependencies.

### v3.4.0
- 📤 **Export button in the chat top bar**, right beside ChatGPT's own Share button — no need to open the extension popup to export. Works in normal *and* temporary chats, and keeps working even when the turn counter is partial or unavailable.
- 🔍 **Pagination contract is now learned, not guessed**: TurboGPT reads the shape (parameter names only) of ChatGPT's own "load older messages" request before blocking it, and reuses that exact contract for background counting. Parameter names such as `cursor` / `before` / `after` are detected instead of assumed.
- 🩺 **Partial counts now say why**: the popup shows the concrete reason (`Partial — pagination cursor unavailable`, `rate limited by ChatGPT`, `server returned no older messages`, …) instead of a generic "not final".
- ♻️ Bounded retry with backoff (500ms → 1s → 2s) for `429` / `5xx` responses during counting; still strictly sequential, never a request flood, and never reported as complete after exhausting retries.

### v3.3.0
- 🔢 **Real conversation counter**: the stats ratio is now `visible user turns / total user turns` across the *whole* paginated conversation (e.g. `2 / 703`). Previously it showed backend record counts from a single API page (`6 / 14`), which never reflected the real chat size.
- 🧮 Counting runs on a separate background path: it walks the conversation's own pagination with the untouched `fetch`, counts unique user-message IDs, and **never** injects those pages into the DOM — the speed booster is unchanged.
- 🛡️ Honest count states — `Counting…`, `Partial count`, `Full count unavailable`, `recount pending`. A total is only reported as final when the walk provably reached the end with reliable de-duplication; it never guesses a cursor direction.
- 🐛 Fixed stats showing `0 / 0`: the status broadcast could be emitted before the content script was listening and was then lost. It is now recoverable on demand, and missing data renders as `— / —` (“Waiting for chat data”) instead of a fake zero total.
- 🕵️ **Temporary chat support** (`?temporary-chat=true`): export works fully without a conversation ID, with a `ChatGPT-Temporary-<date>` filename fallback; the counter reports locally-known turns, clearly labelled as local-only.
- 📊 `Memory Saved` renamed to `History Reduced` — it measures trimmed chat history, not browser RAM.

### v3.2.0
- ✅ Fixed: popup settings now persist correctly across page reloads (storage key mismatch).
- 🔒 Security: all dynamic content is escaped before DOM injection (XSS hardening); removed unused Bearer-token interception entirely.
- ⚡ Performance: replaced 2-second polling with a debounced MutationObserver; UI elements rebuild only when their state actually changes (no flicker).
- 📁 Folders: full organizer — expand/open/remove chats, rename/delete folders, auto-captured titles.
- 📄 Export: selective message export with checkboxes + genuine `.docx` generation (OOXML) with monospace code preservation; PDF export escapes content properly.
- 🎨 Full dark-mode support for navigator, search bar, and export modal.
- 📍 "Load More" restores your scroll position after reload.

---

## 📜 License

This project is licensed under the **MIT License** — free and open for personal and commercial use.
