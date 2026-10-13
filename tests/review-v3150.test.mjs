/**
 * v3.15.0 review fixes.
 *
 * 1. Archive storage writes only what changed (one key per message).
 * 2. Page-captured ids are trusted only when they are real message ids.
 * 3. Newest turns come from a throttled latest-page refresh after a reply.
 * 4. Search, continuation and the export list read the local archive.
 * 5. Current send endpoint, and a paced automatic count walk.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveSrc = fs.readFileSync(path.join(REPO, "src/content/archive.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(REPO, "src/content/index.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(REPO, "src/page/mainWorld.js"), "utf8");

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

function grab(name, src) {
  const s = src.indexOf(`function ${name}(`);
  if (s === -1) throw new Error(`missing ${name}`);
  let i = src.indexOf("(", s), p = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") p++;
    else if (src[i] === ")") { p--; if (!p) break; }
  }
  let d = 0;
  i = src.indexOf("{", i);
  for (; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (!d) break; }
  }
  return src.slice(s, i + 1);
}

function makeStorage() {
  const data = {};
  const writes = [];
  const removes = [];
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const local = {
    get(keys, cb) {
      const out = {};
      if (keys === null || keys === undefined) Object.assign(out, clone(data));
      else (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in data) out[k] = clone(data[k]); });
      cb(out);
    },
    set(obj, cb) {
      const entry = {};
      for (const k of Object.keys(obj)) { data[k] = clone(obj[k]); entry[k] = JSON.stringify(obj[k]).length; }
      writes.push(entry);
      if (cb) cb();
    },
    remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete data[k]; removes.push(k); }); if (cb) cb(); },
    getKeys: async () => Object.keys(data),
    getBytesInUse(_k, cb) { cb(JSON.stringify(data).length); }
  };
  return { data, writes, removes, local };
}

function loadArchive(storage) {
  const ctx = { chrome: { storage: { local: storage.local } }, URL, console };
  vm.createContext(ctx);
  vm.runInContext(archiveSrc, ctx);
  return ctx.TurboGPTArchive;
}

const T = 1_700_000_000;
const msg = (id, text, role = "ChatGPT", extra = {}) => ({ id, role, text, createTime: T, origin: "server", images: [], ...extra });

/* ---------------- 1. Incremental archive storage ---------------- */
console.log("--- PART 1: archive saves write only what changed ---");
{
  const st = makeStorage();
  const A = loadArchive(st);
  const a = A.emptyArchive("conv1");
  a.title = "Chat";
  a.messages = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, "x".repeat(5000), i % 2 ? "ChatGPT" : "User"));
  await A.saveConversation(a);
  const first = st.writes[st.writes.length - 1];
  check("first save writes every message once, under its own key",
    Object.keys(first).filter((k) => k.startsWith("turbogpt_archive_m_conv1_")).length === 50);
  check("the conversation record holds the order, not the messages",
    Array.isArray(st.data.turbogpt_archive_c_conv1.order) && st.data.turbogpt_archive_c_conv1.order.length === 50 &&
    !("messages" in st.data.turbogpt_archive_c_conv1));

  // Unchanged save: nothing is written at all.
  const before = st.writes.length;
  await A.saveConversation(a);
  check("saving an unchanged archive writes nothing", st.writes.length === before, `${st.writes.length - before} writes`);

  // One new message: only it (plus the small record and index) is written.
  a.messages = a.messages.concat([msg("m50", "new reply")]);
  await A.saveConversation(a);
  const w = st.writes[st.writes.length - 1];
  const msgKeys = Object.keys(w).filter((k) => k.startsWith("turbogpt_archive_m_"));
  const bytes = Object.values(w).reduce((n, v) => n + v, 0);
  check("adding one message writes only that message", msgKeys.length === 1 && msgKeys[0].endsWith("_m50"), msgKeys.join(","));
  check("an incremental save is small (not the whole conversation)", bytes < 4000, `${bytes} bytes vs ~${50 * 5000} for a full rewrite`);

  // Edited branch: dropped messages are removed from disk.
  a.messages = a.messages.filter((m) => m.id !== "m49" && m.id !== "m50").concat([msg("m49b", "edited")]);
  await A.saveConversation(a);
  check("messages dropped from the archive are deleted from storage",
    !("turbogpt_archive_m_conv1_m49" in st.data) && !("turbogpt_archive_m_conv1_m50" in st.data) &&
    "turbogpt_archive_m_conv1_m49b" in st.data);

  // Round trip through a fresh adapter (another tab / next visit).
  const B = loadArchive(st);
  const loaded = await B.loadConversation("conv1");
  check("conversation loads back in order with its metadata",
    loaded && loaded.messages.length === 50 && loaded.messages[0].id === "m0" &&
    loaded.messages[49].id === "m49b" && loaded.title === "Chat" && !("_sig" in loaded.messages[0]));
  const n = st.writes.length;
  await B.saveConversation(loaded);
  check("a freshly loaded archive saves nothing until it changes", st.writes.length === n);

  const removed = await B.clearAll();
  check("Delete archive still removes every per-message key",
    removed > 0 && !Object.keys(st.data).some((k) => k.startsWith("turbogpt_archive_")));
}
{
  // v1 (single key with all messages) archives keep working and convert.
  const st = makeStorage();
  st.data.turbogpt_archive_c_old = {
    version: 1, conversationId: "old", title: "Old", reachedStart: true,
    messages: [msg("a", "one", "User"), msg("b", "two")]
  };
  const A = loadArchive(st);
  const v1 = await A.loadConversation("old");
  check("a v1 archive still loads", v1 && v1.messages.length === 2 && v1.title === "Old");
  await A.saveConversation(v1);
  const rec = st.data.turbogpt_archive_c_old;
  check("its next save converts it to the per-message format",
    rec && Array.isArray(rec.order) && !("messages" in rec) && rec.reachedStart === true &&
    "turbogpt_archive_m_old_a" in st.data && "turbogpt_archive_m_old_b" in st.data);
  const again = await loadArchive(st).loadConversation("old");
  check("the converted archive loads identically", again.messages.map((m) => m.text).join(",") === "one,two");
}

