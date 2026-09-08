/**
 * TurboGPT - Background Service Worker
 * 100% Private, Local-Only, Open-Source
 */

const SETTINGS_KEY = "turbogpt_settings";

const DEFAULT_SETTINGS = {
  enabled: true,
  liveAutoTrim: false,
  messageLimit: 15,
  loadBatchSize: 5,
  continuationTurns: 10,
  enableAutoScrollLoad: true,
  enableFloatingButton: true,
  enableOutline: true,
  enableSearch: true,
  enableFolders: true,
  disableNotifications: false
};

// Initialize settings on install or update
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(SETTINGS_KEY, (res) => {
    if (!res[SETTINGS_KEY]) {
      chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
    }
  });
});

// Relay messages if needed
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TURBOGPT_PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return true;
  }
});
