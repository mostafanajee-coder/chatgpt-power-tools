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
  messageCountWarningThreshold: 120,
  enableAutoScrollLoad: true,
  enableFloatingButton: true,
  enableOutline: true,
  enableSearch: true,
  enableFolders: true,
  enableLocalArchive: true,
  disableNotifications: false
};

// Initialize settings on install or update. An existing settings object
// gets any newly added keys (e.g. enableLocalArchive) without losing the
// user's own values.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(SETTINGS_KEY, (res) => {
    const current = res[SETTINGS_KEY];
    if (!current) {
      chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
      return;
    }
    const merged = { ...DEFAULT_SETTINGS, ...current };
    if (Object.keys(merged).length !== Object.keys(current).length) {
      chrome.storage.local.set({ [SETTINGS_KEY]: merged });
    }
  });
});

// ---------- Local archive: image fetcher ----------
//
// Images are served from OpenAI's file hosts, which a content script cannot
// always read (CORS). The service worker can, through host_permissions.
// Strictly limited to https URLs on ChatGPT/OpenAI image hosts, and only
// for requests coming from this extension's own scripts.
const IMAGE_HOST_RE = /(^|\.)(chatgpt\.com|openai\.com|oaiusercontent\.com)$/i;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function isAllowedImageUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && IMAGE_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

function sniffImageMime(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchImageForArchive(url) {
  if (!isAllowedImageUrl(url)) return { error: "host-not-allowed" };
  let res;
  try {
    res = await fetch(url, { credentials: "include" });
  } catch {
    return { error: "network" };
  }
  if (!res.ok) return { error: `http-${res.status}` };
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return { error: "size" };
  const headerType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const mime = sniffImageMime(buf) || (/^image\//.test(headerType) ? headerType : null);
  if (!mime) return { error: "not-an-image" };
  return { dataUrl: `data:${mime};base64,${bytesToBase64(buf)}`, mime };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "TURBOGPT_PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return true;
  }
  if (message.type === "TURBOGPT_FETCH_IMAGE") {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ error: "forbidden" });
      return true;
    }
    fetchImageForArchive(String(message.url || ""))
      .then(sendResponse)
      .catch(() => sendResponse({ error: "unexpected" }));
    return true;
  }
});