/* ---------------- 2. Page id trust ---------------- */
console.log("\n--- PART 2: page-captured ids ---");
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(grab("archiveTrustedUpdates", contentSrc) + "\nglobalThis.trust = archiveTrustedUpdates;", ctx);
  const u = (id, role, direct) => ({ direct, message: { id, role } });
  const known = new Map([["srv-user", "User"], ["srv-reply", "ChatGPT"]]);
  const ids = (list) => list.map((x) => `${x.message.id}/${x.message.role}`).join(",");

  check("a direct data-message-id for a new message is trusted",
    ids(ctx.trust([u("new-1", "ChatGPT", true)], new Map())) === "new-1/ChatGPT");
  check("one id read for both a question and its reply is dropped (no merge)",
    ctx.trust([u("turn-7", "User", false), u("turn-7", "ChatGPT", false)], new Map()).length === 0 &&
    ctx.trust([u("x", "User", true), u("x", "ChatGPT", true)], new Map()).length === 0);
  check("a known message never has its role flipped",
    ctx.trust([u("srv-user", "ChatGPT", true)], known).length === 0);
  check("an indirect id (search attribute / turn key) is not used for unknown messages",
    ctx.trust([u("turn-key-9", "User", false)], new Map()).length === 0);
  check("an indirect id that matches a server-confirmed message with the same role is accepted",
    ids(ctx.trust([u("srv-reply", "ChatGPT", false)], known)) === "srv-reply/ChatGPT");
  check("capture applies the rule, and images follow it too",
    contentSrc.includes("const trusted = archiveTrustedUpdates(updates, knownRole);") &&
    contentSrc.includes("if ((known && known !== role) || (!known && !im.direct)) {") &&
    contentSrc.includes('direct: holder?.getAttribute?.("data-message-id") === messageId,'));
}

/* ---------------- 3. Latest-page refresh ---------------- */
console.log("\n--- PART 3: newest turns from the server ---");
check("mainWorld refreshes the newest page on request, throttled, using ChatGPT's own opening request",
  mainSrc.includes("const REFRESH_MIN_INTERVAL_MS = 8000;") &&
  grab("refreshLatestPage", mainSrc).includes("fetchPageWithRetry(req.url, req.init, stillHere)") &&
  mainSrc.includes('reply({ error: "throttled" })'));
check("the end of a send stream is detected without touching ChatGPT's copy",
  grab("watchReplyStream", mainSrc).includes("response.clone()") &&
  mainSrc.includes('window.postMessage({ type: "turbogpt-reply-finished" }, "*");') &&
  mainSrc.indexOf("watchReplyStream(res);") < mainSrc.indexOf("if (!appConfig.enabled) {\n      // Booster off"));
