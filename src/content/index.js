/**
 * TurboGPT - Content Script & In-Page Productivity Suite
 * 100% Original, Clean Architecture
 */

(() => {
  const SETTINGS_KEY = "turbogpt_settings";
  const CONFIG_KEY = "turbogpt_config";
  const EXTRA_KEY = "turbogpt_extra_turns";
  const FOLDERS_KEY = "turbogpt_folders";
  const BOOKMARKS_PREFIX = "turbogpt_bookmarks_";
  const CACHED_STATS_KEY = "turbogpt_cached_stats";
  const SCROLL_RESTORE_KEY = "turbogpt_restore_scroll";

  let appSettings = {
    enabled: true,
    messageLimit: 15,
    loadBatchSize: 5,
    continuationTurns: 10,
    enableFloatingButton: true,
    enableOutline: true,
    enableSearch: true,
    enableFolders: true,
    liveAutoTrim: false,
    disableNotifications: false
  };

  const STATUS_SESSION_KEY = "turbogpt_last_status";

  // Debug only. Ids/counts/state names - never message content or headers.
  const DEBUG_STATS = false;

  let lastStatus = {
    totalMessages: 0,
    renderedMessages: 0,
    hasOlderMessages: false,
    visibleTurns: 0,
    totalTurns: 0,
    countState: "idle",
    countComplete: false
  };
  // False until mainWorld has actually reported something. Without this, an
  // absent status is indistinguishable from a real empty conversation.
  let statusReceived = false;

  // ---------- Utilities ----------

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);

  const safeEscape = (val) =>
    (typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(val) : String(val).replace(/["\\]/g, "\\$&"));

  function safeJsonParse(raw, fallback) {
    try {
      const v = JSON.parse(raw);
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  function getConversationId() {
    const match = window.location.pathname.match(/\/c\/([^/]+)/);
    return match ? match[1] : null;
  }

  // A temporary chat has no /c/<id> and is not persisted server-side.
  function isTemporaryChat() {
    try {
      if (new URL(window.location.href).searchParams.get("temporary-chat") === "true") return true;
    } catch {}
    return false;
  }

  // Identity used to keep stats/reset boundaries correct in BOTH modes.
  // Temporary chats get a session-local identity so one temporary chat can
  // never inherit another one's numbers, and a normal chat can never inherit
  // a temporary one's.
  let temporarySessionId = null;
  function getStatsScopeId() {
    if (isTemporaryChat()) {
      if (!temporarySessionId) {
        temporarySessionId = `temporary:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
      return temporarySessionId;
    }
    temporarySessionId = null;
    return getConversationId();
  }

  function countDomUserTurns() {
    return document.querySelectorAll('[data-message-author-role="user"]').length;
  }

  function timestampSlug() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function cleanTitle() {
    const raw = document.title.replace(/\s*-\s*ChatGPT.*$/i, "").trim();
    // Temporary chats usually carry no real title (document.title stays the
    // bare app name) - never let that fail or genericise the export filename.
    if (isTemporaryChat() && (!raw || /^chatgpt$/i.test(raw))) {
      return `ChatGPT-Temporary-${timestampSlug()}`;
    }
    if (raw) return raw;
    return "ChatGPT Conversation";
  }

  function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80).trim() || "chatgpt-export";
  }

  function toast(message) {
    const t = document.createElement("div");
    t.className = "turbogpt-toast";
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2400);
  }

  // Load and sync settings
  function loadSettings() {
    try {
      const syncRaw = localStorage.getItem(CONFIG_KEY);
      if (syncRaw) {
        const parsed = JSON.parse(syncRaw);
        if (parsed.messageLimit) appSettings.messageLimit = parsed.messageLimit;
        if (parsed.enabled !== undefined) appSettings.enabled = parsed.enabled;
      }
    } catch {}

    try {
      chrome.storage.local.get(SETTINGS_KEY, (res) => {
        if (res && res[SETTINGS_KEY]) {
          appSettings = { ...appSettings, ...res[SETTINGS_KEY] };
        }
        try {
          localStorage.setItem(CONFIG_KEY, JSON.stringify({
            enabled: appSettings.enabled,
            messageLimit: appSettings.messageLimit
          }));
        } catch {}
        renderAllTools();
      });
    } catch {
      renderAllTools();
    }
    restoreScrollIfPending();
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[SETTINGS_KEY]) {
        const newSettings = changes[SETTINGS_KEY].newValue;
        if (newSettings) {
          appSettings = { ...appSettings, ...newSettings };
          try {
            localStorage.setItem(CONFIG_KEY, JSON.stringify({
              enabled: appSettings.enabled,
              messageLimit: appSettings.messageLimit
            }));
            localStorage.removeItem(EXTRA_KEY);
          } catch {}
          manuallyUnhiddenTurnsCount = 0;
          resetRenderCaches();
          renderAllTools();
        }
      }
    });
  } catch {}

  let hydrationNoticeShown = false;

  function adoptStatus(payload, source) {
    if (!payload || typeof payload !== "object") return false;
    lastStatus = payload;
    statusReceived = true;

    // "Load older" ran but could not reach the start - say so once, rather
    // than silently showing fewer turns than the user asked for.
    if (!hydrationNoticeShown && payload.hydratedPages > 0 && payload.hydrationFailureReason) {
      hydrationNoticeShown = true;
      toast(`Loaded ${payload.hydratedPages} older page(s) — could not load further (${payload.hydrationFailureReason})`);
    }
    if (DEBUG_STATS) {
      try {
        console.debug("[TurboGPT Stats Debug] content", {
          source,
          receivedConversationId: payload.conversationId,
          currentPageConversationId: getConversationId(),
          visibleTurns: payload.visibleTurns,
          totalTurns: payload.totalTurns,
          countState: payload.countState,
          accepted: true
        });
      } catch {}
    }
    try {
      chrome.storage.local.set({ [CACHED_STATS_KEY]: { url: window.location.href, stats: payload } });
    } catch {}
    renderFloatingLoadButton();
    updateOutlineBadge();
    return true;
  }

  // Listen to messages from popup and mainWorld
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;

    if (e.data && e.data.type === "turbogpt-full-export") {
      const waiters = fullExportWaiters;
      fullExportWaiters = [];
      waiters.forEach((w) => { if (!w.done) { w.done = true; w.resolve(e.data.payload || {}); } });
      return;
    }
    if (e.data && e.data.type === "turbogpt-full-export-progress") {
      const el = document.getElementById("turbogpt-full-progress");
      if (el && e.data.payload) {
        el.textContent = `Fetching… ${e.data.payload.turns} turns from ${e.data.payload.pages} pages`;
      }
      return;
    }

    if (e.data && e.data.type === "turbogpt-status") {
      try {
        sessionStorage.setItem(STATUS_SESSION_KEY, JSON.stringify(e.data.payload));
      } catch {}
      adoptStatus(e.data.payload, "postMessage");
    }
  });

  // mainWorld broadcasts at document_start; this script starts at
  // document_idle, so the first broadcast can be missed entirely. Recover it
  // from the session mirror, and ask mainWorld to re-send.
  function recoverStatus() {
    if (!statusReceived) {
      let mirrored = null;
      try {
        mirrored = safeJsonParse(sessionStorage.getItem(STATUS_SESSION_KEY), null);
      } catch {}
      if (mirrored && mirrored.url === window.location.href) {
        adoptStatus(mirrored, "sessionStorage");
      }
    }
    try {
      window.postMessage({ type: "turbogpt-request-status" }, "*");
    } catch {}
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "getStats") {
      // Temporary chats have no server-side history to page through: report
      // what is known locally, explicitly labelled as such.
      const hiddenUserTurns = document.querySelectorAll('.turbogpt-dom-hidden [data-message-author-role="user"], .turbogpt-dom-hidden[data-message-author-role="user"]').length;

      if (isTemporaryChat()) {
        const localTurns = countDomUserTurns();
        const baseVisible = Number.isFinite(lastStatus.visibleTurns) && statusReceived
          ? lastStatus.visibleTurns
          : localTurns;
        const visible = appSettings.enabled && hiddenUserTurns > 0
          ? Math.max(1, baseVisible - hiddenUserTurns)
          : baseVisible;
        sendResponse({
          available: true,
          visibleTurns: visible,
          totalTurns: localTurns,
          countState: "local-only",
          countComplete: false,
          totalMessages: lastStatus.totalMessages,
          renderedMessages: lastStatus.renderedMessages,
          hasOlderMessages: lastStatus.hasOlderMessages
        });
        return true;
      }

      // Reject a previous conversation's numbers ONLY when both ids exist and
      // genuinely differ. A missing id is "not known yet", never a mismatch -
      // treating it as one is what turned real stats into 0 / 0.
      const pageId = getConversationId();
      const statusId = lastStatus.conversationId;
      const definitelyStale = !!pageId && !!statusId && pageId !== statusId;

      if (!statusReceived || definitelyStale) {
        if (DEBUG_STATS) {
          try {
            console.debug("[TurboGPT Stats Debug] content", {
              receivedConversationId: statusId,
              currentPageConversationId: pageId,
              accepted: false,
              rejectionReason: !statusReceived ? "no-status-yet" : "conversation-mismatch"
            });
          } catch {}
        }
        // Not "zero turns" - "not known yet". The popup must not render this
        // as a real total.
        sendResponse({
          available: false,
          countState: definitelyStale ? "switching" : "initializing"
        });
        recoverStatus();
        return true;
      }

      const reportedVisible = (appSettings.enabled && hiddenUserTurns > 0 && Number.isFinite(lastStatus.visibleTurns))
        ? Math.max(1, lastStatus.visibleTurns - hiddenUserTurns)
        : lastStatus.visibleTurns;

      sendResponse({
        available: true,
        totalMessages: lastStatus.totalMessages,
        renderedMessages: lastStatus.renderedMessages,
        hasOlderMessages: lastStatus.hasOlderMessages,
        visibleTurns: reportedVisible,
        totalTurns: lastStatus.totalTurns,
        countState: lastStatus.countState,
        countComplete: lastStatus.countComplete,
        countFailureReason: lastStatus.countFailureReason,
        countContractSource: lastStatus.countContractSource
      });
      return true;
    }
    if (request.type === "syncSettings") {
      appSettings = { ...appSettings, ...request.settings };
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify({
          enabled: appSettings.enabled,
          messageLimit: appSettings.messageLimit
        }));
        localStorage.removeItem(EXTRA_KEY);
      } catch {}
      manuallyUnhiddenTurnsCount = 0;
      initialEnforcementDone = false;
      resetRenderCaches();
      renderAllTools();
      return true;
    }
    if (request.type === "exportChat") {
      openExportModal();
      return true;
    }
  });

  // Inject CSS Styles
  function injectStyles() {
    if (document.getElementById("turbogpt-styles")) return;
    const style = document.createElement("style");
    style.id = "turbogpt-styles";
    style.textContent = `
      .turbogpt-floating-pill {
        position: relative;
        z-index: 10;
        margin: 16px auto 20px;
        display: flex;
        align-items: center;
        gap: 8px;
        background: rgba(255, 255, 255, 0.94);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(99, 102, 241, 0.25);
        box-shadow: 0 4px 16px -2px rgba(99, 102, 241, 0.15), 0 2px 6px rgba(0,0,0,0.04);
        padding: 6px 14px;
        border-radius: 9999px;
        width: fit-content;
        animation: turbogptFadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        user-select: none;
      }
      @media (prefers-color-scheme: dark) {
        .turbogpt-floating-pill {
          background: rgba(30, 41, 59, 0.94);
          border-color: rgba(99, 102, 241, 0.4);
          box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.4);
        }
      }
      .turbogpt-pill-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        background: linear-gradient(135deg, #6366f1, #3b82f6);
        color: #ffffff !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        font-weight: 700;
        border: none;
        border-radius: 9999px;
        padding: 5px 12px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .turbogpt-pill-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
      }
      .turbogpt-pill-badge {
        background: rgba(255, 255, 255, 0.25);
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 9999px;
      }
      .turbogpt-pill-all {
        color: #6366f1;
        font-size: 11.5px;
        font-weight: 600;
        cursor: pointer;
        background: transparent;
        border: none;
        padding: 4px 6px;
        border-radius: 6px;
        transition: all 0.15s;
      }
      .turbogpt-pill-all:hover {
        background: rgba(99, 102, 241, 0.1);
        text-decoration: underline;
      }

      /* Floating Outline & Tools Dock */
      .turbogpt-floating-dock {
        position: fixed;
        right: 18px;
        bottom: 80px;
        z-index: 10000;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .turbogpt-dock-btn {
        width: 42px;
        height: 42px;
        border-radius: 50%;
        background: #ffffff;
        border: 1px solid rgba(226, 232, 240, 0.9);
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
        color: #4f46e5;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        position: relative;
      }
      .turbogpt-dock-btn:hover {
        transform: scale(1.08) translateY(-2px);
        box-shadow: 0 10px 24px rgba(99, 102, 241, 0.25);
        border-color: #818cf8;
      }
      .turbogpt-dock-badge {
        position: absolute;
        top: -3px;
        right: -3px;
        background: linear-gradient(135deg, #10b981, #059669);
        color: white;
        font-size: 9px;
        font-weight: 800;
        padding: 2px 5px;
        border-radius: 9999px;
        border: 2px solid #ffffff;
      }

      /* Outline Drawer */
      .turbogpt-outline-drawer {
        position: fixed;
        right: 20px;
        bottom: 135px;
        width: 320px;
        max-height: 520px;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 16px;
        box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0,0,0,0.03);
        z-index: 10001;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: turbogptSlideIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .turbogpt-drawer-header {
        padding: 12px 14px;
        border-bottom: 1px solid #f1f5f9;
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #f8fafc;
      }
      .turbogpt-drawer-title {
        font-size: 13px;
        font-weight: 800;
        color: #0f172a;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .turbogpt-drawer-tabs {
        display: flex;
        background: #e2e8f0;
        padding: 2px;
        border-radius: 8px;
        margin: 8px 12px 0;
      }
      .turbogpt-drawer-tab {
        flex: 1;
        text-align: center;
        font-size: 11px;
        font-weight: 700;
        padding: 4px 8px;
        border-radius: 6px;
        cursor: pointer;
        border: none;
        background: transparent;
        color: #64748b;
        transition: all 0.15s;
      }
      .turbogpt-drawer-tab.active {
        background: #ffffff;
        color: #4f46e5;
        box-shadow: 0 2px 4px rgba(0,0,0,0.05);
      }
      .turbogpt-drawer-list {
        padding: 10px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 380px;
      }
      .turbogpt-toc-item {
        padding: 8px 10px;
        background: #f8fafc;
        border: 1px solid #f1f5f9;
        border-radius: 8px;
        font-size: 12px;
        color: #334155;
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .turbogpt-toc-item:hover {
        background: #eef2ff;
        border-color: #c7d2fe;
        color: #4338ca;
        transform: translateX(-2px);
      }
      .turbogpt-toc-num {
        font-weight: 800;
        font-size: 10px;
        color: #6366f1;
        background: #e0e7ff;
        padding: 1px 5px;
        border-radius: 4px;
        margin-top: 1px;
      }
      .turbogpt-toc-item.turbogpt-toc-hidden {
        opacity: 0.65;
        background: #f1f5f9;
        border-style: dashed;
      }
      .turbogpt-toc-item.turbogpt-toc-hidden:hover {
        opacity: 1;
        background: #fee2e2;
        border-color: #fca5a5;
      }

      /* Hidden turns by limit enforcer */
      .turbogpt-dom-hidden {
        display: none !important;
      }

      /* In-Chat Search Bar & Full History Panel */
      .turbogpt-search-overlay {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10002;
        background: rgba(255, 255, 255, 0.98);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid #cbd5e1;
        border-radius: 14px;
        box-shadow: 0 20px 45px -8px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0,0,0,0.05);
        padding: 10px 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        animation: turbogptFadeIn 0.2s ease;
        width: 480px;
        max-width: 92vw;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      @media (prefers-color-scheme: dark) {
        .turbogpt-search-overlay {
          background: rgba(30, 41, 59, 0.98);
          border-color: #334155;
          color: #f8fafc;
        }
      }
      .turbogpt-search-bar-row {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
      }
      .turbogpt-search-input {
        border: none;
        outline: none;
        font-size: 13px;
        font-weight: 500;
        color: #0f172a;
        flex: 1;
        background: transparent;
      }
      @media (prefers-color-scheme: dark) {
        .turbogpt-search-input {
          color: #f8fafc;
        }
      }
      .turbogpt-search-mode-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10.5px;
        font-weight: 700;
        padding: 4px 8px;
        border-radius: 6px;
        border: 1px solid #e0e7ff;
        background: #eef2ff;
        color: #4f46e5;
        cursor: pointer;
        user-select: none;
        transition: all 0.15s;
        white-space: nowrap;
      }
      .turbogpt-search-mode-pill:hover {
        border-color: #6366f1;
      }
      .turbogpt-search-mode-pill.active {
        background: #6366f1;
        color: #ffffff;
        border-color: #4f46e5;
      }
      .turbogpt-search-btn {
        background: #f1f5f9;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        padding: 3px 8px;
        font-size: 12px;
        cursor: pointer;
        color: #475569;
        transition: all 0.15s;
      }
      .turbogpt-search-btn:hover {
        background: #e2e8f0;
        color: #0f172a;
      }
      @media (prefers-color-scheme: dark) {
        .turbogpt-search-btn {
          background: #334155;
          border-color: #475569;
          color: #cbd5e1;
        }
        .turbogpt-search-btn:hover {
          background: #475569;
          color: #ffffff;
        }
      }
      .turbogpt-search-results-panel {
        max-height: 290px;
        overflow-y: auto;
        border-top: 1px solid #f1f5f9;
        padding-top: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      @media (prefers-color-scheme: dark) {
        .turbogpt-search-results-panel {
          border-top-color: #334155;
        }
      }
      .turbogpt-search-item {
        padding: 8px 12px;
        border-radius: 8px;
        background: #f8fafc;
        border: 1px solid #f1f5f9;
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        flex-direction: column;
        gap: 4px;
        text-align: left;
      }
      @media (prefers-color-scheme: dark) {
        .turbogpt-search-item {
          background: #0f172a;
          border-color: #1e293b;
        }
      }
      .turbogpt-search-item:hover {
        background: #eef2ff;
        border-color: #c7d2fe;
        transform: translateX(2px);
      }
      .turbogpt-search-item.active {
        background: #e0e7ff;
        border-color: #6366f1;
        box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.2);
      }
      @media (prefers-color-scheme: dark) {
        .turbogpt-search-item:hover {
          background: #1e1b4b;
          border-color: #4338ca;
        }
        .turbogpt-search-item.active {
          background: #312e81;
          border-color: #818cf8;
          box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.3);
        }
      }
      .turbogpt-search-item-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        font-weight: 700;
      }
      .turbogpt-search-role {
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 10px;
        font-weight: 800;
        text-transform: uppercase;
      }
      .turbogpt-search-role.user {
        background: #e0e7ff;
        color: #4338ca;
      }
      .turbogpt-search-role.assistant {
        background: #dcfce7;
        color: #15803d;
      }
      .turbogpt-search-snippet {
        font-size: 12px;
        line-height: 1.45;
        color: #334155;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      @media (prefers-color-scheme: dark) {
        .turbogpt-search-snippet {
          color: #cbd5e1;
        }
      }
      .turbogpt-search-mark {
        background: #fef08a;
        color: #854d0e;
        font-weight: 800;
        padding: 1px 3px;
        border-radius: 3px;
      }
      .turbogpt-preview-card {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 520px;
        max-width: 90vw;
        max-height: 80vh;
        background: #ffffff;
        border-radius: 16px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35);
        z-index: 10003;
        display: flex;
        flex-direction: column;
        padding: 16px;
        gap: 12px;
        font-family: inherit;
        animation: turbogptFadeIn 0.2s ease;
      }
      @media (prefers-color-scheme: dark) {
        .turbogpt-preview-card {
          background: #1e293b;
          color: #f8fafc;
        }
      }
      .turbogpt-preview-content {
        overflow-y: auto;
        font-size: 13px;
        line-height: 1.6;
        white-space: pre-wrap;
        padding: 12px;
        background: #f8fafc;
        border-radius: 10px;
        border: 1px solid #e2e8f0;
      }
      @media (prefers-color-scheme: dark) {
        .turbogpt-preview-content {
          background: #0f172a;
          border-color: #334155;
          color: #e2e8f0;
        }
      }

      /* Turn Highlight Animation */
      @keyframes turbogptHighlightPulse {
        0% { outline: 3px solid #6366f1; box-shadow: 0 0 20px rgba(99, 102, 241, 0.6); }
        70% { outline: 3px solid #6366f1; box-shadow: 0 0 20px rgba(99, 102, 241, 0.6); }
        100% { outline: 3px solid transparent; box-shadow: none; }
      }
      .turbogpt-highlight-turn {
        animation: turbogptHighlightPulse 2.2s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
        border-radius: 12px;
      }

      /* ⭐️ Bookmark Button */
      .turbogpt-bookmark-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 4px 6px;
        border-radius: 6px;
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .turbogpt-bookmark-btn:hover {
        color: #eab308;
        background: rgba(234, 179, 8, 0.1);
      }
      .turbogpt-bookmark-btn.active {
        color: #eab308;
      }

      /* Sidebar Folders Container */
      .turbogpt-sidebar-folders {
        margin: 10px 10px 14px;
        padding: 8px 10px;
        background: rgba(0, 0, 0, 0.04);
        border: 1px solid rgba(0, 0, 0, 0.06);
        border-radius: 10px;
        font-family: inherit;
        user-select: none;
      }
      @media (prefers-color-scheme: dark) {
        .turbogpt-sidebar-folders {
          background: rgba(255, 255, 255, 0.04);
          border-color: rgba(255, 255, 255, 0.08);
        }
      }
      .turbogpt-folder-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        font-weight: 700;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
      }
      .turbogpt-add-folder-btn {
        background: none;
        border: none;
        color: #6366f1;
        font-weight: 800;
        cursor: pointer;
        font-size: 14px;
      }
      .turbogpt-folder-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
        color: inherit;
        transition: background 0.15s;
      }
      .turbogpt-folder-item:hover {
        background: rgba(99, 102, 241, 0.1);
      }
      .turbogpt-folder-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: start;
      }
      .turbogpt-folder-count {
        font-size: 10px;
        opacity: 0.6;
      }
      .turbogpt-folder-actions {
        display: none;
        align-items: center;
        gap: 2px;
      }
      .turbogpt-folder-item:hover .turbogpt-folder-actions {
        display: inline-flex;
      }
      .turbogpt-folder-action-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 11px;
        padding: 1px 4px;
        border-radius: 4px;
        color: #94a3b8;
        line-height: 1;
      }
      .turbogpt-folder-action-btn:hover {
        background: rgba(99, 102, 241, 0.15);
        color: #4f46e5;
      }
      .turbogpt-folder-chat {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px 4px 22px;
        border-radius: 6px;
        font-size: 11.5px;
        cursor: pointer;
        color: inherit;
        text-decoration: none;
        overflow: hidden;
      }
      .turbogpt-folder-chat:hover {
        background: rgba(99, 102, 241, 0.12);
      }
      .turbogpt-folder-chat-title {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .turbogpt-folder-chat-remove {
        visibility: hidden;
        background: none;
        border: none;
        cursor: pointer;
        color: #cbd5e1;
        font-size: 10px;
        padding: 0 3px;
      }
      .turbogpt-folder-chat:hover .turbogpt-folder-chat-remove {
        visibility: visible;
      }
      .turbogpt-folder-chat-remove:hover {
        color: #ef4444;
      }
      .turbogpt-folders-empty {
        font-size: 10.5px;
        color: #94a3b8;
        padding: 4px 8px;
      }

      /* Export Modal */
      .turbogpt-modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(15, 23, 42, 0.6);
        backdrop-filter: blur(4px);
        z-index: 20000;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: turbogptFadeIn 0.2s ease;
      }
      .turbogpt-modal-box {
        background: #ffffff;
        border-radius: 18px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
        width: 480px;
        max-width: 92vw;
        max-height: 86vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .turbogpt-modal-header {
        padding: 16px 20px;
        border-bottom: 1px solid #f1f5f9;
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #f8fafc;
      }
      .turbogpt-modal-title {
        font-size: 15px;
        font-weight: 800;
        color: #0f172a;
      }
      .turbogpt-modal-body {
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        overflow-y: auto;
      }
      .turbogpt-select-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        font-size: 12px;
        color: #334155;
        cursor: pointer;
      }
      .turbogpt-select-row:hover {
        border-color: #c7d2fe;
        background: #eef2ff;
      }
      .turbogpt-select-role {
        font-size: 10px;
        font-weight: 800;
        padding: 1px 6px;
        border-radius: 4px;
        white-space: nowrap;
      }
      .turbogpt-select-role.user { background: #e0e7ff; color: #4338ca; }
      .turbogpt-select-role.chatgpt { background: #d1fae5; color: #047857; }
      .turbogpt-select-text {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .turbogpt-export-grid {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .turbogpt-export-option-btn {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        cursor: pointer;
        font-weight: 700;
        font-size: 13px;
        color: #1e293b;
        transition: all 0.15s;
      }
      .turbogpt-export-option-btn:hover:not(:disabled) {
        background: #eef2ff;
        border-color: #818cf8;
        color: #4338ca;
        transform: translateY(-1px);
      }
      .turbogpt-export-option-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .turbogpt-link-btn {
        background: none;
        border: none;
        color: #6366f1;
        font-size: 11.5px;
        font-weight: 700;
        cursor: pointer;
        padding: 0;
      }
      .turbogpt-link-btn:hover { text-decoration: underline; }

      /* Top-bar Export button (beside ChatGPT's Share) */
      .turbogpt-topbar-export {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 36px;
        padding: 0 12px;
        margin: 0 6px;
        border: 1px solid rgba(0, 0, 0, 0.12);
        border-radius: 9999px;
        background: transparent;
        color: inherit;
        font-size: 14px;
        font-weight: 500;
        font-family: inherit;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .turbogpt-topbar-export:hover {
        background: rgba(0, 0, 0, 0.05);
        border-color: rgba(0, 0, 0, 0.2);
      }
      .turbogpt-topbar-export:focus-visible {
        outline: 2px solid #6366f1;
        outline-offset: 2px;
      }
      @media (max-width: 640px) {
        .turbogpt-topbar-export span { display: none; }
        .turbogpt-topbar-export { padding: 0 10px; }
      }

      /* Whole-conversation export box */
      .turbogpt-full-export-box {
        border: 1px dashed #c7d2fe;
        background: #f5f7ff;
        border-radius: 10px;
        padding: 10px 12px;
      }
      .turbogpt-full-export-title {
        font-size: 12px;
        font-weight: 800;
        color: #4338ca;
        margin-bottom: 4px;
      }
      .turbogpt-full-export-hint {
        font-size: 11px;
        color: #64748b;
        line-height: 1.5;
      }

      /* Toast */
      .turbogpt-toast {
        position: fixed;
        bottom: 28px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 30000;
        background: rgba(15, 23, 42, 0.92);
        color: #f1f5f9;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        font-weight: 600;
        padding: 9px 16px;
        border-radius: 9999px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
        animation: turbogptFadeIn 0.2s ease;
        pointer-events: none;
        white-space: nowrap;
      }

      /* ===== Dark mode (full support) ===== */
      @media (prefers-color-scheme: dark) {
        .turbogpt-dock-btn {
          background: #1e293b;
          border-color: rgba(255, 255, 255, 0.1);
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
          color: #818cf8;
        }
        .turbogpt-dock-badge { border-color: #1e293b; }
        .turbogpt-outline-drawer {
          background: #1e293b;
          border-color: #334155;
        }
        .turbogpt-drawer-header { background: #0f172a; border-bottom-color: #334155; }
        .turbogpt-drawer-title { color: #f1f5f9; }
        .turbogpt-drawer-tabs { background: #334155; }
        .turbogpt-drawer-tab { color: #94a3b8; }
        .turbogpt-drawer-tab.active { background: #1e293b; color: #a5b4fc; }
        .turbogpt-toc-item {
          background: #0f172a;
          border-color: #1e293b;
          color: #cbd5e1;
        }
        .turbogpt-toc-item:hover {
          background: #1e293b;
          border-color: #4338ca;
          color: #c7d2fe;
        }
        .turbogpt-toc-item.turbogpt-toc-hidden {
          background: #090d16;
          border-color: #334155;
          opacity: 0.6;
        }
        .turbogpt-toc-item.turbogpt-toc-hidden:hover {
          background: #3b0764;
          border-color: #7e22ce;
          opacity: 1;
        }
        .turbogpt-toc-num { background: #312e81; color: #c7d2fe; }
        .turbogpt-search-overlay {
          background: #1e293b;
          border-color: #475569;
        }
        .turbogpt-search-input { color: #f1f5f9; }
        .turbogpt-search-btn {
          background: #334155;
          border-color: #475569;
          color: #cbd5e1;
        }
        .turbogpt-search-btn:hover { background: #475569; color: #f8fafc; }
        .turbogpt-modal-box { background: #1e293b; }
        .turbogpt-modal-header { background: #0f172a; border-bottom-color: #334155; }
        .turbogpt-modal-title { color: #f1f5f9; }
        .turbogpt-select-row {
          background: #0f172a;
          border-color: #334155;
          color: #cbd5e1;
        }
        .turbogpt-select-row:hover { background: #1e293b; border-color: #4338ca; }
        .turbogpt-export-option-btn {
          background: #0f172a;
          border-color: #334155;
          color: #e2e8f0;
        }
        .turbogpt-export-option-btn:hover:not(:disabled) {
          background: #1e293b;
          border-color: #6366f1;
          color: #c7d2fe;
        }
        .turbogpt-close-x { color: #94a3b8 !important; }
        .turbogpt-full-export-box { background: #0f172a; border-color: #4338ca; }
        .turbogpt-full-export-title { color: #c7d2fe; }
        .turbogpt-full-export-hint { color: #94a3b8; }
        .turbogpt-topbar-export { border-color: rgba(255, 255, 255, 0.18); }
        .turbogpt-topbar-export:hover {
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.3);
        }
      }

      @keyframes turbogptFadeIn {
        from { opacity: 0; transform: translateY(-6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes turbogptSlideIn {
        from { opacity: 0; transform: translateY(12px) scale(0.96); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
    `;
    document.head.appendChild(style);
  }

  // Resilient element queries (Self-Healing Selectors)
  function getChatScrollContainer() {
    return document.querySelector('main [class*="react-scroll-to-bottom"]') ||
           document.querySelector('main div[class*="overflow-y-auto"]') ||
           document.querySelector('main [role="presentation"]') ||
           document.querySelector('main');
  }

  function getAllConversationTurns() {
    let turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn"]'));
    if (turns.length > 0) return turns;

    turns = Array.from(document.querySelectorAll('article'));
    if (turns.length > 0) return turns;

    const roles = Array.from(document.querySelectorAll('[data-message-author-role], [data-message-id]'));
    if (roles.length > 0) {
      const parentTurns = new Set();
      roles.forEach((r) => {
        const parent = r.closest('article') || r.closest('[class*="conversation-turn"]') || r.closest('[data-testid^="conversation-turn"]') || r.parentElement;
        if (parent) parentTurns.add(parent);
      });
      if (parentTurns.size > 0) return Array.from(parentTurns);
    }

    return Array.from(document.querySelectorAll('main div[class*="agent-turn"], main div[class*="user-turn"], div[class*="group/conversation-turn"]'));
  }

  function getTurnItemContainer(turn) {
    if (turn.parentElement && turn.parentElement.parentElement?.classList?.contains("qMYqUG_convSearchResultHighlightRoot")) {
      return turn.parentElement;
    }
    return turn;
  }

  // Active DOM Turn Enforcer:
  // Enforces visible message limit (e.g. 2). When liveAutoTrim is false,
  // limits are enforced on page load/refresh or chat navigation only, so ongoing
  // chat sessions do not abruptly hide new messages under the user's eyes.
  let manuallyUnhiddenTurnsCount = 0;
  let initialEnforcementDone = false;

  function enforceDomTurnLimit(options = {}) {
    const isLiveUpdate = options.live === true;
    if (isLiveUpdate && !appSettings.liveAutoTrim && initialEnforcementDone) {
      updateOutlineBadge();
      return;
    }

    if (!appSettings.enabled) {
      document.querySelectorAll(".turbogpt-dom-hidden").forEach((el) => {
        el.classList.remove("turbogpt-dom-hidden");
        el.style.removeProperty("display");
      });
      const root = document.querySelector(".qMYqUG_convSearchResultHighlightRoot");
      if (root) {
        Array.from(root.children).forEach((c) => {
          c.classList.remove("turbogpt-dom-hidden");
          c.style.removeProperty("display");
        });
      }
      updateOutlineBadge();
      return;
    }

    const turns = getAllConversationTurns();
    if (turns.length === 0) return;

    const userTurns = [];
    turns.forEach((turn, idx) => {
      if (turn.querySelector('[data-message-author-role="user"]') || turn.getAttribute('data-message-author-role') === 'user') {
        userTurns.push(idx);
      }
    });

    const effectiveLimit = Math.max(1, (appSettings.messageLimit || 15) + manuallyUnhiddenTurnsCount);

    // Each conversation exchange starts with a user prompt.
    // Preserving the last N user prompts guarantees the user's question is never hidden
    // from the visible conversation round.
    let cutoffIdx = 0;
    if (userTurns.length > 0) {
      cutoffIdx = userTurns.length > effectiveLimit ? userTurns[userTurns.length - effectiveLimit] : 0;
    } else {
      const exchangeLimit = effectiveLimit * 2;
      cutoffIdx = turns.length > exchangeLimit ? turns.length - exchangeLimit : 0;
    }

    if (cutoffIdx > 0) {
      turns.forEach((turn, idx) => {
        const container = getTurnItemContainer(turn);
        if (idx < cutoffIdx) {
          turn.classList.add("turbogpt-dom-hidden");
          turn.style.setProperty("display", "none", "important");
          if (container !== turn) {
            container.classList.add("turbogpt-dom-hidden");
            container.style.setProperty("display", "none", "important");
          }
        } else {
          turn.classList.remove("turbogpt-dom-hidden");
          turn.style.removeProperty("display");
          if (container !== turn) {
            container.classList.remove("turbogpt-dom-hidden");
            container.style.removeProperty("display");
          }
        }
      });

      // Handle ChatGPT virtualizer spacers inside .qMYqUG_convSearchResultHighlightRoot
      const root = document.querySelector(".qMYqUG_convSearchResultHighlightRoot");
      if (root) {
        const children = Array.from(root.children);
        const firstVisibleIdx = children.findIndex((c) =>
          !c.classList.contains("turbogpt-dom-hidden") &&
          c.querySelector('[data-testid^="conversation-turn"]:not(.turbogpt-dom-hidden)')
        );
        if (firstVisibleIdx > 0) {
          children.forEach((c, i) => {
            if (i < firstVisibleIdx && !c.querySelector('[data-testid^="conversation-turn"]:not(.turbogpt-dom-hidden)')) {
              c.classList.add("turbogpt-dom-hidden");
              c.style.setProperty("display", "none", "important");
            }
          });
        }
      }
    } else {
      turns.forEach((turn) => {
        const container = getTurnItemContainer(turn);
        turn.classList.remove("turbogpt-dom-hidden");
        turn.style.removeProperty("display");
        if (container !== turn) {
          container.classList.remove("turbogpt-dom-hidden");
          container.style.removeProperty("display");
        }
      });
      const root = document.querySelector(".qMYqUG_convSearchResultHighlightRoot");
      if (root) {
        Array.from(root.children).forEach((c) => {
          c.classList.remove("turbogpt-dom-hidden");
          c.style.removeProperty("display");
        });
      }
    }
    initialEnforcementDone = true;
    updateOutlineBadge();
  }

  // 1. Floating Load Button
  let lastPillSignature = null;

  function renderFloatingLoadButton(force = false) {
    const existingPill = document.getElementById("turbogpt-floating-pill");

    if (!appSettings.enabled || appSettings.enableFloatingButton === false) {
      if (existingPill) existingPill.remove();
      lastPillSignature = null;
      return;
    }

    const domHiddenTurns = document.querySelectorAll(".turbogpt-dom-hidden").length;

    // The conversation start has been reached: nothing older exists on server and no DOM turns hidden.
    if (lastStatus.reachedConversationStart === true && !lastStatus.serverHasOlder && domHiddenTurns === 0) {
      if (existingPill) existingPill.remove();
      lastPillSignature = null;
      return;
    }

    const legacyHiddenRecords = Math.max(
      0,
      (lastStatus.totalMessages || 0) - (lastStatus.renderedMessages || 0)
    );
    const olderExists = domHiddenTurns > 0 ||
                        lastStatus.serverHasOlder === true ||
                        lastStatus.hasOlderMessages === true ||
                        legacyHiddenRecords > 0;

    if (!olderExists) {
      if (existingPill) existingPill.remove();
      lastPillSignature = null;
      return;
    }

    const hiddenUserTurnsCount = document.querySelectorAll('.turbogpt-dom-hidden [data-message-author-role="user"], .turbogpt-dom-hidden[data-message-author-role="user"]').length;
    const hiddenTurns =
      hiddenUserTurnsCount > 0
        ? hiddenUserTurnsCount
        : (domHiddenTurns > 0
          ? Math.ceil(domHiddenTurns / 2)
          : (lastStatus.countState === "complete" &&
             Number.isFinite(lastStatus.totalTurns) &&
             Number.isFinite(lastStatus.visibleTurns)
              ? Math.max(0, lastStatus.totalTurns - lastStatus.visibleTurns)
              : null));

    const batchSize = Math.max(1, appSettings.loadBatchSize || 5);
    const loadCount = hiddenTurns !== null ? Math.min(hiddenTurns, batchSize) : batchSize;
    if (loadCount <= 0 && domHiddenTurns === 0) {
      if (existingPill) existingPill.remove();
      lastPillSignature = null;
      return;
    }

    const signature = `${hiddenTurns}|${loadCount}|${olderExists}|${domHiddenTurns}|${lastStatus.countState}`;
    if (!force && existingPill && existingPill.dataset.sig === signature) return;

    if (existingPill) existingPill.remove();

    const chatContainer = getChatScrollContainer();
    if (!chatContainer) return;

    const pill = document.createElement("div");
    pill.id = "turbogpt-floating-pill";
    pill.className = "turbogpt-floating-pill";
    pill.dataset.sig = signature;
    pill.innerHTML = `
      <button class="turbogpt-pill-btn" id="turbogpt-load-batch-action">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="18 15 12 9 6 15"></polyline>
        </svg>
        <span>Load +${loadCount} older turns</span>
        ${hiddenTurns !== null ? `<span class="turbogpt-pill-badge">${hiddenTurns} older</span>` : ""}
      </button>
      <button class="turbogpt-pill-all" id="turbogpt-load-all-action">Load All</button>
    `;

    const firstVisibleTurn = chatContainer.querySelector('[data-testid^="conversation-turn-"]:not(.turbogpt-dom-hidden), article:not(.turbogpt-dom-hidden)') ||
                             chatContainer.querySelector('[data-testid^="conversation-turn-"]') ||
                             chatContainer.firstElementChild;
    const targetTurn = firstVisibleTurn ? getTurnItemContainer(firstVisibleTurn) : null;
    if (targetTurn && targetTurn.parentNode) {
      targetTurn.parentNode.insertBefore(pill, targetTurn);
    } else if (firstVisibleTurn && firstVisibleTurn.parentNode) {
      firstVisibleTurn.parentNode.insertBefore(pill, firstVisibleTurn);
    } else {
      chatContainer.prepend(pill);
    }

    pill.querySelector("#turbogpt-load-batch-action").addEventListener("click", () => {
      const hiddenEls = Array.from(document.querySelectorAll(".turbogpt-dom-hidden"));
      if (hiddenEls.length > 0) {
        // Smoothly unhide next batch directly in the DOM with scroll anchoring
        const anchor = document.querySelector('[data-testid^="conversation-turn-"]:not(.turbogpt-dom-hidden), article:not(.turbogpt-dom-hidden)');
        const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;

        manuallyUnhiddenTurnsCount += batchSize;
        enforceDomTurnLimit({ force: true });
        renderFloatingLoadButton(true);

        if (anchor && chatContainer) {
          const newTop = anchor.getBoundingClientRect().top;
          const diff = newTop - anchorTop;
          if (Math.abs(diff) > 1) {
            chatContainer.scrollBy({ top: diff, behavior: "instant" });
          }
        }
        return;
      }

      stashScrollPosition();
      const currentExtra = safeJsonParse(localStorage.getItem(EXTRA_KEY), {}).extra || 0;
      localStorage.setItem(EXTRA_KEY, JSON.stringify({ url: window.location.href, extra: currentExtra + batchSize }));
      window.location.reload();
    });

    pill.querySelector("#turbogpt-load-all-action").addEventListener("click", () => {
      manuallyUnhiddenTurnsCount = 99999;
      enforceDomTurnLimit({ force: true });
      renderFloatingLoadButton(true);
      if (lastStatus.serverHasOlder === true) {
        stashScrollPosition();
        localStorage.setItem(EXTRA_KEY, JSON.stringify({ url: window.location.href, extra: 9999 }));
        window.location.reload();
      }
    });
  }

  // 1b. Top-bar Export button (sits beside ChatGPT's own Share button)
  const TOPBAR_EXPORT_ID = "turbogpt-export-topbar";

  // Ordered by how stable each hook is: test ids first, then ARIA, then
  // visible text (which is language-dependent and only a last resort).
  function findShareButton() {
    const selectors = [
      '[data-testid="share-chat-button"]',
      '[data-testid*="share" i]',
      'button[aria-label*="Share" i]',
      'button[aria-label*="مشاركة"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && !el.closest(`#${TOPBAR_EXPORT_ID}`)) return el;
    }
    const buttons = Array.from(document.querySelectorAll("main button, header button"));
    return buttons.find((b) => /^(share|مشاركة)$/i.test((b.textContent || "").trim())) || null;
  }

  function findTopbarFallbackContainer() {
    return document.querySelector("main .sticky .flex.items-center.gap-2") ||
           document.querySelector("#page-header") ||
           document.querySelector("main header") ||
           document.querySelector("header");
  }

  function buildTopbarExportButton() {
    const btn = document.createElement("button");
    btn.id = TOPBAR_EXPORT_ID;
    btn.className = "turbogpt-topbar-export";
    btn.type = "button";
    btn.title = "Export conversation";
    btn.setAttribute("aria-label", "Export conversation");
    btn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      <span>Export</span>
    `;
    // Export never depends on the counter: it reads the live DOM directly.
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openExportModal();
    });
    return btn;
  }

  function injectTopbarExportButton() {
    if (!appSettings.enabled) {
      const stale = document.getElementById(TOPBAR_EXPORT_ID);
      if (stale) stale.remove();
      return;
    }

    const existing = document.getElementById(TOPBAR_EXPORT_ID);
    const share = findShareButton();

    if (existing) {
      // Already placed correctly - React re-renders must not duplicate it.
      if (!share || existing.parentNode === share.parentNode) return;
      existing.remove();
    }

    // Nothing to export yet (empty/new chat) - stay out of the way.
    if (!document.querySelector('[data-message-author-role="user"]')) return;

    const btn = buildTopbarExportButton();

    if (share && share.parentNode) {
      // [ Export ] [ Share ]
      share.parentNode.insertBefore(btn, share);
      return;
    }

    // Share may not exist yet, or at all (some temporary chats). Fall back to
    // the nearest top-bar actions container - never floating over messages.
    const container = findTopbarFallbackContainer();
    if (container) container.appendChild(btn);
    // If neither exists we simply retry on the next observer tick.
  }

  function stashScrollPosition() {
    try {
      const scrollEl = getChatScrollContainer();
      const firstVis = document.querySelector('[data-testid^="conversation-turn-"]:not(.turbogpt-dom-hidden), article:not(.turbogpt-dom-hidden)');
      const firstVisId = firstVis?.getAttribute("data-testid") || firstVis?.id || null;
      sessionStorage.setItem(SCROLL_RESTORE_KEY, JSON.stringify({
        url: window.location.href,
        y: window.scrollY,
        containerScrollTop: scrollEl ? scrollEl.scrollTop : 0,
        firstVisId
      }));
    } catch {}
  }

  function restoreScrollIfPending() {
    let pending = null;
    try {
      pending = safeJsonParse(sessionStorage.getItem(SCROLL_RESTORE_KEY), null);
    } catch {}
    if (!pending || pending.url !== window.location.href) return;
    sessionStorage.removeItem(SCROLL_RESTORE_KEY);
    const { y = 0, containerScrollTop = 0, firstVisId } = pending;
    const attempt = (tries) => {
      const scrollEl = getChatScrollContainer();
      if (firstVisId) {
        const target = document.querySelector(`[data-testid="${safeEscape(firstVisId)}"]`);
        if (target) {
          target.scrollIntoView({ block: "start", behavior: "instant" });
          return;
        }
      }
      if (scrollEl && containerScrollTop > 0) {
        scrollEl.scrollTop = containerScrollTop;
      }
      if (y > 0) {
        window.scrollTo(0, Math.min(y, document.body.scrollHeight));
      }
      if (tries > 0 && !firstVisId) {
        setTimeout(() => attempt(tries - 1), 250);
      }
    };
    setTimeout(() => attempt(8), 350);
  }

  // 2. Chat Outline / Table of Contents
  let outlineOpen = false;
  let activeTab = "outline";

  function renderFloatingDock() {
    let dock = document.getElementById("turbogpt-floating-dock");
    const dockVisible = appSettings.enabled && (appSettings.enableOutline !== false || appSettings.enableSearch !== false);

    if (!dockVisible) {
      if (dock) dock.style.display = "none";
      return;
    }

    const allUser = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
    const visibleUser = allUser.filter((el) => {
      const turn = el.closest('[data-testid^="conversation-turn"]') || el.closest('.turbogpt-dom-hidden') || el;
      return !turn.classList.contains("turbogpt-dom-hidden") && turn.style.display !== "none" && (!turn.parentElement || turn.parentElement.style.display !== "none");
    });
    const userCount = visibleUser.length < allUser.length ? `${visibleUser.length}` : `${allUser.length}`;
    const signature = `${appSettings.enableSearch}|${appSettings.enableOutline}|${visibleUser.length}|${allUser.length}`;

    if (dock && dock.dataset.sig === signature) return;

    if (!dock) {
      dock = document.createElement("div");
      dock.id = "turbogpt-floating-dock";
      dock.className = "turbogpt-floating-dock";
      document.body.appendChild(dock);
    }
    dock.dataset.sig = signature;
    dock.style.display = "flex";

    dock.innerHTML = `
      ${appSettings.enableSearch !== false ? `
        <button class="turbogpt-dock-btn" id="turbogpt-dock-search" title="Search in Chat (Alt + F)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </button>
      ` : ""}
      ${appSettings.enableOutline !== false ? `
        <button class="turbogpt-dock-btn" id="turbogpt-dock-outline" title="Table of Contents">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line>
            <line x1="3" y1="12" x2="3.01" y2="12"></line>
            <line x1="3" y1="18" x2="3.01" y2="18"></line>
          </svg>
          <span class="turbogpt-dock-badge" title="${visibleUser.length} visible of ${allUser.length} questions">${userCount}</span>
        </button>
      ` : ""}
    `;

    const searchBtn = dock.querySelector("#turbogpt-dock-search");
    if (searchBtn) searchBtn.addEventListener("click", toggleSearchOverlay);

    const outlineBtn = dock.querySelector("#turbogpt-dock-outline");
    if (outlineBtn) outlineBtn.addEventListener("click", toggleOutlineDrawer);
  }

  function updateOutlineBadge() {
    const badge = document.querySelector(".turbogpt-dock-badge");
    if (badge) {
      const allUser = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      const visibleUser = allUser.filter((el) => {
        const turn = el.closest('[data-testid^="conversation-turn"]') || el.closest('.turbogpt-dom-hidden') || el;
        return !turn.classList.contains("turbogpt-dom-hidden") && turn.style.display !== "none" && (!turn.parentElement || turn.parentElement.style.display !== "none");
      });
      badge.textContent = visibleUser.length < allUser.length ? `${visibleUser.length}` : `${allUser.length}`;
      badge.title = `${visibleUser.length} visible of ${allUser.length} questions`;
    }
  }

  function highlightTurn(el) {
    let curr = el;
    while (curr && curr !== document.body) {
      if (curr.classList.contains("turbogpt-dom-hidden")) {
        curr.classList.remove("turbogpt-dom-hidden");
        curr.style.removeProperty("display");
      }
      curr = curr.parentElement;
    }
    const parentTurn = el.closest('[data-testid^="conversation-turn-"]') || el;
    parentTurn.classList.remove("turbogpt-dom-hidden");
    parentTurn.style.removeProperty("display");
    if (parentTurn.parentElement) {
      parentTurn.parentElement.classList.remove("turbogpt-dom-hidden");
      parentTurn.parentElement.style.removeProperty("display");
    }

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    parentTurn.classList.add("turbogpt-highlight-turn");
    setTimeout(() => parentTurn.classList.remove("turbogpt-highlight-turn"), 2300);
    updateOutlineBadge();
  }

  function toggleOutlineDrawer() {
    outlineOpen = !outlineOpen;
    const existing = document.getElementById("turbogpt-outline-drawer");
    if (existing) existing.remove();
    if (!outlineOpen) return;

    const drawer = document.createElement("div");
    drawer.id = "turbogpt-outline-drawer";
    drawer.className = "turbogpt-outline-drawer";

    const convId = getConversationId();
    const bookmarksKey = convId ? BOOKMARKS_PREFIX + convId : null;
    const bookmarks = bookmarksKey ? safeJsonParse(localStorage.getItem(bookmarksKey), []) : [];

    const userTurns = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
    const visibleTurns = userTurns.filter((el) => {
      const turn = el.closest('[data-testid^="conversation-turn"]') || el.closest('.turbogpt-dom-hidden') || el;
      return !turn.classList.contains("turbogpt-dom-hidden") && turn.style.display !== "none" && (!turn.parentElement || turn.parentElement.style.display !== "none");
    });
    const tabLabel = visibleTurns.length < userTurns.length
      ? `Questions (${visibleTurns.length}/${userTurns.length})`
      : `Questions (${userTurns.length})`;

    drawer.innerHTML = `
      <div class="turbogpt-drawer-header">
        <div class="turbogpt-drawer-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
          <span>Chat Navigator</span>
        </div>
        <button id="turbogpt-close-drawer" class="turbogpt-close-x" style="background:none;border:none;cursor:pointer;font-size:16px;color:#94a3b8;">✕</button>
      </div>
      <div class="turbogpt-drawer-tabs">
        <button class="turbogpt-drawer-tab ${activeTab === 'outline' ? 'active' : ''}" id="turbogpt-tab-outline">${tabLabel}</button>
        <button class="turbogpt-drawer-tab ${activeTab === 'bookmarks' ? 'active' : ''}" id="turbogpt-tab-bookmarks">⭐️ Pinned (${bookmarks.length})</button>
        <button class="turbogpt-drawer-tab ${activeTab === 'global-bookmarks' ? 'active' : ''}" id="turbogpt-tab-global-bookmarks">🌍 All Pinned</button>
      </div>
      <div class="turbogpt-drawer-list" id="turbogpt-drawer-list"></div>
    `;

    document.body.appendChild(drawer);

    drawer.querySelector("#turbogpt-close-drawer").addEventListener("click", () => {
      outlineOpen = false;
      drawer.remove();
    });

    drawer.querySelector("#turbogpt-tab-outline").addEventListener("click", () => {
      activeTab = "outline";
      toggleOutlineDrawer();
      toggleOutlineDrawer();
    });

    drawer.querySelector("#turbogpt-tab-bookmarks").addEventListener("click", () => {
      activeTab = "bookmarks";
      toggleOutlineDrawer();
      toggleOutlineDrawer();
    });

    drawer.querySelector("#turbogpt-tab-global-bookmarks").addEventListener("click", () => {
      activeTab = "global-bookmarks";
      toggleOutlineDrawer();
      toggleOutlineDrawer();
    });

    const listEl = drawer.querySelector("#turbogpt-drawer-list");

    if (activeTab === "outline") {
      if (userTurns.length === 0) {
        listEl.innerHTML = `<div style="text-align:center;padding:20px;color:#94a3b8;font-size:12px;">No questions loaded yet</div>`;
      } else {
        userTurns.forEach((turn, idx) => {
          const turnWrapper = turn.closest('[data-testid^="conversation-turn-"]') || turn.closest('.turbogpt-dom-hidden') || turn;
          const isHidden = turnWrapper.classList.contains("turbogpt-dom-hidden") ||
                           turnWrapper.style.display === "none" ||
                           (turnWrapper.parentElement && turnWrapper.parentElement.classList.contains("turbogpt-dom-hidden")) ||
                           (turnWrapper.parentElement && turnWrapper.parentElement.style.display === "none");

          const text = turn.textContent.trim().slice(0, 75) || "[Prompt]";
          const item = document.createElement("div");
          item.className = "turbogpt-toc-item" + (isHidden ? " turbogpt-toc-hidden" : "");

          const num = document.createElement("span");
          num.className = "turbogpt-toc-num";
          num.textContent = `#${idx + 1}`;

          const label = document.createElement("span");
          label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
          label.textContent = text;

          if (isHidden) {
            const hiddenTag = document.createElement("span");
            hiddenTag.className = "turbogpt-toc-hidden-tag";
            hiddenTag.style.cssText = "font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(239,68,68,0.15);color:#f87171;margin-inline-start:6px;font-weight:600;";
            hiddenTag.textContent = "Hidden";
            item.append(num, label, hiddenTag);
          } else {
            item.append(num, label);
          }

          item.addEventListener("click", () => {
            if (isHidden) {
              manuallyUnhiddenTurnsCount += 2;
            }
            highlightTurn(turn);
            outlineOpen = false;
            drawer.remove();
          });
          listEl.appendChild(item);
        });
      }
    } else if (activeTab === "bookmarks") {
      if (bookmarks.length === 0) {
        listEl.innerHTML = `<div style="text-align:center;padding:20px;color:#94a3b8;font-size:12px;">No pinned responses yet.<br><span style="font-size:11px;opacity:0.7;">Click ⭐️ on any AI reply to save it!</span></div>`;
      } else {
        bookmarks.forEach((bm, idx) => {
          const item = document.createElement("div");
          item.className = "turbogpt-toc-item";

          const star = document.createElement("span");
          star.style.cssText = "color:#eab308;font-size:12px;";
          star.textContent = "⭐️";

          const snippet = document.createElement("span");
          snippet.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
          snippet.textContent = bm.snippet || "[Saved response]";

          const del = document.createElement("button");
          del.className = "turbogpt-del-bm turbogpt-close-x";
          del.dataset.idx = String(idx);
          del.style.cssText = "background:none;border:none;color:#cbd5e1;cursor:pointer;";
          del.textContent = "✕";

          item.append(star, snippet, del);

          item.addEventListener("click", (e) => {
            if (e.target.classList.contains("turbogpt-del-bm")) return;
            const targetEl = bm.id ? document.querySelector(`[data-message-id="${safeEscape(bm.id)}"]`) : null;
            if (targetEl) {
              targetEl.classList.remove("turbogpt-dom-hidden");
              const p = targetEl.closest(".turbogpt-dom-hidden");
              if (p) p.classList.remove("turbogpt-dom-hidden");
              highlightTurn(targetEl);
            } else {
              toast("This reply isn't loaded — use ↑ Load More first.");
            }
          });

          del.addEventListener("click", (e) => {
            e.stopPropagation();
            const freshKey = getConversationId() ? BOOKMARKS_PREFIX + getConversationId() : bookmarksKey;
            const fresh = safeJsonParse(localStorage.getItem(freshKey), []);
            fresh.splice(idx, 1);
            localStorage.setItem(freshKey, JSON.stringify(fresh));
            toggleOutlineDrawer();
            toggleOutlineDrawer();
          });

          listEl.appendChild(item);
        });
      }
    } else if (activeTab === "global-bookmarks") {
      let allBms = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(BOOKMARKS_PREFIX)) {
          const bms = safeJsonParse(localStorage.getItem(key), []);
          const cid = key.replace(BOOKMARKS_PREFIX, "");
          bms.forEach(b => {
            allBms.push({ ...b, convId: cid, storageKey: key });
          });
        }
      }
      
      allBms.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      if (allBms.length === 0) {
        listEl.innerHTML = `<div style="text-align:center;padding:20px;color:#94a3b8;font-size:12px;">No pinned responses found globally.</div>`;
      } else {
        allBms.forEach((bm) => {
          const item = document.createElement("div");
          item.className = "turbogpt-toc-item";
          item.style.flexDirection = "column";
          item.style.alignItems = "stretch";

          const topRow = document.createElement("div");
          topRow.style.cssText = "display:flex;align-items:center;gap:8px;";

          const star = document.createElement("span");
          star.style.cssText = "color:#eab308;font-size:12px;";
          star.textContent = "⭐️";

          const snippet = document.createElement("span");
          snippet.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;";
          snippet.textContent = bm.snippet || "[Saved response]";

          const del = document.createElement("button");
          del.className = "turbogpt-del-bm turbogpt-close-x";
          del.style.cssText = "background:none;border:none;color:#cbd5e1;cursor:pointer;";
          del.textContent = "✕";

          topRow.append(star, snippet, del);

          const bottomRow = document.createElement("div");
          bottomRow.style.cssText = "font-size:10px;color:#94a3b8;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
          bottomRow.textContent = "Chat: " + (bm.title || bm.convId || "Unknown Conversation");

          item.append(topRow, bottomRow);

          item.addEventListener("click", (e) => {
            if (e.target.classList.contains("turbogpt-del-bm")) return;
            if (bm.convId === getConversationId()) {
              const targetEl = bm.id ? document.querySelector(`[data-message-id="${safeEscape(bm.id)}"]`) : null;
              if (targetEl) {
                targetEl.classList.remove("turbogpt-dom-hidden");
                const p = targetEl.closest(".turbogpt-dom-hidden");
                if (p) p.classList.remove("turbogpt-dom-hidden");
                highlightTurn(targetEl);
              } else {
                toast("This reply isn't loaded — use ↑ Load More first.");
              }
            } else {
              window.open('/c/' + bm.convId, '_blank');
            }
          });

          del.addEventListener("click", (e) => {
            e.stopPropagation();
            const fresh = safeJsonParse(localStorage.getItem(bm.storageKey), []);
            const existIdx = fresh.findIndex(f => f.id === bm.id);
            if (existIdx >= 0) {
              fresh.splice(existIdx, 1);
              localStorage.setItem(bm.storageKey, JSON.stringify(fresh));
            }
            toggleOutlineDrawer();
            toggleOutlineDrawer();
          });

          listEl.appendChild(item);
        });
      }
    }
  }

  // 3. Response Bookmarks
  function injectBookmarkButtons() {
    if (!appSettings.enabled || appSettings.enableBookmarks === false) return;

    const assistantTurns = document.querySelectorAll('[data-message-author-role="assistant"]');
    const convId = getConversationId();
    if (!convId) return;

    const bookmarksKey = BOOKMARKS_PREFIX + convId;
    const bookmarks = safeJsonParse(localStorage.getItem(bookmarksKey), []);

    assistantTurns.forEach((astTurn) => {
      if (astTurn.querySelector(".turbogpt-bookmark-btn")) return;

      const actionsRow = astTurn.querySelector('div[class*="mt-"] div[class*="flex"], [class*="text-token-text-secondary"]');
      const container = actionsRow || astTurn;

      const msgId = astTurn.getAttribute("data-message-id") || Math.random().toString(36).slice(2);
      const isBookmarked = bookmarks.some(b => b.id === msgId);

      const btn = document.createElement("button");
      btn.className = `turbogpt-bookmark-btn ${isBookmarked ? 'active' : ''}`;
      btn.title = isBookmarked ? "Pinned" : "Pin this response (⭐️)";
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="${isBookmarked ? '#eab308' : 'none'}" stroke="${isBookmarked ? '#eab308' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        let bms = safeJsonParse(localStorage.getItem(bookmarksKey), []);
        const existIdx = bms.findIndex(b => b.id === msgId);
        if (existIdx >= 0) {
          bms.splice(existIdx, 1);
          btn.classList.remove("active");
          btn.querySelector("svg").setAttribute("fill", "none");
          btn.querySelector("svg").setAttribute("stroke", "currentColor");
        } else {
          const snippet = astTurn.textContent.trim().slice(0, 80) || "AI Response";
          bms.push({ id: msgId, snippet, timestamp: Date.now(), title: cleanTitle() });
          btn.classList.add("active");
          btn.querySelector("svg").setAttribute("fill", "#eab308");
          btn.querySelector("svg").setAttribute("stroke", "#eab308");
        }
        localStorage.setItem(bookmarksKey, JSON.stringify(bms));
        renderFloatingDock();
      });

      container.appendChild(btn);
    });
  }

  // 4. In-Chat Fast & Full-History Search (Alt + F)
  let searchActive = false;
  let searchMatches = [];
  let currentMatchIdx = 0;
  let searchMode = "full"; // "full" or "dom"
  let cachedFullConvMessages = null;
  let cachedFullConvId = null;
  let isFetchingFullChat = false;

  function toggleSearchOverlay() {
    searchActive = !searchActive;
    const existing = document.getElementById("turbogpt-search-overlay");
    if (existing) existing.remove();
    const existingPreview = document.getElementById("turbogpt-preview-card");
    if (existingPreview) existingPreview.remove();
    if (!searchActive) return;

    const overlay = document.createElement("div");
    overlay.id = "turbogpt-search-overlay";
    overlay.className = "turbogpt-search-overlay";
    overlay.innerHTML = `
      <div class="turbogpt-search-bar-row">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="text" class="turbogpt-search-input" id="turbogpt-search-input" placeholder="Search entire chat (Alt+F)..." autofocus />
        <button class="turbogpt-search-mode-pill ${searchMode === 'full' ? 'active' : ''}" id="turbogpt-search-mode-toggle" title="Toggle Full History Archive vs Screen View">
          ${searchMode === 'full' ? '🌐 All History' : '📄 In-Screen'}
        </button>
        <span id="turbogpt-search-count" style="font-size:11px;font-weight:700;color:#64748b;white-space:nowrap;">0 / 0</span>
        <button class="turbogpt-search-btn" id="turbogpt-search-prev" title="Previous (Shift+Enter)">▲</button>
        <button class="turbogpt-search-btn" id="turbogpt-search-next" title="Next (Enter)">▼</button>
        <button class="turbogpt-search-btn turbogpt-close-x" id="turbogpt-search-close">✕</button>
      </div>
      <div class="turbogpt-search-results-panel" id="turbogpt-search-results" style="display: none;"></div>
    `;

    document.body.appendChild(overlay);

    const input = overlay.querySelector("#turbogpt-search-input");
    const countEl = overlay.querySelector("#turbogpt-search-count");
    const modeBtn = overlay.querySelector("#turbogpt-search-mode-toggle");
    const resultsPanel = overlay.querySelector("#turbogpt-search-results");

    modeBtn.addEventListener("click", () => {
      searchMode = searchMode === "full" ? "dom" : "full";
      modeBtn.className = `turbogpt-search-mode-pill ${searchMode === 'full' ? 'active' : ''}`;
      modeBtn.innerHTML = searchMode === 'full' ? '🌐 All History' : '📄 In-Screen';
      input.placeholder = searchMode === 'full' ? 'Search entire chat (Alt+F)...' : 'Search loaded messages...';
      runSearch();
    });

    async function ensureFullChatLoaded() {
      const convId = getConversationId();
      if (cachedFullConvMessages && cachedFullConvId === convId) {
        return cachedFullConvMessages;
      }
      if (isFetchingFullChat) return null;
      isFetchingFullChat = true;
      countEl.textContent = "Fetching…";
      const res = await requestFullConversation(30000);
      isFetchingFullChat = false;
      if (res && Array.isArray(res.messages)) {
        cachedFullConvMessages = res.messages;
        cachedFullConvId = convId;
        return cachedFullConvMessages;
      }
      return null;
    }

    async function runSearch() {
      const q = input.value.trim().toLowerCase();
      searchMatches = [];
      currentMatchIdx = 0;
      resultsPanel.innerHTML = "";

      if (!q) {
        countEl.textContent = "0 / 0";
        resultsPanel.style.display = "none";
        return;
      }

      if (searchMode === "dom") {
        resultsPanel.style.display = "none";
        const turns = getAllConversationTurns();
        turns.forEach((turn) => {
          if (turn.textContent.toLowerCase().includes(q)) {
            searchMatches.push({ type: "dom", el: turn });
          }
        });
        countEl.textContent = searchMatches.length > 0 ? `1 / ${searchMatches.length}` : "0 / 0";
        if (searchMatches.length > 0) jumpToMatch(0);
        return;
      }

      // Full history search
      const fullMsgs = await ensureFullChatLoaded();
      if (!fullMsgs || fullMsgs.length === 0) {
        // Fallback to DOM if API is unavailable (e.g. temporary chat or offline)
        const turns = getAllConversationTurns();
        turns.forEach((turn) => {
          if (turn.textContent.toLowerCase().includes(q)) {
            searchMatches.push({ type: "dom", el: turn });
          }
        });
        countEl.textContent = searchMatches.length > 0 ? `1 / ${searchMatches.length} (screen)` : "0 / 0";
        if (searchMatches.length > 0) jumpToMatch(0);
        return;
      }

      fullMsgs.forEach((msg, idx) => {
        const textLower = msg.text.toLowerCase();
        let matchPos = textLower.indexOf(q);
        if (matchPos !== -1) {
          searchMatches.push({
            type: "full",
            index: idx,
            role: msg.role,
            text: msg.text,
            matchPos
          });
        }
      });

      countEl.textContent = searchMatches.length > 0 ? `1 / ${searchMatches.length}` : "0 / 0";
      if (searchMatches.length === 0) {
        resultsPanel.style.display = "block";
        resultsPanel.innerHTML = '<div style="padding:8px;font-size:11px;color:#94a3b8;text-align:center;">No matches found across entire history</div>';
        return;
      }

      resultsPanel.style.display = "flex";
      searchMatches.forEach((m, idx) => {
        const item = document.createElement("div");
        item.className = "turbogpt-search-item";
        item.dataset.idx = String(idx);

        const startSnippet = Math.max(0, m.matchPos - 45);
        const endSnippet = Math.min(m.text.length, m.matchPos + q.length + 65);
        const before = esc(m.text.slice(startSnippet, m.matchPos));
        const matchText = esc(m.text.slice(m.matchPos, m.matchPos + q.length));
        const after = esc(m.text.slice(m.matchPos + q.length, endSnippet));
        const snippetHtml = (startSnippet > 0 ? "…" : "") + before + `<mark class="turbogpt-search-mark">${matchText}</mark>` + after + (endSnippet < m.text.length ? "…" : "");

        item.innerHTML = `
          <div class="turbogpt-search-item-header">
            <span class="turbogpt-search-role ${m.role === 'User' ? 'user' : 'assistant'}">${esc(m.role)}</span>
            <span style="opacity:0.6;font-size:10px;">Message #${m.index + 1}</span>
          </div>
          <div class="turbogpt-search-snippet">${snippetHtml}</div>
        `;
        item.addEventListener("click", () => jumpToMatch(idx));
        resultsPanel.appendChild(item);
      });

      jumpToMatch(0);
    }

    function jumpToMatch(idx) {
      if (searchMatches.length === 0) return;
      currentMatchIdx = (idx + searchMatches.length) % searchMatches.length;
      countEl.textContent = `${currentMatchIdx + 1} / ${searchMatches.length}`;

      resultsPanel.querySelectorAll(".turbogpt-search-item").forEach((it, i) => {
        if (i === currentMatchIdx) {
          it.classList.add("active");
          it.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } else {
          it.classList.remove("active");
        }
      });

      const match = searchMatches[currentMatchIdx];
      if (match.type === "dom") {
        if (match.el.classList.contains("turbogpt-dom-hidden")) {
          match.el.classList.remove("turbogpt-dom-hidden");
        }
        match.el.scrollIntoView({ behavior: "smooth", block: "center" });
        match.el.classList.add("turbogpt-highlight-turn");
        setTimeout(() => match.el.classList.remove("turbogpt-highlight-turn"), 2200);
        return;
      }

      // Full history match: check if exists in DOM
      const domTurns = getAllConversationTurns();
      let matchedTurnEl = null;
      for (const turn of domTurns) {
        if (turn.textContent.includes(match.text.slice(0, 50))) {
          matchedTurnEl = turn;
          break;
        }
      }

      if (matchedTurnEl) {
        if (matchedTurnEl.classList.contains("turbogpt-dom-hidden")) {
          matchedTurnEl.classList.remove("turbogpt-dom-hidden");
        }
        matchedTurnEl.scrollIntoView({ behavior: "smooth", block: "center" });
        matchedTurnEl.classList.add("turbogpt-highlight-turn");
        setTimeout(() => matchedTurnEl.classList.remove("turbogpt-highlight-turn"), 2200);
      } else {
        // Show in Preview Card
        openPreviewCard(match);
      }
    }

    function openPreviewCard(match) {
      const existing = document.getElementById("turbogpt-preview-card");
      if (existing) existing.remove();

      const card = document.createElement("div");
      card.id = "turbogpt-preview-card";
      card.className = "turbogpt-preview-card";
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="turbogpt-search-role ${match.role === 'User' ? 'user' : 'assistant'}">${esc(match.role)}</span>
            <span style="font-size:12px;font-weight:700;color:#64748b;">Turn #${match.index + 1} (Historical)</span>
          </div>
          <button id="turbogpt-close-preview" class="turbogpt-close-x" style="background:none;border:none;cursor:pointer;font-size:18px;color:#94a3b8;">✕</button>
        </div>
        <div class="turbogpt-preview-content">${esc(match.text)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button class="turbogpt-search-btn" id="turbogpt-copy-preview-text">📋 Copy text</button>
        </div>
      `;
      document.body.appendChild(card);

      card.querySelector("#turbogpt-close-preview").addEventListener("click", () => card.remove());
      card.querySelector("#turbogpt-copy-preview-text").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(match.text);
          toast("Message text copied to clipboard!");
        } catch {
          toast("Could not access clipboard");
        }
      });
    }

    let inputDebounce = null;
    input.addEventListener("input", () => {
      clearTimeout(inputDebounce);
      inputDebounce = setTimeout(runSearch, 150);
    });

    overlay.querySelector("#turbogpt-search-next").addEventListener("click", () => jumpToMatch(currentMatchIdx + 1));
    overlay.querySelector("#turbogpt-search-prev").addEventListener("click", () => jumpToMatch(currentMatchIdx - 1));
    overlay.querySelector("#turbogpt-search-close").addEventListener("click", () => {
      searchActive = false;
      overlay.remove();
      const p = document.getElementById("turbogpt-preview-card");
      if (p) p.remove();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (e.shiftKey) {
          jumpToMatch(currentMatchIdx - 1);
        } else {
          jumpToMatch(currentMatchIdx + 1);
        }
      }
      if (e.key === "Escape") {
        searchActive = false;
        overlay.remove();
        const p = document.getElementById("turbogpt-preview-card");
        if (p) p.remove();
      }
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "f" || e.key === "F" || e.code === "KeyF")) {
      e.preventDefault();
      toggleSearchOverlay();
    } else if (e.key === "Escape") {
      const p = document.getElementById("turbogpt-preview-card");
      if (p) p.remove();
    }
  });

  // 5. Sidebar Folders (real organizer)
  function normalizeFolders(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((f) => ({
      id: f && f.id ? String(f.id) : Math.random().toString(36).slice(2),
      name: f && f.name ? String(f.name) : "Folder",
      chats: Array.isArray(f?.chats)
        ? f.chats.map((c) => (typeof c === "string" ? { id: c, title: "" } : { id: c?.id, title: c?.title || "" })).filter(c => c.id)
        : []
    }));
  }

  function scrapeSidebarTitles() {
    const map = new Map();
    document.querySelectorAll('nav a[href^="/c/"], nav a[href*="/c/"]').forEach((a) => {
      const m = a.getAttribute("href").match(/\/c\/([a-f0-9-]+)/i);
      if (m) map.set(m[1], (a.textContent || "").trim().slice(0, 90));
    });
    return map;
  }

  function renderSidebarFolders() {
    if (!appSettings.enabled || appSettings.enableFolders === false) return;

    const sidebarNav = document.querySelector('nav[aria-label="Chat history"]') || document.querySelector('nav');
    if (!sidebarNav) return;

    let folders = [];

    let container = document.getElementById("turbogpt-sidebar-folders");

    if (!container) {
      container = document.createElement("div");
      container.id = "turbogpt-sidebar-folders";
      container.className = "turbogpt-sidebar-folders";
      container.innerHTML = `
        <div class="turbogpt-folder-header">
          <span>📁 Folders</span>
          <button class="turbogpt-add-folder-btn" id="turbogpt-add-folder" title="New folder">+</button>
        </div>
        <div id="turbogpt-folders-list" style="display:flex;flex-direction:column;gap:3px;"></div>
      `;
      sidebarNav.prepend(container);

      container.querySelector("#turbogpt-add-folder").addEventListener("click", () => {
        folders = loadFolders();
        const name = prompt("New folder name (e.g. 💡 Ideas):");
        if (name && name.trim()) {
          folders.push({ id: Math.random().toString(36).slice(2), name: name.trim(), chats: [] });
          saveFolders(folders);
          updateList();
        }
      });
    }

    function loadFolders() {
      return normalizeFolders(safeJsonParse(localStorage.getItem(FOLDERS_KEY), [
        { id: "work", name: "💼 Work Projects", chats: [] },
        { id: "code", name: "💻 Coding & Dev", chats: [] },
        { id: "study", name: "📚 Research & Study", chats: [] }
      ]));
    }

    function saveFolders(f) {
      localStorage.setItem(FOLDERS_KEY, JSON.stringify(f));
    }

    function updateList() {
      folders = loadFolders();
      const list = container.querySelector("#turbogpt-folders-list");
      list.innerHTML = "";
      const titles = scrapeSidebarTitles();
      const convId = getConversationId();

      if (folders.length === 0) {
        const empty = document.createElement("div");
        empty.className = "turbogpt-folders-empty";
        empty.textContent = "No folders yet — press + to create one.";
        list.appendChild(empty);
        return;
      }

      folders.forEach((folder) => {
        const row = document.createElement("div");
        row.className = "turbogpt-folder-item";

        const arrow = document.createElement("span");
        arrow.textContent = folder._open ? "▾" : "▸";
        arrow.style.fontSize = "9px";
        arrow.style.opacity = "0.6";

        const nameEl = document.createElement("span");
        nameEl.className = "turbogpt-folder-name";
        nameEl.textContent = folder.name;

        const actions = document.createElement("span");
        actions.className = "turbogpt-folder-actions";
        const hasCurrent = convId && folder.chats.some(c => c.id === convId);

        const addCur = document.createElement("button");
        addCur.className = "turbogpt-folder-action-btn";
        addCur.title = hasCurrent ? "Remove this chat from folder" : "Add this chat to folder";
        addCur.textContent = hasCurrent ? "✓" : "＋";

        const renameBtn = document.createElement("button");
        renameBtn.className = "turbogpt-folder-action-btn";
        renameBtn.title = "Rename folder";
        renameBtn.textContent = "✎";

        const delBtn = document.createElement("button");
        delBtn.className = "turbogpt-folder-action-btn";
        delBtn.title = "Delete folder";
        delBtn.textContent = "🗑";

        actions.append(addCur, renameBtn, delBtn);

        const count = document.createElement("span");
        count.className = "turbogpt-folder-count";
        count.textContent = String(folder.chats.length);

        row.append(arrow, nameEl, actions, count);

        addCur.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!convId) { toast("Open a conversation first."); return; }
          const idx = folder.chats.findIndex(c => c.id === convId);
          if (idx >= 0) {
            folder.chats.splice(idx, 1);
          } else {
            const title = titles.get(convId) || cleanTitle();
            folder.chats.push({ id: convId, title });
          }
          saveFolders(folders);
          updateList();
        });

        renameBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const name = prompt("Rename folder:", folder.name);
          if (name && name.trim()) {
            folder.name = name.trim();
            saveFolders(folders);
            updateList();
          }
        });

        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (confirm(`Delete folder "${folder.name}"? Chats are not deleted.`)) {
            folders = loadFolders().filter(f => f.id !== folder.id);
            saveFolders(folders);
            updateList();
          }
        });

        row.addEventListener("click", () => {
          folder._open = !folder._open;
          updateList();
        });

        list.appendChild(row);

        if (folder._open && folder.chats.length > 0) {
          folder.chats.forEach((chat) => {
            const link = document.createElement("a");
            link.className = "turbogpt-folder-chat";
            link.href = `/c/${chat.id}`;
            link.title = chat.title || chat.id;

            const chatTitle = document.createElement("span");
            chatTitle.className = "turbogpt-folder-chat-title";
            chatTitle.textContent = chat.title || titles.get(chat.id) || "(untitled chat)";

            const removeBtn = document.createElement("span");
            removeBtn.className = "turbogpt-folder-chat-remove";
            removeBtn.title = "Remove from folder";
            removeBtn.textContent = "✕";
            removeBtn.addEventListener("click", (e) => {
              e.preventDefault();
              e.stopPropagation();
              folder.chats = folder.chats.filter(c => c.id !== chat.id);
              saveFolders(folders);
              updateList();
            });

            link.addEventListener("click", (e) => e.stopPropagation());
            link.append(chatTitle, removeBtn);
            list.appendChild(link);
          });
        }
      });
    }

    updateList();
  }

  // 6. Modern Pure Chat Exporter (selective + real DOCX)

  // --- Structured extraction -------------------------------------------
  //
  // innerText flattens everything: a rendered <pre><code> loses its fences,
  // links lose their href, tables and lists lose their shape. So the whole
  // export pipeline (and the .docx monospace path, which splits on ``` ) was
  // working on text that could never contain the markers it looked for.
  // We walk the DOM instead and rebuild real markdown.

  // ChatGPT's own UI chrome that must never end up inside an export.
  const EXPORT_SKIP = 'button,[role="button"],svg,form,select,textarea,.sr-only,[aria-hidden="true"]';

  function isSkippable(el) {
    return el.matches && el.matches(EXPORT_SKIP);
  }

  function inlineMarkdown(node) {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out += child.nodeValue;
        return;
      }
      if (child.nodeType !== 1 || isSkippable(child)) return;

      const tag = child.tagName.toLowerCase();
      const inner = inlineMarkdown(child);
      if (tag === "br") { out += "\n"; return; }
      if (!inner.trim() && tag !== "br") return;

      if (tag === "code") out += `\`${inner}\``;
      else if (tag === "a") {
        const href = child.getAttribute("href") || "";
        out += href ? `[${inner}](${href})` : inner;
      } else if (tag === "strong" || tag === "b") out += `**${inner}**`;
      else if (tag === "em" || tag === "i") out += `*${inner}*`;
      else if (tag === "del" || tag === "s") out += `~~${inner}~~`;
      else out += inner;
    });
    return out;
  }

  function tableToBlock(table) {
    const rows = [];
    table.querySelectorAll("tr").forEach((tr) => {
      const cells = [];
      tr.querySelectorAll("th,td").forEach((cell) => {
        cells.push(inlineMarkdown(cell).trim().replace(/\|/g, "\\|").replace(/\n+/g, " "));
      });
      if (cells.length) rows.push(cells);
    });
    return rows.length ? { type: "table", rows } : null;
  }

  function domToBlocks(root) {
    const blocks = [];

    const visit = (el) => {
      if (el.nodeType !== 1 || isSkippable(el)) return;
      const tag = el.tagName.toLowerCase();

      if (tag === "pre") {
        const codeEl = el.querySelector("code") || el;
        const cls = codeEl.getAttribute("class") || "";
        const langMatch = /language-([\w+#.-]+)/.exec(cls);
        // textContent, not innerText: the language label and copy button that
        // ChatGPT renders above the code are separate elements.
        const text = (codeEl.textContent || "").replace(/\n+$/, "");
        if (text.trim()) blocks.push({ type: "code", lang: langMatch ? langMatch[1] : "", text });
        return;
      }
      if (/^h[1-6]$/.test(tag)) {
        const text = inlineMarkdown(el).trim();
        if (text) blocks.push({ type: "heading", level: Number(tag[1]), text });
        return;
      }
      if (tag === "ul" || tag === "ol") {
        const items = [];
        Array.from(el.children).forEach((li) => {
          if (li.tagName && li.tagName.toLowerCase() === "li" && !isSkippable(li)) {
            const text = inlineMarkdown(li).trim();
            if (text) items.push(text);
          }
        });
        if (items.length) blocks.push({ type: "list", ordered: tag === "ol", items });
        return;
      }
      if (tag === "table") {
        const block = tableToBlock(el);
        if (block) blocks.push(block);
        return;
      }
      if (tag === "blockquote") {
        const text = inlineMarkdown(el).trim();
        if (text) blocks.push({ type: "quote", text });
        return;
      }
      if (tag === "hr") { blocks.push({ type: "divider" }); return; }

      // A container: recurse into block-level children, otherwise treat the
      // element itself as a paragraph.
      const hasBlockChildren = Array.from(el.children).some((c) =>
        /^(pre|h[1-6]|ul|ol|table|blockquote|hr|p|div)$/.test(c.tagName.toLowerCase())
      );
      if (hasBlockChildren) {
        Array.from(el.children).forEach(visit);
        return;
      }
      const text = inlineMarkdown(el).trim();
      if (text) blocks.push({ type: "text", text });
    };

    Array.from(root.children).forEach(visit);

    // User prompts are usually a single plain-text node with no structure.
    if (blocks.length === 0) {
      const fallback = (root.innerText || "").trim();
      if (fallback) blocks.push({ type: "text", text: fallback });
    }
    return blocks;
  }

  function blocksToMarkdown(blocks) {
    return blocks.map((b) => {
      switch (b.type) {
        case "heading": return `${"#".repeat(b.level)} ${b.text}`;
        case "code": return `\`\`\`${b.lang || ""}\n${b.text}\n\`\`\``;
        case "list":
          return b.items.map((it, i) => (b.ordered ? `${i + 1}. ${it}` : `- ${it}`)).join("\n");
        case "table": {
          const [head, ...rest] = b.rows;
          const sep = head.map(() => "---");
          return [head, sep, ...rest].map((r) => `| ${r.join(" | ")} |`).join("\n");
        }
        case "quote": return b.text.split("\n").map((l) => `> ${l}`).join("\n");
        case "divider": return "---";
        default: return b.text;
      }
    }).join("\n\n").trim();
  }

  function messageFromElement(el, role) {
    const blocks = domToBlocks(el);
    return { role, blocks, text: blocksToMarkdown(blocks) };
  }

  function extractConversationContent() {
    const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    const messages = [];

    turns.forEach((turn) => {
      const userEl = turn.querySelector('[data-message-author-role="user"]');
      const astEl = turn.querySelector('[data-message-author-role="assistant"]');

      if (userEl) messages.push(messageFromElement(userEl, "User"));
      if (astEl) messages.push(messageFromElement(astEl, "ChatGPT"));
    });

    return { title: cleanTitle(), messages: messages.filter((m) => m.text) };
  }

  // --- Full conversation via the API (not limited by what is on screen) ---

  let fullExportWaiters = [];

  function requestFullConversation(timeoutMs = 190000) {
    return new Promise((resolve) => {
      const waiter = { resolve, done: false };
      fullExportWaiters.push(waiter);
      setTimeout(() => {
        if (!waiter.done) { waiter.done = true; resolve({ error: "timeout" }); }
      }, timeoutMs);
      try {
        window.postMessage({ type: "turbogpt-request-full-export" }, "*");
      } catch {
        waiter.done = true;
        resolve({ error: "bridge-unavailable" });
      }
    });
  }

  function conversationToMarkdown(title, messages, meta) {
    let md = `# ${title}\n\n`;
    md += `*Exported with TurboGPT on ${new Date().toLocaleString()}*  \n`;
    md += `*${messages.length} messages`;
    if (meta && meta.complete === false) md += ` — INCOMPLETE: ${meta.failureReason || "unknown reason"}`;
    md += `*\n\n---\n\n`;
    messages.forEach((m) => { md += `### ${m.role}:\n\n${m.text}\n\n`; });
    return md;
  }

  // A block the user pastes as the first message of a fresh chat so the model
  // picks up where the maxed-out conversation stopped.
  function buildContinuationPrompt(title, messages, turnCount) {
    const wanted = Math.max(1, turnCount || 10);
    // A "turn" is a user message plus whatever followed it.
    const userIdx = [];
    messages.forEach((m, i) => { if (m.role === "User") userIdx.push(i); });
    const start = userIdx.length > wanted ? userIdx[userIdx.length - wanted] : 0;
    const tail = messages.slice(start);

    let out = `This is a continuation of a previous ChatGPT conversation titled "${title}", `;
    out += `which reached its maximum length. The full conversation is attached as a file for reference.\n\n`;
    out += `Below are the last ${Math.min(wanted, userIdx.length)} turns, verbatim, so you can pick up exactly where we stopped. `;
    out += `Please continue from this point — do not restart or re-summarise unless I ask.\n\n`;
    out += `---\n\n`;
    tail.forEach((m) => { out += `### ${m.role}:\n\n${m.text}\n\n`; });
    out += `---\n\nContinue from here.\n`;
    return out;
  }

  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // --- Minimal ZIP (store, no compression) for genuine .docx output ---

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const u16 = (v) => [v & 255, (v >> 8) & 255];
    const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

    files.forEach((f) => {
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const nameB = enc.encode(f.name);
      const crc = crc32(data);
      const local = new Uint8Array([
        0x50, 0x4B, 0x03, 0x04,
        ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(nameB.length), ...u16(0)
      ]);
      chunks.push(local, nameB, data);
      central.push({ nameB, crc, size: data.length, offset });
      offset += local.length + nameB.length + data.length;
    });

    const centralStart = offset;
    let centralSize = 0;
    central.forEach((c) => {
      const rec = new Uint8Array([
        0x50, 0x4B, 0x01, 0x02,
        ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(c.crc), ...u32(c.size), ...u32(c.size),
        ...u16(c.nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
        ...u32(c.offset)
      ]);
      chunks.push(rec, c.nameB);
      centralSize += rec.length + c.nameB.length;
    });

    chunks.push(new Uint8Array([
      0x50, 0x4B, 0x05, 0x06,
      ...u16(0), ...u16(0),
      ...u16(central.length), ...u16(central.length),
      ...u32(centralSize), ...u32(centralStart),
      ...u16(0)
    ]));

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    chunks.forEach((c) => { out.set(c, pos); pos += c.length; });
    return out;
  }

  // --- OOXML builders ---

  const xmlEsc = (s) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function docxParagraph(text, { bold = false, color = "1E293B", size = 22, mono = false, shaded = false, spacingBefore = 0 } = {}) {
    const pPr =
      `${shaded ? '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/><w:spacing w:before="' + spacingBefore + '" w:after="20"/></w:pPr>' :
       (spacingBefore ? `<w:pPr><w:spacing w:before="${spacingBefore}" w:after="20"/></w:pPr>` : "")}`;
    const monoFonts = mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : "";
    const boldTag = bold ? "<w:b/>" : "";
    const rPr = `<w:rPr>${monoFonts}${boldTag}<w:color w:val="${color}"/><w:sz w:val="${size}"/></w:rPr>`;
    const runs = String(text ?? "").split("\n").map((line, i) =>
      (i > 0 ? "<w:r><w:br/></w:r>" : "") + `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r>`
    ).join("");
    return `<w:p>${pPr}${runs}</w:p>`;
  }

  function splitCodeSegments(text) {
    // Splits on ``` fences -> [{code:false,text},{code:true,text},...]
    const parts = String(text ?? "").split("```");
    return parts.map((seg, i) => ({
      code: i % 2 === 1,
      text: i % 2 === 1 ? seg.replace(/^[a-zA-Z0-9+#-]*\r?\n/, "") : seg
    })).filter(s => s.text.length > 0);
  }

  function buildDocx(title, messages) {
    let body = "";

    body += docxParagraph(title, { bold: true, color: "4338CA", size: 36 });
    body += docxParagraph(`Exported with TurboGPT on ${new Date().toLocaleString()}`, { color: "64748B", size: 18, spacingBefore: 40 });

    messages.forEach((m) => {
      const roleColor = m.role === "User" ? "4F46E5" : "047857";
      body += docxParagraph(`${m.role}:`, { bold: true, color: roleColor, size: 24, spacingBefore: 160 });
      splitCodeSegments(m.text).forEach((seg) => {
        seg.code
          ? seg.text.split("\n").forEach(line => { body += docxParagraph(line, { mono: true, shaded: true, size: 19, color: "0F172A" }); })
          : (body += docxParagraph(seg.text, { size: 22, color: "1E293B" }));
      });
    });

    const documentXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;

    const contentTypes =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

    const rels =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

    return makeZip([
      { name: "[Content_Types].xml", data: contentTypes },
      { name: "_rels/.rels", data: rels },
      { name: "word/document.xml", data: documentXml }
    ]);
  }

  function openExportModal() {
    const existing = document.getElementById("turbogpt-export-modal");
    if (existing) existing.remove();

    const { title, messages } = extractConversationContent();

    const modal = document.createElement("div");
    modal.id = "turbogpt-export-modal";
    modal.className = "turbogpt-modal-overlay";

    modal.innerHTML = `
      <div class="turbogpt-modal-box">
        <div class="turbogpt-modal-header">
          <span class="turbogpt-modal-title">Export Conversation</span>
          <button id="turbogpt-modal-close" class="turbogpt-close-x" style="background:none;border:none;cursor:pointer;font-size:18px;color:#94a3b8;">✕</button>
        </div>
        <div class="turbogpt-modal-body">
          <div style="font-size:11.5px;color:#64748b;">
            From "${esc(title)}" — <span id="turbogpt-export-count"></span>
            <button class="turbogpt-link-btn" id="turbogpt-select-all">Select all</button> ·
            <button class="turbogpt-link-btn" id="turbogpt-select-none">None</button>
          </div>
          <div id="turbogpt-export-list" style="display:flex;flex-direction:column;gap:5px;max-height:220px;overflow-y:auto;"></div>
          <div class="turbogpt-full-export-box">
            <div class="turbogpt-full-export-title">🗄️ Whole conversation (from the server)</div>
            <div class="turbogpt-full-export-hint">
              Fetches every turn — including ones trimmed for speed — without loading them into the page.
              Use this to archive a maxed-out chat and continue it in a new one.
            </div>
            <div class="turbogpt-export-grid" style="margin-top:8px;">
              <button class="turbogpt-export-option-btn" id="turbogpt-export-full-md">
                <span>📚 Full conversation (.md)</span>
                <span style="font-size:11px;color:#6366f1;">Fetch →</span>
              </button>
              <button class="turbogpt-export-option-btn" id="turbogpt-export-continuation">
                <span>🔗 Continuation prompt (last ${esc(String(appSettings.continuationTurns || 10))})</span>
                <span style="font-size:11px;color:#6366f1;">Copy →</span>
              </button>
            </div>
            <div class="turbogpt-full-export-hint" id="turbogpt-full-progress" style="margin-top:6px;"></div>
          </div>
          <div class="turbogpt-export-grid">
            <button class="turbogpt-export-option-btn" id="turbogpt-export-word">
              <span>📄 Word document (.docx)</span>
              <span style="font-size:11px;color:#6366f1;">Export →</span>
            </button>
            <button class="turbogpt-export-option-btn" id="turbogpt-export-pdf">
              <span>📑 PDF Document (Print View)</span>
              <span style="font-size:11px;color:#6366f1;">Export →</span>
            </button>
            <button class="turbogpt-export-option-btn" id="turbogpt-export-md">
              <span>📝 Markdown (.md)</span>
              <span style="font-size:11px;color:#6366f1;">Export →</span>
            </button>
            <button class="turbogpt-export-option-btn" id="turbogpt-export-txt">
              <span>📋 Plain Text (.txt)</span>
              <span style="font-size:11px;color:#6366f1;">Export →</span>
            </button>
            <button class="turbogpt-export-option-btn" id="turbogpt-export-json">
              <span>📊 JSON Data</span>
              <span style="font-size:11px;color:#6366f1;">Export →</span>
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

    modal.querySelector("#turbogpt-modal-close").addEventListener("click", () => modal.remove());

    // Build selectable message rows safely (no innerHTML for user content)
    const listEl = modal.querySelector("#turbogpt-export-list");
    const checkboxes = [];

    messages.forEach((m, idx) => {
      const row = document.createElement("label");
      row.className = "turbogpt-select-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.idx = String(idx);

      const role = document.createElement("span");
      role.className = `turbogpt-select-role ${m.role === "User" ? "user" : "chatgpt"}`;
      role.textContent = m.role === "User" ? "You" : "GPT";

      const textSpan = document.createElement("span");
      textSpan.className = "turbogpt-select-text";
      textSpan.textContent = m.text.slice(0, 100) || "(empty)";

      row.append(cb, role, textSpan);
      listEl.appendChild(row);
      checkboxes.push(cb);
    });

    function selectedMessages() {
      const picked = messages.filter((_, i) => checkboxes[i]?.checked);
      return picked;
    }

    function updateExportState() {
      const n = selectedMessages().length;
      modal.querySelector("#turbogpt-export-count").textContent = `${n} message${n === 1 ? "" : "s"} selected`;
      modal.querySelectorAll(".turbogpt-export-option-btn").forEach((b) => { b.disabled = n === 0; });
    }

    checkboxes.forEach((cb) => cb.addEventListener("change", updateExportState));
    modal.querySelector("#turbogpt-select-all").addEventListener("click", () => {
      checkboxes.forEach(cb => { cb.checked = true; });
      updateExportState();
    });
    modal.querySelector("#turbogpt-select-none").addEventListener("click", () => {
      checkboxes.forEach(cb => { cb.checked = false; });
      updateExportState();
    });
    updateExportState();

    const fileBase = () => sanitizeFilename(title);

    modal.querySelector("#turbogpt-export-md").addEventListener("click", () => {
      const msgs = selectedMessages();
      let md = `# ${title}\n*Exported on ${new Date().toLocaleString()}*\n\n---\n\n`;
      msgs.forEach(m => { md += `### ${m.role}:\n${m.text}\n\n`; });
      downloadBlob(md, `${fileBase()}.md`, "text/markdown;charset=utf-8");
      modal.remove();
    });

    modal.querySelector("#turbogpt-export-txt").addEventListener("click", () => {
      const msgs = selectedMessages();
      let txt = `${title}\nExported: ${new Date().toLocaleString()}\n\n========================================\n\n`;
      msgs.forEach(m => { txt += `[${m.role}]\n${m.text}\n\n----------------------------------------\n\n`; });
      downloadBlob(txt, `${fileBase()}.txt`, "text/plain;charset=utf-8");
      modal.remove();
    });

    modal.querySelector("#turbogpt-export-json").addEventListener("click", () => {
      const msgs = selectedMessages();
      const json = JSON.stringify({ title, exportedAt: new Date().toISOString(), messages: msgs }, null, 2);
      downloadBlob(json, `${fileBase()}.json`, "application/json;charset=utf-8");
      modal.remove();
    });

    modal.querySelector("#turbogpt-export-word").addEventListener("click", () => {
      const msgs = selectedMessages();
      const docxBytes = buildDocx(title, msgs);
      downloadBlob(docxBytes, `${fileBase()}.docx`,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      modal.remove();
    });

    // --- Whole-conversation actions (server-sourced) ---

    const progressEl = () => modal.querySelector("#turbogpt-full-progress");

    async function withFullConversation(button, run) {
      const original = button.innerHTML;
      button.disabled = true;
      button.innerHTML = "<span>Fetching whole conversation…</span>";
      if (progressEl()) progressEl().textContent = "Contacting ChatGPT…";

      const result = await requestFullConversation();

      button.disabled = false;
      button.innerHTML = original;

      if (!result || result.error || !Array.isArray(result.messages) || result.messages.length === 0) {
        const why = result?.error || "no messages returned";
        if (progressEl()) progressEl().textContent = `Could not fetch: ${why}`;
        toast(`Full export unavailable (${why}). Exporting what is on screen still works.`);
        return;
      }
      if (result.complete === false) {
        toast(`Partial: ${result.messages.length} messages fetched — stopped (${result.failureReason || "unknown"}).`);
      }
      if (progressEl()) {
        progressEl().textContent =
          `${result.messages.length} messages from ${result.pagesFetched + 1} page(s)` +
          (result.complete === false ? " — incomplete" : " — complete");
      }
      run(result);
    }

    modal.querySelector("#turbogpt-export-full-md").addEventListener("click", (ev) => {
      withFullConversation(ev.currentTarget, (result) => {
        const md = conversationToMarkdown(title, result.messages, result);
        downloadBlob(md, `${fileBase()}-full.md`, "text/markdown;charset=utf-8");
      });
    });

    modal.querySelector("#turbogpt-export-continuation").addEventListener("click", (ev) => {
      withFullConversation(ev.currentTarget, async (result) => {
        const prompt = buildContinuationPrompt(title, result.messages, appSettings.continuationTurns || 10);
        try {
          await navigator.clipboard.writeText(prompt);
          toast("Continuation prompt copied — paste it into a new chat.");
        } catch {
          downloadBlob(prompt, `${fileBase()}-continuation.md`, "text/markdown;charset=utf-8");
          toast("Clipboard blocked — continuation prompt downloaded instead.");
        }
      });
    });

    modal.querySelector("#turbogpt-export-pdf").addEventListener("click", () => {
      const msgs = selectedMessages();
      modal.remove();
      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        toast("Popup blocked — allow popups to export PDF.");
        return;
      }
      let html = `
        <html>
        <head>
          <meta charset="utf-8">
          <title>${esc(title)}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 30px; color: #1e293b; line-height: 1.6; }
            h1 { color: #4338ca; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
            .turn { margin-bottom: 24px; padding: 14px; border-radius: 8px; background: #f8fafc; border: 1px solid #e2e8f0; }
            .role { font-weight: 800; font-size: 13px; color: #6366f1; margin-bottom: 6px; }
            .content { white-space: pre-wrap; font-size: 13px; word-break: break-word; }
            code { font-family: Consolas, Menlo, monospace; background: #eef2ff; padding: 2px 4px; border-radius: 4px; }
            pre { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; overflow-x: auto; }
            pre code { background: none; padding: 0; font-size: 12px; line-height: 1.45; white-space: pre-wrap; }
            table { border-collapse: collapse; font-size: 12px; margin: 8px 0; }
            blockquote { border-left: 3px solid #c7d2fe; margin: 8px 0; padding-left: 10px; color: #475569; }
          </style>
        </head>
        <body>
          <h1>${esc(title)}</h1>
          <p style="color:#64748b;font-size:12px;">Exported: ${esc(new Date().toLocaleString())}</p>
      `;
      msgs.forEach(m => {
        // Render real <pre><code> so the monospace/shaded styling above
        // actually applies instead of being dead CSS over flattened text.
        const bodyHtml = Array.isArray(m.blocks) && m.blocks.length
          ? m.blocks.map((b) => {
              if (b.type === "code") {
                return `<pre><code>${esc(b.text)}</code></pre>`;
              }
              if (b.type === "heading") return `<h${b.level}>${esc(b.text)}</h${b.level}>`;
              if (b.type === "list") {
                const tag = b.ordered ? "ol" : "ul";
                return `<${tag}>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</${tag}>`;
              }
              if (b.type === "table") {
                return `<table border="1" cellspacing="0" cellpadding="4">${
                  b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")
                }</table>`;
              }
              if (b.type === "quote") return `<blockquote>${esc(b.text)}</blockquote>`;
              if (b.type === "divider") return "<hr>";
              return `<div class="content">${esc(b.text)}</div>`;
            }).join("")
          : `<div class="content">${esc(m.text)}</div>`;
        html += `<div class="turn"><div class="role">${esc(m.role)}</div>${bodyHtml}</div>`;
      });
      html += `<script>window.onload = () => { window.print(); };<\/script></body></html>`;
      printWindow.document.write(html);
      printWindow.document.close();
    });
  }

  function resetRenderCaches() {
    lastPillSignature = null;
    const dock = document.getElementById("turbogpt-floating-dock");
    if (dock) delete dock.dataset.sig;
  }

  function renderAllTools() {
    injectStyles();
    enforceDomTurnLimit({ force: true });
    renderFloatingLoadButton(true);
    renderFloatingDock();
    injectTopbarExportButton();
    injectBookmarkButtons();
    renderSidebarFolders();
  }

  // SPA navigation: normal <-> temporary <-> another chat must never show the
  // previous chat's numbers.
  let lastScopeId = getStatsScopeId();
  let lastHref = window.location.href;

  function checkNavigation() {
    const href = window.location.href;
    if (href === lastHref) return;
    lastHref = href;
    manuallyUnhiddenTurnsCount = 0;
    initialEnforcementDone = false;
    cachedFullConvMessages = null;
    cachedFullConvId = null;
    // A new temporary chat gets a fresh session identity.
    if (isTemporaryChat() && !href.includes("/c/")) temporarySessionId = null;
    const scopeId = getStatsScopeId();
    if (scopeId === lastScopeId) return;
    lastScopeId = scopeId;
    statusReceived = false;
    lastStatus = {
      totalMessages: 0,
      renderedMessages: 0,
      hasOlderMessages: false,
      visibleTurns: 0,
      totalTurns: 0,
      countState: "idle",
      countComplete: false
    };
    resetRenderCaches();
    // Force the top-bar button to be re-placed into the new view's top bar.
    const staleExport = document.getElementById(TOPBAR_EXPORT_ID);
    if (staleExport) staleExport.remove();
    recoverStatus();
  }

  // DOM Observer (replaces fixed-interval polling)
  let moTimer = null;
  const observer = new MutationObserver(() => {
    if (moTimer) return;
    moTimer = setTimeout(() => {
      moTimer = null;
      checkNavigation();
      if (appSettings.enabled) {
        enforceDomTurnLimit({ live: true });
        renderFloatingLoadButton();
        injectBookmarkButtons();
        renderSidebarFolders();
      }
      // Runs regardless of `enabled` so it can also remove itself when the
      // booster is switched off. Cheap: exits early once already placed.
      injectTopbarExportButton();
      renderFloatingDock();
    }, 350);
  });

  function startObserver() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      setTimeout(startObserver, 200);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      loadSettings();
      startObserver();
      recoverStatus();
    });
  } else {
    loadSettings();
    startObserver();
    recoverStatus();
  }
})();
