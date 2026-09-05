(() => {
  document.addEventListener("DOMContentLoaded", () => {
    const versionEl = document.getElementById("headerVersion");
    if (versionEl) {
      const manifestVersion = chrome.runtime.getManifest().version;
      versionEl.textContent = `v${manifestVersion}`;
    }

    const toggleEnabled = document.getElementById("toggleEnabled");
    const toggleLiveAutoTrim = document.getElementById("toggleLiveAutoTrim");
    const toggleFloatingButton = document.getElementById("toggleFloatingButton");
    const toggleOutline = document.getElementById("toggleOutline");
    const toggleSearch = document.getElementById("toggleSearch");
    const toggleFolders = document.getElementById("toggleFolders");

    const messageLimitInput = document.getElementById("messageLimit");
    const loadBatchSizeInput = document.getElementById("loadBatchSize");
    const continuationInput = document.getElementById("continuationTurns");

    const msgLimitDec = document.getElementById("msgLimitDec");
    const msgLimitInc = document.getElementById("msgLimitInc");
    const batchLimitDec = document.getElementById("batchLimitDec");
    const batchLimitInc = document.getElementById("batchLimitInc");
    const continuationDec = document.getElementById("continuationDec");
    const continuationInc = document.getElementById("continuationInc");

    const refreshBtn = document.getElementById("refreshBtn");
    const saveBar = document.getElementById("saveBar");
    const exportBtn = document.getElementById("exportCurrentBtn");

    const SETTINGS_KEY = "turbogpt_settings";
    const CACHED_STATS_KEY = "turbogpt_cached_stats";

    // Debug only. Field names/counts - never message content.
    const DEBUG_STATS = false;

    const DEFAULT_SETTINGS = {
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

    let initialSettings = null;
    let statsInterval = null;

    // Diagnostic: a partial count must say WHY it stopped, not just that it did.
    const FAILURE_LABELS = {
      "pagination-contract-unknown": "pagination cursor unavailable",
      "no-backward-cursor": "no older-page cursor in response",
      "no-progress": "server returned no older messages",
      "duplicate-cursor": "server repeated a page",
      "empty-page": "older page came back empty",
      "missing-page-info": "response had no pagination info",
      "schema": "unexpected response shape",
      "parse": "unreadable response",
      "network": "network error",
      "max-pages": "page limit reached",
      "bad-url": "could not build page request",
      "idless-user-record": "a message had no id",
      "cancelled": "chat changed during count",
      "unknown": "unknown reason"
    };

    function failureLabel(reason) {
      if (!reason) return "";
      if (FAILURE_LABELS[reason]) return FAILURE_LABELS[reason];
      if (/^http-429$/.test(reason)) return "rate limited by ChatGPT";
      if (/^http-4\d\d$/.test(reason)) return `request rejected (${reason.slice(5)})`;
      if (/^http-5\d\d$/.test(reason)) return `server error (${reason.slice(5)})`;
      return reason;
    }

    function renderStats(stats) {
      // Numerator = visible user turns actually kept for display.
      // Denominator = unique user turns across the full paginated
      // conversation (never a single API page's raw record count).
      //
      // "No data yet" and "a real conversation with zero turns" are different
      // states. Missing fields are NEVER coerced into a displayable 0.
      const s = stats || {};
      const hasData = s.available !== false && Number.isFinite(s.visibleTurns);
      const countState = s.countState || (hasData ? "idle" : "initializing");
      const visible = Number.isFinite(s.visibleTurns) ? s.visibleTurns : null;
      const total = Number.isFinite(s.totalTurns) ? s.totalTurns : null;

      const memEl = document.getElementById("statMemorySaved");
      const shownEl = document.getElementById("statShown");
      const hiddenEl = document.getElementById("statHidden");
      const noteEl = document.getElementById("statCountNote");
      const ringFill = document.getElementById("memoryRingFill");

      // A percentage is only ever shown for a verified-complete count.
      let savedPct = 0;
      let shownText = visible === null ? "—" : String(visible);
      let hiddenText = "—";
      let note = "";
      let isComplete = false;

      if (!hasData) {
        shownText = "—";
        note = countState === "switching" ? "Switching chat…" : "Waiting for chat data";
      } else if (countState === "counting") {
        hiddenText = "…";
        note = "Counting full chat…";
      } else if (countState === "error") {
        hiddenText = "?";
        note = "Full count unavailable";
      } else if (countState === "partial") {
        hiddenText = total !== null && total > 0 ? `${total}+` : "?";
        const why = failureLabel(s.countFailureReason);
        note = why ? `Partial — ${why}` : "Partial count — not final";
      } else if (countState === "stale") {
        hiddenText = total !== null && total > 0 ? `${total}+` : "?";
        note = "New turn sent — recount pending";
      } else if (countState === "local-only") {
        hiddenText = total === null ? "?" : String(total);
        note = "Current temporary chat (local only)";
      } else if (countState === "complete" && total !== null) {
        // total === 0 is legitimate here: a verified count of an empty chat.
        isComplete = true;
        hiddenText = String(total);
        savedPct = total > 0
          ? Math.max(0, Math.min(100, Math.round(((total - visible) / total) * 100)))
          : 0;
      } else if (countState === "idle") {
        hiddenText = "…";
        note = "Waiting for chat data";
      }

      if (shownEl) shownEl.textContent = shownText;
      if (hiddenEl) hiddenEl.textContent = hiddenText;
      if (memEl) memEl.textContent = isComplete ? `${savedPct}%` : "—";
      if (noteEl) noteEl.textContent = note;
      if (ringFill) {
        ringFill.setAttribute("stroke-dasharray", `${savedPct}, 100`);
      }
    }

    function getCurrentSettings() {
      return {
        enabled: toggleEnabled ? toggleEnabled.checked : true,
        liveAutoTrim: toggleLiveAutoTrim ? toggleLiveAutoTrim.checked : false,
        messageLimit: parseInt(messageLimitInput?.value, 10) || 15,
        loadBatchSize: parseInt(loadBatchSizeInput?.value, 10) || 5,
        continuationTurns: parseInt(continuationInput?.value, 10) || 10,
        enableFloatingButton: toggleFloatingButton ? toggleFloatingButton.checked : true,
        enableOutline: toggleOutline ? toggleOutline.checked : true,
        enableSearch: toggleSearch ? toggleSearch.checked : true,
        enableFolders: toggleFolders ? toggleFolders.checked : true,
        disableNotifications: false
      };
    }

    function saveSettings() {
      const settings = getCurrentSettings();
      chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      syncTabSettings(settings);
      checkDirty();
    }

    function checkDirty() {
      if (!initialSettings || !saveBar) return;
      const current = getCurrentSettings();
      const isDirty = JSON.stringify(current) !== JSON.stringify(initialSettings);
      if (isDirty) {
        saveBar.classList.remove("hidden");
      } else {
        saveBar.classList.add("hidden");
      }
    }

    function syncTabSettings(settings) {
      chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] }, (tabs) => {
        (tabs || []).forEach((tab) => {
          if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { type: "syncSettings", settings }).catch(() => {});
          }
        });
      });
    }

    // Load initial settings
    chrome.storage.local.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS }, (res) => {
      const s = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
      if (toggleEnabled) toggleEnabled.checked = s.enabled;
      if (toggleLiveAutoTrim) toggleLiveAutoTrim.checked = s.liveAutoTrim === true;
      if (messageLimitInput) messageLimitInput.value = s.messageLimit;
      if (loadBatchSizeInput) loadBatchSizeInput.value = s.loadBatchSize || 5;
      if (continuationInput) continuationInput.value = s.continuationTurns || 10;

      if (toggleFloatingButton) toggleFloatingButton.checked = s.enableFloatingButton !== false;
      if (toggleOutline) toggleOutline.checked = s.enableOutline !== false;
      if (toggleSearch) toggleSearch.checked = s.enableSearch !== false;
      if (toggleFolders) toggleFolders.checked = s.enableFolders !== false;

      initialSettings = getCurrentSettings();
    });

    [toggleEnabled, toggleLiveAutoTrim, toggleFloatingButton, toggleOutline, toggleSearch, toggleFolders].forEach(el => {
      if (el) el.addEventListener("change", () => saveSettings());
    });

    if (messageLimitInput) {
      messageLimitInput.addEventListener("change", () => {
        let val = parseInt(messageLimitInput.value, 10);
        if (isNaN(val) || val < 1) val = 1;
        if (val > 100) val = 100;
        messageLimitInput.value = val;
        saveSettings();
      });
    }

    if (loadBatchSizeInput) {
      loadBatchSizeInput.addEventListener("change", () => {
        let val = parseInt(loadBatchSizeInput.value, 10);
        if (isNaN(val) || val < 1) val = 1;
        if (val > 50) val = 50;
        loadBatchSizeInput.value = val;
        saveSettings();
      });
    }

    if (msgLimitDec) {
      msgLimitDec.addEventListener("click", () => {
        let val = parseInt(messageLimitInput.value, 10) || 15;
        val = Math.max(1, val - 1);
        messageLimitInput.value = val;
        saveSettings();
      });
    }

    if (msgLimitInc) {
      msgLimitInc.addEventListener("click", () => {
        let val = parseInt(messageLimitInput.value, 10) || 15;
        val = Math.min(100, val + 1);
        messageLimitInput.value = val;
        saveSettings();
      });
    }

    if (batchLimitDec) {
      batchLimitDec.addEventListener("click", () => {
        let val = parseInt(loadBatchSizeInput.value, 10) || 5;
        val = Math.max(1, val - 1);
        loadBatchSizeInput.value = val;
        saveSettings();
      });
    }

    if (batchLimitInc) {
      batchLimitInc.addEventListener("click", () => {
        let val = parseInt(loadBatchSizeInput.value, 10) || 5;
        val = Math.min(50, val + 1);
        loadBatchSizeInput.value = val;
        saveSettings();
      });
    }

    if (continuationInput) {
      continuationInput.addEventListener("change", () => {
        let val = parseInt(continuationInput.value, 10);
        if (isNaN(val) || val < 1) val = 1;
        if (val > 100) val = 100;
        continuationInput.value = val;
        saveSettings();
      });
    }

    if (continuationDec) {
      continuationDec.addEventListener("click", () => {
        let val = parseInt(continuationInput.value, 10) || 10;
        val = Math.max(1, val - 1);
        continuationInput.value = val;
        saveSettings();
      });
    }

    if (continuationInc) {
      continuationInc.addEventListener("click", () => {
        let val = parseInt(continuationInput.value, 10) || 10;
        val = Math.min(100, val + 1);
        continuationInput.value = val;
        saveSettings();
      });
    }

    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        refreshBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Saved & Applied!';
        refreshBtn.disabled = true;
        setTimeout(() => {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const t = tabs[0];
            if (t?.id) {
              chrome.tabs.reload(t.id);
              window.close();
            }
          });
        }, 800);
      });
    }

    if (exportBtn) {
      exportBtn.addEventListener("click", () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const t = tabs[0];
          if (t?.id) {
            chrome.tabs.sendMessage(t.id, { type: "exportChat" }).catch(() => {});
            window.close();
          }
        });
      });
    }

    const exportBackupBtn = document.getElementById("exportBackupBtn");
    const importBackupBtn = document.getElementById("importBackupBtn");
    const importBackupFileInput = document.getElementById("importBackupFileInput");

    if (exportBackupBtn) {
      exportBackupBtn.addEventListener("click", () => {
        chrome.storage.local.get(null, (items) => {
          const backup = {
            app: "TurboGPT",
            version: chrome.runtime.getManifest()?.version || "3.8.0",
            exportedAt: new Date().toISOString(),
            settings: items.turbogpt_settings || DEFAULT_SETTINGS,
            folders: items.turbogpt_folders || [],
            bookmarks: {}
          };
          Object.keys(items || {}).forEach((key) => {
            if (key.startsWith("turbogpt_bookmarks_")) {
              backup.bookmarks[key] = items[key];
            }
          });
          const jsonStr = JSON.stringify(backup, null, 2);
          const blob = new Blob([jsonStr], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          const dateStr = new Date().toISOString().slice(0, 10);
          a.href = url;
          a.download = `turbogpt-backup-${dateStr}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        });
      });
    }

    if (importBackupBtn && importBackupFileInput) {
      importBackupBtn.addEventListener("click", () => {
        importBackupFileInput.value = "";
        importBackupFileInput.click();
      });

      importBackupFileInput.addEventListener("change", (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const data = JSON.parse(evt.target.result);
            if (!data || (data.app !== "TurboGPT" && !data.folders && !data.bookmarks && !data.settings)) {
              alert("Invalid TurboGPT backup file.");
              return;
            }
            const toSet = {};
            if (Array.isArray(data.folders)) {
              toSet["turbogpt_folders"] = data.folders;
            }
            if (data.settings && typeof data.settings === "object") {
              toSet[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, ...data.settings };
            }
            if (data.bookmarks && typeof data.bookmarks === "object") {
              Object.keys(data.bookmarks).forEach((k) => {
                if (k.startsWith("turbogpt_bookmarks_")) {
                  toSet[k] = data.bookmarks[k];
                }
              });
            }
            chrome.storage.local.set(toSet, () => {
              chrome.tabs.query({}, (tabs) => {
                tabs.forEach((tab) => {
                  if (tab.url && (tab.url.includes("chatgpt.com") || tab.url.includes("chat.openai.com"))) {
                    chrome.tabs.sendMessage(tab.id, { type: "syncSettings", settings: toSet[SETTINGS_KEY] || DEFAULT_SETTINGS }).catch(() => {});
                  }
                });
              });
              alert("Backup successfully restored!");
              window.location.reload();
            });
          } catch (err) {
            alert("Failed to parse backup file: " + err.message);
          }
        };
        reader.readAsText(file);
      });
    }

    // Connect to active tab and poll stats
    function initStats() {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        if (!tab || tab.id == null) return;
        const url = tab.url || "";
        const isChatGPT = url.startsWith("https://chat.openai.com/") || url.startsWith("https://chatgpt.com/");

        if (!isChatGPT) {
          renderStats({ available: false, countState: "idle" });
          return;
        }

        chrome.storage.local.get(CACHED_STATS_KEY, (res) => {
          const cached = res[CACHED_STATS_KEY];
          if (cached && cached.url === url && Number.isFinite(cached.stats?.visibleTurns)) {
            renderStats(cached.stats);
          }
        });

        const fetchLiveStats = () => {
          chrome.tabs.sendMessage(tab.id, { type: "getStats" }, (resp) => {
            if (chrome.runtime.lastError || !resp) {
              renderStats({ available: false, countState: "initializing" });
              return;
            }
            if (DEBUG_STATS) {
              try {
                console.debug("[TurboGPT Stats Debug] popup", {
                  receivedStatsKeys: Object.keys(resp),
                  visibleTurns: resp.visibleTurns,
                  totalTurns: resp.totalTurns,
                  countState: resp.countState
                });
              } catch {}
            }
            const hasData = resp.available !== false && Number.isFinite(resp.visibleTurns);
            const stats = hasData
              ? {
                  available: true,
                  visibleTurns: resp.visibleTurns,
                  totalTurns: Number.isFinite(resp.totalTurns) ? resp.totalTurns : null,
                  countState: resp.countState || "idle",
                  countFailureReason: resp.countFailureReason || null
                }
              : { available: false, countState: resp.countState || "initializing" };
            renderStats(stats);
            // Never cache a "no data yet" reading over a good one.
            if (hasData) {
              chrome.storage.local.set({ [CACHED_STATS_KEY]: { url, stats } });
            }
          });
        };

        fetchLiveStats();
        if (statsInterval) clearInterval(statsInterval);
        statsInterval = setInterval(fetchLiveStats, 1500);
      });
    }

    initStats();
  });
})();