check("a finished reply (page or stream) schedules one refresh",
  contentSrc.includes("archiveOnReplyFinished();\n    }") &&
  contentSrc.includes('e.data.type === "turbogpt-reply-finished"') &&
  grab("archiveOnReplyFinished", contentSrc).includes("archiveScheduleRefresh(convId, 2500)"));
check("export syncs first only when a reply is newer than the last newest-page snapshot",
  grab("archiveSyncLatestIfNeeded", contentSrc).includes("if (ended <= synced) return;") &&
  contentSrc.includes("await archiveSyncLatestIfNeeded();\n      await archiveCaptureLive({ all: true });"));

/* ---------------- 4. Archive-backed search, continuation, export list ---------------- */
console.log("\n--- PART 4: search, continuation and export read the archive ---");
{
  const ctx = { Archive: loadArchive(makeStorage()) };
  vm.createContext(ctx);
  vm.runInContext([
    "let archiveSearchableCache = null;",
    grab("archiveExportMessages", contentSrc),
    grab("archiveSearchable", contentSrc),
    "globalThis.exp = archiveExportMessages; globalThis.srch = archiveSearchable;"
  ].join("\n"), ctx);
  const a = { messages: [
    msg("1", "Hello fileciteturn0file0 World", "User"),
    msg("2", "", "ChatGPT", { images: [{ key: "k" }] }),
    msg("3", "Answer", "ChatGPT")
  ] };
  const out = ctx.exp(a);
  check("archive messages are cleaned for export (citations removed, image-only rows skipped)",
    out.length === 2 && out[0].text === "Hello  World" && out[1].role === "ChatGPT");
  const s1 = ctx.srch(a);
  const s2 = ctx.srch(a);
  check("search index is built once per archive change", s1 === s2 && s1[0].lower === "hello  world");
  a.messages = a.messages.concat([msg("4", "More")]);
  check("and rebuilt when the archive changes", ctx.srch(a).length === 3);
}
check("full-history search reads the local archive before any server walk",
  grab("toggleSearchOverlay", contentSrc).indexOf("const local = await getArchiveForCurrentChat();") <
  grab("toggleSearchOverlay", contentSrc).indexOf("await requestFullConversation(30000)"));
check("continuation prompt uses the archive when it holds enough turns",
  contentSrc.includes("if (local.reachedStart || users >= turnsWanted) {") &&
  contentSrc.includes("Continuation prompt copied from the local archive"));
check("export list switches to the archive when it holds more than the screen",
  contentSrc.includes("if (archived.length <= messages.length) return;") &&
  contentSrc.includes("renderRows();\n      updateExportState();") &&
  contentSrc.includes('id="turbogpt-export-source"'));
check("archive rows render as formatted markdown in the PDF, and leave no marker in JSON",
  contentSrc.includes('m.fromArchive && Archive\n            ? `<div class="md" dir="auto">${Archive.renderMarkdown(m.text)}</div>`') &&
  contentSrc.includes("messages: msgs.map(({ fromArchive, ...m }) => m)"));

/* ---------------- 5. Send endpoint and walk pacing ---------------- */
console.log("\n--- PART 5: send endpoint and walk pacing ---");
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(grab("isConversationSendUrl", mainSrc) + "\nglobalThis.isSend = isConversationSendUrl;", ctx);
  check("current client's send endpoint is recognised", ctx.isSend("https://chatgpt.com/backend-api/f/conversation", "POST"));
  check("legacy send endpoint still recognised", ctx.isSend("https://chatgpt.com/backend-api/conversation", "POST"));
  check("prepare, title and GET requests are not sends",
    !ctx.isSend("https://chatgpt.com/backend-api/f/conversation/prepare", "POST") &&
    !ctx.isSend("https://chatgpt.com/backend-api/conversation/gen_title/x", "POST") &&
    !ctx.isSend("https://chatgpt.com/backend-api/f/conversation", "GET"));
}
check("the automatic count walk is paced like the history fill",
  mainSrc.includes("const WALK_PAGE_DELAY_MS = 1500;") &&
  grab("walkAndCount", mainSrc).includes("await sleep(WALK_PAGE_DELAY_MS);") &&
  !grab("walkAndCount", mainSrc).includes("await sleep(COUNT_REQUEST_DELAY_MS);"));

const passed = results.filter((r) => r.pass).length;
console.log(`\n================ ${passed}/${results.length} passed ================`);
process.exit(passed === results.length ? 0 : 1);
