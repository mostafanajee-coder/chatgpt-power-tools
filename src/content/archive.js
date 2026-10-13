/**
 * TurboGPT - Local Conversation Archive
 *
 * Keeps a copy of every conversation on this device so an export never has
 * to ask OpenAI for the conversation again (that second request is what gets
 * rate-limited, refused or cut short on very long chats).
 *
 * Sources, in order of fidelity:
 *   1. The conversation payload ChatGPT itself loads when a chat opens
 *      (intercepted in mainWorld.js - no extra request is made).
 *   2. Messages rendered in the page after the load, captured once each
 *      finishes streaming (ChatGPT does not re-fetch the chat per message).
 *   3. Images: copied as bytes while their signed URLs are still valid, from
 *      the rendered page first, and from ChatGPT's own file endpoint for
 *      images that were never rendered.
 *
 * Everything lives in chrome.storage.local (unlimitedStorage) and never
 * leaves the device. This file holds the pure logic plus a thin storage
 * adapter; it is shared by the content script and the popup.
 */
(() => {
  if (globalThis.TurboGPTArchive) return;

  const ARCHIVE_KEY_PREFIX = "turbogpt_archive_";
  const CONV_PREFIX = "turbogpt_archive_c_";
  const IMAGE_PREFIX = "turbogpt_archive_i_";
  const INDEX_KEY = "turbogpt_archive_index";
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

  // ---------------------------------------------------------------------
  // Image identity
  // ---------------------------------------------------------------------
  //
  // Signed image URLs change their query string on every load, so the URL
  // itself is useless as an identity. The file id inside it is stable, and
  // the same id appears in the API's asset pointer - which is what lets an
  // image seen in the page and an image referenced by the API be recognised
  // as the same picture.

  const FILE_ID_RE = /(file[-_][A-Za-z0-9]{6,})/;
  const FILES_UUID_RE = /\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$|\?)/i;

  // Must stay identical to archiveImageKey() in mainWorld.js. The scheme is
  // stripped first: in "file-service://file-X" the scheme itself would
  // otherwise match as a file id.
  function imageKeyFromPointer(pointer) {
    const m = FILE_ID_RE.exec(String(pointer || "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""));
    if (!m) return null;
    return /^file_[0-9a-f]+$/i.test(m[1]) ? m[1].toLowerCase() : m[1];
  }

  function hashString(s) {
    // FNV-1a, 32 bit. Identity only, not security.
    const str = String(s || "");
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36) + str.length.toString(36);
  }

  function imageKeyForUrl(url) {
    const s = String(url || "");
    if (!s) return null;
    if (s.startsWith("data:")) return "d_" + hashString(s);
    let decoded = s;
    try { decoded = decodeURIComponent(s); } catch {}
    const fromId = imageKeyFromPointer(decoded);
    if (fromId) return fromId;
    const uuid = FILES_UUID_RE.exec(decoded);
    if (uuid) return "file_" + uuid[1].replace(/-/g, "").toLowerCase();
    try {
      const u = new URL(s);
      return "u_" + hashString(u.origin + u.pathname);
    } catch {
      return "u_" + hashString(s);
    }
  }

  function sniffImageMime(bytes) {
    if (!bytes || bytes.length < 12) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    return null;
  }

  // Whole-string check: the value is written verbatim into an src attribute,
  // so anything outside the base64 alphabet must be rejected, not just a
  // bad prefix. A linear regex over a few MB takes milliseconds.
  const SAFE_DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+|application\/octet-stream);base64,[A-Za-z0-9+/=]+$/i;
  function isSafeImageDataUrl(u) {
    return typeof u === "string" && SAFE_DATA_URL_RE.test(u);
  }

  // ---------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------

  function emptyArchive(conversationId) {
    return {
      version: 1,
      conversationId,
      title: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastServerSyncAt: null,
      serverComplete: false,
      reachedStart: false,
      oldestCursor: null,
      messages: []
    };
  }

  function normalizeRole(role) {
    if (role === "User" || role === "user") return "User";
    return "ChatGPT";
  }

  function normalizeImages(images) {
    if (!Array.isArray(images)) return [];
    const out = [];
    const seen = new Set();
    for (const im of images) {
      if (!im || typeof im.key !== "string" || !im.key || seen.has(im.key)) continue;
      seen.add(im.key);
      const ref = { key: im.key };
      if (im.pointer) ref.pointer = String(im.pointer);
      if (Number.isFinite(im.width)) ref.width = im.width;
      if (Number.isFinite(im.height)) ref.height = im.height;
      if (im.hash) ref.hash = String(im.hash);
      out.push(ref);
    }
    return out;
  }

  function normalizeMessage(m) {
    return {
      id: String(m.id),
      role: normalizeRole(m.role),
      text: typeof m.text === "string" ? m.text : "",
      createTime: Number.isFinite(m.createTime) ? m.createTime : null,
      capturedAt: Number.isFinite(m.capturedAt) ? m.capturedAt : Date.now(),
      origin: m.origin === "server" ? "server" : "dom",
      images: normalizeImages(m.images)
    };
  }

  function unionImages(a, b) {
    const out = normalizeImages(a);
    const byKey = new Map(out.map((im) => [im.key, im]));
    for (const im of normalizeImages(b)) {
      const existing = byKey.get(im.key);
      if (existing) {
        for (const k of ["pointer", "width", "height", "hash"]) {
          if (existing[k] == null && im[k] != null) existing[k] = im[k];
        }
        continue;
      }
      // Same picture already attached under another key (page URL vs API
      // pointer that did not normalise to the same id): content hash wins.
      if (im.hash && out.some((x) => x.hash && x.hash === im.hash)) continue;
      out.push(im);
      byKey.set(im.key, im);
    }
    return out;
  }

  function combineMessage(old, inc) {
    if (!old) return normalizeMessage(inc);
    const n = normalizeMessage(inc);
    return {
      ...old,
      role: n.role,
      // Server markdown is the model's original text; page-derived text is a
      // reconstruction. Never let an empty text erase a real one.
      text: n.origin === "server"
        ? (n.text || old.text)
        : (old.origin === "server" && old.text ? old.text : (n.text || old.text)),
      origin: old.origin === "server" || n.origin === "server" ? "server" : "dom",
      createTime: n.createTime ?? old.createTime ?? null,
      capturedAt: old.capturedAt || n.capturedAt,
      images: unionImages(old.images, n.images)
    };
  }

  /**
   * Merge a server snapshot into the archive.
   *
   * complete=true: the snapshot is the whole active branch (the mapping tree
   * walked from current_node to the root). It is authoritative, except that
   *   - page-captured messages newer than the snapshot's newest message are
   *     kept (a message sent after the snapshot was taken), and
   *   - a "complete" snapshot that is shorter than the archive and adds no
   *     new id is treated as a truncated response, never as the truth - an
   *     edited branch always introduces a new message id.
   *
   * complete=false: the snapshot is one contiguous slice (a paginated page).
   * It replaces the range it covers and everything outside it is kept.
   */
  function mergeMessages(existing, incoming, opts = {}) {
    const ex = (Array.isArray(existing) ? existing : []).filter((m) => m && m.id != null).map((m) => ({ ...m, id: String(m.id) }));
    const inc = (Array.isArray(incoming) ? incoming : []).filter((m) => m && m.id != null).map((m) => ({ ...m, id: String(m.id) }));
    if (inc.length === 0) return ex;
    if (ex.length === 0) return inc.map((m) => normalizeMessage(m));

    const byId = new Map(ex.map((m) => [m.id, m]));
    const incIds = new Set(inc.map((m) => m.id));

    if (opts.complete) {
      const allKnown = inc.every((m) => byId.has(m.id));
      if (allKnown && inc.length < ex.length) {
        const incById = new Map(inc.map((m) => [m.id, m]));
        return ex.map((m) => (incById.has(m.id) ? combineMessage(m, incById.get(m.id)) : m));
      }
      const merged = inc.map((m) => combineMessage(byId.get(m.id), m));
      let newestMs = -Infinity;
      for (const m of inc) if (Number.isFinite(m.createTime)) newestMs = Math.max(newestMs, m.createTime * 1000);
      let lastShared = -1;
      ex.forEach((m, i) => { if (incIds.has(m.id)) lastShared = i; });
      const tail = ex.slice(lastShared + 1).filter((m) =>
        !incIds.has(m.id) && m.origin === "dom" && (m.capturedAt || 0) > newestMs
      );
      return merged.concat(tail);
    }

    const firstIdx = ex.findIndex((m) => incIds.has(m.id));
    if (firstIdx === -1) {
      const incTimes = inc.map((m) => m.createTime).filter(Number.isFinite);
      const exTimes = ex.map((m) => m.createTime).filter(Number.isFinite);
      const incoming2 = inc.map((m) => normalizeMessage(m));
      if (incTimes.length && exTimes.length && Math.max(...incTimes) < Math.min(...exTimes)) {
        return incoming2.concat(ex);
      }
      return ex.concat(incoming2);
    }
    let lastIdx = firstIdx;
    ex.forEach((m, i) => { if (incIds.has(m.id)) lastIdx = i; });
    const before = ex.slice(0, firstIdx);
    const after = ex.slice(lastIdx + 1).filter((m) => !incIds.has(m.id));
    return before.concat(inc.map((m) => combineMessage(byId.get(m.id), m)), after);
  }

  /** Insert or refresh one page-captured message, positioned by its DOM neighbours. */
  function upsertMessage(existing, msg, pos = {}) {
    const ex = Array.isArray(existing) ? existing.slice() : [];
    if (!msg || msg.id == null) return ex;
    const id = String(msg.id);
    const idx = ex.findIndex((m) => m.id === id);
    if (idx !== -1) {
      ex[idx] = combineMessage(ex[idx], { ...msg, id });
      return ex;
    }
    let at = ex.length;
    const p = pos.prevId != null ? ex.findIndex((m) => m.id === String(pos.prevId)) : -1;
    if (p !== -1) {
      at = p + 1;
    } else if (pos.nextId != null) {
      const n = ex.findIndex((m) => m.id === String(pos.nextId));
      if (n !== -1) at = n;
    }
    ex.splice(at, 0, normalizeMessage({ ...msg, id }));
    return ex;
  }

  /** Attach an image to a message; creates a stub for image-only messages. */
  function attachImage(existing, messageId, ref, stub = null) {
    const ex = Array.isArray(existing) ? existing.slice() : [];
    const id = String(messageId);
    const idx = ex.findIndex((m) => m.id === id);
    if (idx !== -1) {
      ex[idx] = { ...ex[idx], images: unionImages(ex[idx].images, [ref]) };
      return ex;
    }
    if (!stub) return ex;
    return upsertMessage(ex, { id, role: stub.role, text: "", origin: "dom", images: [ref] }, stub);
  }

  /**
   * Track the oldest server page held, so the history fill can resume from
   * it. Only a page at the archive's oldest edge may move the cursor: the
   * newest page arriving on every chat open must never reset it.
   */
  function updateHistoryCursor(archive, payload) {
    if (!archive || !payload || !payload.cursor) return archive;
    const slice = Array.isArray(payload.messages) ? payload.messages : [];
    const firstId = slice.length ? String(slice[0].id) : null;
    const atEdge = slice.length === 0
      ? !!archive.oldestCursor
      : archive.messages.length > 0 && archive.messages[0].id === firstId;
    if (!atEdge && archive.oldestCursor) return archive;
    if (!atEdge && slice.length) {
      // First page ever seen for this chat that is not the oldest edge
      // (older messages were already captured from the page): leave it.
      return archive;
    }
    if (payload.cursor.start) archive.oldestCursor = String(payload.cursor.start);
    if (payload.cursor.hasPrevious === false) archive.reachedStart = true;
    return archive;
  }

  function countImages(archive) {
    let n = 0;
    for (const m of (archive && archive.messages) || []) n += (m.images || []).length;
    return n;
  }

  // ---------------------------------------------------------------------
  // Markdown -> HTML (small, safe subset)
  // ---------------------------------------------------------------------

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  function renderInline(text) {
    const codes = [];
    let s = String(text ?? "").replace(/\u0000/g, "");
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = escapeHtml(s);
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const raw = href.replace(/&amp;/g, "&");
      if (!/^(https?:|mailto:)/i.test(raw)) return label;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
    return s;
  }

  function splitTableRow(line) {
    let t = line.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
    return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  }

  function renderMarkdown(md) {
    const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let para = [];
    const flush = () => {
      if (para.length) out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
      para = [];
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flush();
        const ch = fence[1][0];
        const len = fence[1].length;
        const buf = [];
        i++;
        while (i < lines.length) {
          const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]);
          if (close && close[1][0] === ch && close[1].length >= len) break;
          buf.push(lines[i]);
          i++;
        }
        i++;
        const lang = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : "";
        out.push(`<pre><code${lang}>${escapeHtml(buf.join("\n"))}</code></pre>`);
        continue;
      }

      if (!line.trim()) { flush(); i++; continue; }

      const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        flush();
        const lvl = heading[1].length;
        out.push(`<h${lvl}>${renderInline(heading[2])}</h${lvl}>`);
        i++;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push("<hr>"); i++; continue; }

      if (/^\s*>/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
        continue;
      }

      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
        flush();
        const head = splitTableRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitTableRow(lines[i])); i++; }
        out.push(
          "<table><thead><tr>" + head.map((c) => `<th>${renderInline(c)}</th>`).join("") + "</tr></thead><tbody>" +
          rows.map((r) => "<tr>" + r.map((c) => `<td>${renderInline(c)}</td>`).join("") + "</tr>").join("") +
          "</tbody></table>"
        );
        continue;
      }

      const ul = /^\s*[-*+]\s+/;
      const ol = /^\s*\d+[.)]\s+/;
      if (ul.test(line) || ol.test(line)) {
        flush();
        const ordered = ol.test(line);
        const re = ordered ? ol : ul;
        const items = [];
        while (i < lines.length) {
          if (re.test(lines[i])) {
            items.push(lines[i].replace(re, ""));
          } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
            items[items.length - 1] += "\n" + lines[i].trim();
          } else {
            break;
          }
          i++;
        }
        const tag = ordered ? "ol" : "ul";
        out.push(`<${tag}>` + items.map((it) => `<li>${it.split("\n").map(renderInline).join("<br>")}</li>`).join("") + `</${tag}>`);
        continue;
      }

      para.push(line);
      i++;
    }
    flush();
    return out.join("\n");
  }

  // ---------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------

  // ChatGPT embeds citation tokens in its raw markdown, e.g.
  // U+E200 "filecite" U+E202 "turn0file0" U+E202 "L1-L9" U+E201. They are
  // rendered as source chips in ChatGPT and as boxes plus junk anywhere
  // else (verified live: 262 in one long chat). The archive keeps the raw
  // text; exports drop the tokens.
  function cleanChatText(text) {
    return String(text ?? "")
      .replace(/\uE200[^\uE201]*\uE201/g, "")
      .replace(/[\uE200-\uE2FF]/g, "")
      .replace(/[ \t]+\n/g, "\n");
  }

  function roleLabel(role) {
    return role === "User" ? "You" : "ChatGPT";
  }

  function buildMarkdownExport(archive, opts = {}) {
    const title = opts.title || archive.title || "ChatGPT Conversation";
    const msgs = (archive.messages || []).filter((m) => m.text || (m.images && m.images.length));
    const exportedAt = opts.exportedAt || new Date().toLocaleString();
    let md = `# ${title}\n\n`;
    md += `*Exported from the TurboGPT local archive on ${exportedAt}*  \n`;
    md += `*${msgs.length} messages, ${countImages(archive)} images (images are included in the HTML export)*\n\n---\n\n`;
    for (const m of msgs) {
      md += `### ${m.role}:\n\n`;
      const text = cleanChatText(m.text).trim();
      if (text) md += `${text}\n\n`;
      for (let k = 0; k < (m.images || []).length; k++) md += `_[Image ${k + 1}: included in the HTML export]_\n\n`;
    }
    return md;
  }

  const HTML_CSS = `
    :root { --bg:#f8fafc; --card:#ffffff; --text:#0f172a; --muted:#64748b; --border:#e2e8f0;
      --user:#4f46e5; --user-bg:#eef2ff; --gpt:#047857; --gpt-bg:#ecfdf5; --code:#f1f5f9; }
    @media (prefers-color-scheme: dark) {
      :root { --bg:#0b1120; --card:#111827; --text:#e5e7eb; --muted:#94a3b8; --border:#1f2937;
        --user:#a5b4fc; --user-bg:#1e1b4b; --gpt:#6ee7b7; --gpt-bg:#052e25; --code:#0f172a; }
    }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text);
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans Arabic",Tahoma,sans-serif;
      line-height:1.65; font-size:15px; }
    main { max-width:860px; margin:0 auto; padding:32px 16px 64px; }
    header { margin-bottom:24px; padding-bottom:16px; border-bottom:1px solid var(--border); }
    h1.title { margin:0 0 6px; font-size:24px; }
    .meta { color:var(--muted); font-size:13px; }
    .msg { background:var(--card); border:1px solid var(--border); border-radius:14px;
      padding:14px 18px; margin:0 0 14px; overflow-wrap:anywhere; }
    .role { display:inline-block; font-size:11.5px; font-weight:800; letter-spacing:.3px;
      padding:2px 9px; border-radius:999px; margin-bottom:8px; }
    .msg.user .role { color:var(--user); background:var(--user-bg); }
    .msg.assistant .role { color:var(--gpt); background:var(--gpt-bg); }
    .content > :first-child { margin-top:0; } .content > :last-child { margin-bottom:0; }
    pre { background:var(--code); border:1px solid var(--border); border-radius:10px; padding:12px;
      overflow-x:auto; direction:ltr; text-align:left; }
    code { font-family:Consolas,Menlo,"Courier New",monospace; font-size:13px; }
    :not(pre) > code { background:var(--code); padding:1px 5px; border-radius:5px; }
    table { border-collapse:collapse; margin:10px 0; display:block; overflow-x:auto; }
    th, td { border:1px solid var(--border); padding:6px 10px; }
    blockquote { margin:10px 0; padding:2px 14px; border-inline-start:3px solid var(--border); color:var(--muted); }
    a { color:var(--user); }
    figure { margin:12px 0 0; }
    figure img { max-width:100%; height:auto; border-radius:10px; border:1px solid var(--border); display:block; }
    .missing { margin-top:10px; font-size:12.5px; color:var(--muted); border:1px dashed var(--border);
      border-radius:10px; padding:10px; }
    @media print { body { background:#fff; } .msg { break-inside:avoid; } }
  `;

  /**
   * One self-contained .html file: images are embedded as data URLs, so it
   * opens offline, anywhere, forever. `images` maps key -> {dataUrl, hash}.
   */
  function buildHtmlExport(archive, images, opts = {}) {
    const title = opts.title || archive.title || "ChatGPT Conversation";
    const exportedAt = opts.exportedAt || new Date().toLocaleString();
    // Duck-typed: a Map from another realm (popup, tests) fails instanceof.
    const imgMap = images && typeof images.get === "function" ? images : new Map(Object.entries(images || {}));
    const msgs = (archive.messages || []).filter((m) => m.text || (m.images && m.images.length));
    let embedded = 0;
    let missing = 0;

    const body = msgs.map((m) => {
      const cls = m.role === "User" ? "user" : "assistant";
      const seenHashes = new Set();
      const figures = (m.images || []).map((ref) => {
        const rec = imgMap.get(ref.key);
        if (!rec || !isSafeImageDataUrl(rec.dataUrl)) {
          missing++;
          return `<div class="missing">Image not saved locally (it was never displayed while the archive was on).</div>`;
        }
        const h = rec.hash || ref.hash;
        if (h && seenHashes.has(h)) return "";
        if (h) seenHashes.add(h);
        embedded++;
        return `<figure><img src="${rec.dataUrl}" alt="Image" loading="lazy"></figure>`;
      }).join("");
      return `<section class="msg ${cls}"><div class="role">${escapeHtml(roleLabel(m.role))}</div>` +
        `<div class="content" dir="auto">${renderMarkdown(cleanChatText(m.text))}</div>${figures}</section>`;
    }).join("\n");

    const meta = `Exported from the TurboGPT local archive on ${escapeHtml(exportedAt)} · ${msgs.length} messages · ` +
      `${embedded} images${missing ? ` · ${missing} not saved` : ""}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${HTML_CSS}</style>
</head>
<body>
<main>
<header><h1 class="title" dir="auto">${escapeHtml(title)}</h1><div class="meta">${meta}</div></header>
${body}
</main>
</body>
</html>
`;
  }

  // ---------------------------------------------------------------------
  // Storage adapter (chrome.storage.local)
  // ---------------------------------------------------------------------

  function area() {
    try {
      return (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
    } catch {
      return null;
    }
  }

  function sget(keys) {
    return new Promise((resolve) => {
      const a = area();
      if (!a) return resolve({});
      try { a.get(keys, (r) => resolve(r || {})); } catch { resolve({}); }
    });
  }

  function sset(obj) {
    return new Promise((resolve) => {
      const a = area();
      if (!a) return resolve(false);
      try { a.set(obj, () => resolve(true)); } catch { resolve(false); }
    });
  }

  function sremove(keys) {
    return new Promise((resolve) => {
      const a = area();
      if (!a) return resolve(false);
      try { a.remove(keys, () => resolve(true)); } catch { resolve(false); }
    });
  }

  async function allKeys() {
    const a = area();
    if (a && typeof a.getKeys === "function") {
      try {
        const keys = await a.getKeys();
        if (Array.isArray(keys)) return keys;
      } catch {}
    }
    return Object.keys(await sget(null));
  }

  function normalizeIndex(idx) {
    const out = idx && typeof idx === "object" ? idx : {};
    if (!out.conversations || typeof out.conversations !== "object") out.conversations = {};
    if (!out.images || typeof out.images !== "object") out.images = {};
    return out;
  }

  let indexCache = null;

  async function loadIndex() {
    const r = await sget(INDEX_KEY);
    indexCache = normalizeIndex(r[INDEX_KEY]);
    return indexCache;
  }

  async function getIndex() {
    return indexCache || loadIndex();
  }

  // ---------------------------------------------------------------------
  // Conversation storage (v2: one key per message)
  // ---------------------------------------------------------------------
  //
  // v1 kept a whole conversation under one key, so every save rewrote all
  // of it: 3.6 MB for a 756-message chat, ~138 MB written during one history
  // fill, and every write was broadcast through storage.onChanged (old AND
  // new value) to every ChatGPT tab's content script. v2 stores a small
  // record with the message order, plus one key per message, and a save
  // writes only the messages whose content changed. v1 records still load,
  // and are converted on their next save.

  const MSG_PREFIX = "turbogpt_archive_m_";
  const msgKey = (conversationId, id) => `${MSG_PREFIX}${conversationId}_${id}`;

  // What is known to be on disk, per conversation: content signature by
  // message id, and the order list last written.
  const persisted = new Map();
  // Message objects are replaced (never mutated) whenever their content
  // changes, so a signature can be cached per object.
  const sigCache = new WeakMap();

  function messageSig(m) {
    let sig = sigCache.get(m);
    if (sig) return sig;
    const imgs = (m.images || []).map((i) => `${i.key}:${i.hash || ""}:${i.pointer ? 1 : 0}`).join(",");
    sig = `${m.role}|${m.origin}|${m.createTime ?? ""}|${(m.text || "").length}|${hashString(m.text || "")}|${imgs}`;
    try { sigCache.set(m, sig); } catch {}
    return sig;
  }

  const META_FIELDS = ["title", "createdAt", "updatedAt", "lastServerSyncAt", "serverComplete", "reachedStart", "oldestCursor"];

  // updatedAt is set by the save itself, so it never counts as a change.
  function metaSigOf(archive) {
    return META_FIELDS.filter((f) => f !== "updatedAt").map((f) => String(archive[f] ?? "")).join("|");
  }

  async function loadConversation(conversationId) {
    if (!conversationId) return null;
    const key = CONV_PREFIX + conversationId;
    const r = await sget(key);
    const rec = r[key];
    if (!rec || typeof rec !== "object") return null;

    if (Array.isArray(rec.messages)) {
      // v1: nothing is known to be on disk per message, so the next save
      // writes every message once and replaces this record with v2.
      persisted.set(conversationId, { sigs: new Map(), order: [] });
      return rec;
    }
    if (!Array.isArray(rec.order)) return null;

    const stored = rec.order.length ? await sget(rec.order.map((id) => msgKey(conversationId, id))) : {};
    const messages = [];
    const sigs = new Map();
    for (const id of rec.order) {
      const raw = stored[msgKey(conversationId, id)];
      if (!raw || raw.id == null) continue;
      const { _sig, ...m } = raw;
      messages.push(m);
      if (_sig) {
        sigs.set(String(m.id), _sig);
        try { sigCache.set(m, _sig); } catch {}
      }
    }
    const archive = { version: 2, conversationId, messages };
    for (const f of META_FIELDS) if (f in rec) archive[f] = rec[f];
    persisted.set(conversationId, { sigs, order: rec.order.slice(), metaSig: metaSigOf(archive) });
    return archive;
  }

  async function saveConversation(archive) {
    if (!archive || !archive.conversationId) return false;
    const conversationId = archive.conversationId;
    const prev = persisted.get(conversationId) || { sigs: new Map(), order: [] };

    const writes = {};
    const order = [];
    const sigs = new Map();
    const seen = new Set();
    for (const m of archive.messages || []) {
      if (!m || m.id == null) continue;
      const id = String(m.id);
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      const sig = messageSig(m);
      sigs.set(id, sig);
      if (prev.sigs.get(id) !== sig) writes[msgKey(conversationId, id)] = { ...m, _sig: sig };
    }
    const removed = prev.order.filter((id) => !seen.has(id)).map((id) => msgKey(conversationId, id));
    const orderChanged = order.length !== prev.order.length || order.some((id, i) => id !== prev.order[i]);
    const metaSig = metaSigOf(archive);
    const metaChanged = prev.metaSig !== metaSig;

    if (!Object.keys(writes).length && !removed.length && !orderChanged && !metaChanged) return true;

    archive.updatedAt = Date.now();
    const record = { version: 2, conversationId, order };
    for (const f of META_FIELDS) if (archive[f] !== undefined) record[f] = archive[f];

    const idx = await loadIndex();
    idx.conversations[conversationId] = {
      title: archive.title || "",
      updatedAt: archive.updatedAt,
      messageCount: order.length,
      imageCount: countImages(archive)
    };
    const ok = await sset({ ...writes, [CONV_PREFIX + conversationId]: record, [INDEX_KEY]: idx });
    if (!ok) return false;
    if (removed.length) await sremove(removed);
    persisted.set(conversationId, { sigs, order, metaSig });
    return true;
  }

  async function hasImage(key) {
    const idx = await getIndex();
    return !!idx.images[key];
  }

  async function saveImage(key, record) {
    if (!key || !record || !isSafeImageDataUrl(record.dataUrl)) return false;
    if (record.dataUrl.length > MAX_IMAGE_BYTES * 1.4) return false;
    const rec = { ...record, hash: record.hash || hashString(record.dataUrl), savedAt: Date.now() };
    const idx = await loadIndex();
    idx.images[key] = { bytes: rec.dataUrl.length, hash: rec.hash };
    const ok = await sset({ [IMAGE_PREFIX + key]: rec, [INDEX_KEY]: idx });
    return ok ? rec : false;
  }

  async function loadImages(keys) {
    const uniq = Array.from(new Set((keys || []).filter(Boolean)));
    const map = new Map();
    if (!uniq.length) return map;
    const r = await sget(uniq.map((k) => IMAGE_PREFIX + k));
    for (const k of uniq) {
      const rec = r[IMAGE_PREFIX + k];
      if (rec && rec.dataUrl) map.set(k, rec);
    }
    return map;
  }

  async function clearAll() {
    const keys = (await allKeys()).filter((k) => k.startsWith(ARCHIVE_KEY_PREFIX));
    if (keys.length) await sremove(keys);
    indexCache = null;
    persisted.clear();
    return keys.length;
  }

  async function stats() {
    const idx = await loadIndex();
    let bytes = null;
    const a = area();
    if (a && typeof a.getBytesInUse === "function") {
      bytes = await new Promise((resolve) => {
        try { a.getBytesInUse(null, (n) => resolve(Number.isFinite(n) ? n : null)); } catch { resolve(null); }
      });
    }
    return {
      conversations: Object.keys(idx.conversations).length,
      images: Object.keys(idx.images).length,
      bytes
    };
  }

  globalThis.TurboGPTArchive = {
    ARCHIVE_KEY_PREFIX, CONV_PREFIX, IMAGE_PREFIX, MSG_PREFIX, INDEX_KEY, MAX_IMAGE_BYTES, messageSig,
    imageKeyFromPointer, imageKeyForUrl, hashString, sniffImageMime, isSafeImageDataUrl,
    emptyArchive, normalizeMessage, unionImages, mergeMessages, upsertMessage, attachImage, countImages, updateHistoryCursor,
    escapeHtml, renderInline, renderMarkdown, cleanChatText, buildMarkdownExport, buildHtmlExport,
    loadConversation, saveConversation, hasImage, saveImage, loadImages, clearAll, stats, allKeys
  };
})();
