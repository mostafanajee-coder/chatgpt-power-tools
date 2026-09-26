/**
 * v3.12.0 Local conversation archive.
 *
 * Loads the REAL src/content/archive.js into node:vm with a fake
 * chrome.storage.local, plus the relevant pieces of mainWorld.js and
 * background.js, and checks the rules that keep the archive correct:
 * image identity across page/API, merge semantics, safe HTML output,
 * storage round-trips, and the wiring between the scripts.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveSrc = fs.readFileSync(path.join(REPO, "src/content/archive.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(REPO, "src/content/index.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(REPO, "src/page/mainWorld.js"), "utf8");
const bgSrc = fs.readFileSync(path.join(REPO, "src/background/background.js"), "utf8");
const popupJs = fs.readFileSync(path.join(REPO, "src/popup/popup.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(REPO, "src/popup/popup.html"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "manifest.json"), "utf8"));

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
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const local = {
    get(keys, cb) {
      const out = {};
      if (keys === null || keys === undefined) Object.assign(out, clone(data));
      else (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in data) out[k] = clone(data[k]); });
      cb(out);
    },
    set(obj, cb) { for (const k of Object.keys(obj)) data[k] = clone(obj[k]); if (cb) cb(); },
    remove(keys, cb) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete data[k]); if (cb) cb(); },
    getKeys: async () => Object.keys(data),
    getBytesInUse(_k, cb) { cb(JSON.stringify(data).length); }
  };
  return { data, local };
}

function loadArchive(storage) {
  const ctx = { chrome: { storage: { local: storage.local } }, URL, console };
  vm.createContext(ctx);
  vm.runInContext(archiveSrc, ctx);
  return ctx.TurboGPTArchive;
}

const storage = makeStorage();
const A = loadArchive(storage);

/* ---------------- 1. Image identity ---------------- */
console.log("--- PART 1: image identity (page URL vs API pointer) ---");

check("file-service pointer -> file id", A.imageKeyFromPointer("file-service://file-AbC123xyz") === "file-AbC123xyz");
check("sediment pointer -> lower-cased file_ id",
  A.imageKeyFromPointer("sediment://file_00000000ABCDEF1234") === "file_00000000abcdef1234",
  A.imageKeyFromPointer("sediment://file_00000000ABCDEF1234"));
check("signed URL: same key whatever the query/signature",
  A.imageKeyForUrl("https://files.oaiusercontent.com/file-AbC123xyz?se=1&sig=aaa") === "file-AbC123xyz" &&
  A.imageKeyForUrl("https://files.oaiusercontent.com/file-AbC123xyz?se=2&sig=bbb") === "file-AbC123xyz");
check("estuary URL carries the file id in its query",
  A.imageKeyForUrl("https://chatgpt.com/backend-api/estuary/content?id=file_00000000abcdef1234&ts=1&sig=x") === "file_00000000abcdef1234");
const uuidUrlKey = A.imageKeyForUrl("https://sdmntprwestus.oaiusercontent.com/files/00000000-2d44-6230-8f1c-2ee3d1ecd8f8/raw?se=1&sig=z");
check("files/<uuid> URL maps to the sediment pointer's key",
  uuidUrlKey === A.imageKeyFromPointer("sediment://file_000000002d4462308f1c2ee3d1ecd8f8"), uuidUrlKey);
check("unknown host URL: stable path-based key, query ignored",
  A.imageKeyForUrl("https://x.example/a/b.png?v=1") === A.imageKeyForUrl("https://x.example/a/b.png?v=2") &&
  A.imageKeyForUrl("https://x.example/a/b.png").startsWith("u_"));
check("'files.' host name is not mistaken for a file id",
  !A.imageKeyForUrl("https://files.example.com/pic.png").startsWith("file"));

{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(grab("archiveImageKey", mainSrc) + "\nglobalThis.k = archiveImageKey;", ctx);
  const samples = [
    "file-service://file-AbC123xyz", "sediment://file_00000000ABCDEF1234",
    "sediment://file_000000002d4462308f1c2ee3d1ecd8f8", "nope://x", ""
  ];
  const agree = samples.every((s) => ctx.k(s) === A.imageKeyFromPointer(s));
  check("mainWorld archiveImageKey and archive.js agree on every pointer", agree);
}

/* ---------------- 2. API -> archive messages ---------------- */
console.log("\n--- PART 2: API messages -> archive messages ---");
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(grab("archiveImageKey", mainSrc) + "\n" + grab("apiMessagesToArchive", mainSrc) +
    "\nglobalThis.conv = apiMessagesToArchive;", ctx);
  const out = ctx.conv([
    { id: "s", author: { role: "system" }, content: { parts: ["sys"] } },
    { id: "u1", author: { role: "user" }, create_time: 100, content: { content_type: "multimodal_text", parts: [
      { content_type: "image_asset_pointer", asset_pointer: "file-service://file-Upload01", width: 800, height: 600 },
      "What is in this picture?"
    ] } },
    { id: "a1", author: { role: "assistant" }, create_time: 101, content: { parts: ["A **cat**."] } },
    { id: "t1", author: { role: "tool" }, content: { parts: ["search results noise"] } },
    { id: "t2", author: { role: "tool" }, content: { parts: [
      { content_type: "image_asset_pointer", asset_pointer: "sediment://file_00000000aa11bb22" }
    ] } },
    { id: "h", author: { role: "assistant" }, metadata: { is_visually_hidden_from_conversation: true }, content: { parts: ["hidden"] } }
  ]);
  const ids = out.map((m) => m.id).join(",");
  check("keeps user/assistant, image-carrying tool msgs; drops system, text-only tool, hidden", ids === "u1,a1,t2", ids);
  check("multimodal user message keeps text and its image pointer",
    out[0].text === "What is in this picture?" && out[0].images.length === 1 &&
    out[0].images[0].key === "file-Upload01" && out[0].images[0].width === 800);
  check("generated image (tool) is a ChatGPT message with no text", out[2].role === "ChatGPT" && out[2].text === "" && out[2].images[0].key === "file_00000000aa11bb22");
  check("server messages carry create_time and origin=server", out[1].createTime === 101 && out[1].origin === "server");
}

/* ---------------- 3. Merge rules ---------------- */
console.log("\n--- PART 3: merge rules ---");

const S = (id, text, t, extra = {}) => ({ id, role: extra.role || "ChatGPT", text, createTime: t, origin: "server", images: extra.images || [] });
const D = (id, text, capturedAt, extra = {}) => ({ id, role: extra.role || "ChatGPT", text, origin: "dom", capturedAt, images: extra.images || [] });
const idsOf = (arr) => arr.map((m) => m.id).join(",");
const T = 1_700_000_000; // seconds

check("empty archive takes the snapshot as-is",
  idsOf(A.mergeMessages([], [S("a", "1", T), S("b", "2", T + 1)], { complete: true })) === "a,b");

{
  const ex = [S("a", "1", T), S("b", "2", T + 1), S("c", "old branch", T + 2)];
  const r = A.mergeMessages(ex, [S("a", "1", T), S("b", "2", T + 1), S("d", "edited", T + 50)], { complete: true });
  check("complete snapshot replaces an abandoned branch", idsOf(r) === "a,b,d", idsOf(r));
}
{
  const ex = [S("a", "1", T), S("b", "2", T + 1), D("x", "sent after snapshot", (T + 500) * 1000)];
  const r = A.mergeMessages(ex, [S("a", "1", T), S("b", "2", T + 1), S("c", "3", T + 2)], { complete: true });
  check("complete snapshot keeps a page-captured message newer than the snapshot", idsOf(r) === "a,b,c,x", idsOf(r));
}
{
  const ex = [S("a", "1", T), D("y", "old branch, captured earlier", (T + 10) * 1000)];
  const r = A.mergeMessages(ex, [S("a", "1", T), S("b2", "new", T + 60)], { complete: true });
  check("complete snapshot drops page-captured messages of an older branch", idsOf(r) === "a,b2", idsOf(r));
}
{
  const ex = [S("a", "1", T), S("b", "2", T + 1), S("c", "3", T + 2), S("d", "4", T + 3)];
  const r = A.mergeMessages(ex, [S("c", "3", T + 2), S("d", "4", T + 3)], { complete: true });
  check("a shorter 'complete' snapshot with no new id is treated as truncated, nothing lost", idsOf(r) === "a,b,c,d", idsOf(r));
}
{
  const ex = [S("a", "1", T), S("b", "2", T + 1), S("c", "3", T + 2), D("x", "live", (T + 900) * 1000)];
  const r = A.mergeMessages(ex, [S("b", "2 updated", T + 1), S("c", "3 updated", T + 2)], { complete: false });
  check("partial slice replaces only the range it covers", idsOf(r) === "a,b,c,x" && r[1].text === "2 updated", idsOf(r));
}
{
  const ex = [S("c", "3", T + 20), S("d", "4", T + 30)];
  const r = A.mergeMessages(ex, [S("a", "1", T), S("b", "2", T + 1)], { complete: false });
  check("older non-overlapping page is prepended by time", idsOf(r) === "a,b,c,d", idsOf(r));
}
{
  const ex = [D("a", "page text", 5, { images: [{ key: "k1", hash: "h1" }] })];
  const r = A.mergeMessages(ex, [S("a", "server markdown", T, { images: [{ key: "k2", pointer: "file-service://file-k2xxxx" }] })], { complete: true });
  check("server text replaces page text and images are unioned",
    r[0].text === "server markdown" && r[0].origin === "server" && r[0].images.map((i) => i.key).join(",") === "k1,k2");
}
{
  const ex = [S("a", "server markdown", T)];
  const r = A.upsertMessage(ex, D("a", "page reconstruction", Date.now()));
  check("page capture never overwrites server text", r[0].text === "server markdown");
  const r2 = A.mergeMessages([S("a", "keep me", T)], [S("a", "", T)], { complete: true });
  check("an empty incoming text never erases a real one", r2[0].text === "keep me");
}

/* ---------------- 4. Upsert + images ---------------- */
console.log("\n--- PART 4: live upsert and image attachment ---");
{
  let msgs = [S("a", "1", T), S("c", "3", T + 2)];
  msgs = A.upsertMessage(msgs, D("b", "2", Date.now()), { prevId: "a", nextId: "c" });
  check("new page message is placed after its DOM predecessor", idsOf(msgs) === "a,b,c", idsOf(msgs));
  msgs = A.upsertMessage(msgs, D("z", "0", Date.now()), { prevId: "missing", nextId: "a" });
  check("falls back to the DOM successor when the predecessor is unknown", idsOf(msgs) === "z,a,b,c", idsOf(msgs));
  msgs = A.upsertMessage(msgs, D("b", "2 finished", Date.now()));
  check("re-capturing a page message refreshes its text", msgs.find((m) => m.id === "b").text === "2 finished");

  msgs = A.attachImage(msgs, "b", { key: "img1", hash: "H" });
  msgs = A.attachImage(msgs, "b", { key: "img1", hash: "H" });
  check("attaching the same image twice keeps one", msgs.find((m) => m.id === "b").images.length === 1);
  msgs = A.attachImage(msgs, "b", { key: "img-other-key", hash: "H" });
  check("same picture under another key (same content hash) is not duplicated", msgs.find((m) => m.id === "b").images.length === 1);
  msgs = A.attachImage(msgs, "img-only", { key: "img2" }, { role: "user", prevId: "c" });
  const stub = msgs.find((m) => m.id === "img-only");
  check("image-only message gets a stub in the right place",
    !!stub && stub.role === "User" && stub.text === "" && idsOf(msgs).endsWith("c,img-only"), idsOf(msgs));
  const noStub = A.attachImage(msgs, "unknown", { key: "img3" });
  check("without stub info an unknown message is left alone", noStub.length === msgs.length);
}

/* ---------------- 5. Markdown -> HTML safety ---------------- */
console.log("\n--- PART 5: markdown rendering is safe ---");
{
  const html = A.renderMarkdown([
    "# Title <b>x</b>",
    "Hello <script>alert(1)</script> **bold** and `a<b>` and [ok](https://example.com?a=1&b=2) and [bad](javascript:alert(1))",
    "",
    "```js",
    "if (a < b) { console.log('</code>'); }",
    "```",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "> quoted"
  ].join("\n"));
  check("raw HTML is escaped, never executed", !html.includes("<script>") && html.includes("&lt;script&gt;") && !html.includes("<b>x</b>"));
  check("javascript: links are not linked", !/href="javascript/i.test(html) && html.includes("bad"));
  check("https links are linked safely", html.includes('href="https://example.com?a=1&amp;b=2"') && html.includes('rel="noopener noreferrer"'));
  check("code fences keep content escaped with language class",
    html.includes('<pre><code class="language-js">') && html.includes("if (a &lt; b)") && html.includes("&lt;/code&gt;"));
  check("inline code is escaped", html.includes("<code>a&lt;b&gt;</code>"));
  check("tables, lists, quotes, headings render",
    html.includes("<table>") && html.includes("<th>A</th>") && html.includes("<ul><li>one</li><li>two</li></ul>") &&
    html.includes("<ol><li>first</li>") && html.includes("<blockquote>") && html.includes("<h1>"));
  check("bold renders", html.includes("<strong>bold</strong>"));
}

/* ---------------- 6. Exports ---------------- */
console.log("\n--- PART 6: HTML and Markdown exports ---");
{
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const archive = {
    conversationId: "c1",
    title: "My <chat>",
    messages: [
      { id: "u", role: "User", text: "صورة؟", images: [{ key: "k1" }, { key: "k1dup" }] },
      { id: "a", role: "ChatGPT", text: "Here:", images: [{ key: "missing" }, { key: "evil" }] }
    ]
  };
  const images = new Map([
    ["k1", { dataUrl: PNG, hash: "same" }],
    ["k1dup", { dataUrl: PNG, hash: "same" }],
    ["evil", { dataUrl: 'data:image/png;base64,AAA" onerror="alert(1)', hash: "x" }]
  ]);
  const html = A.buildHtmlExport(archive, images, { exportedAt: "now" });
  check("HTML embeds the image as a data URL", html.includes(`<img src="${PNG}"`));
  check("the same picture is embedded once per message", html.split(PNG).length - 1 === 1, `${html.split(PNG).length - 1}`);
  check("missing image shows a placeholder, not a broken link", html.includes("Image not saved locally"));
  check("a malformed data URL is never written into the page", !html.includes("onerror"));
  check("title is escaped", html.includes("My &lt;chat&gt;") && !html.includes("My <chat>"));
  check("message text direction follows its language (dir=auto)", html.includes('class="content" dir="auto"'));
  check("HTML is a complete standalone document", html.startsWith("<!DOCTYPE html>") && html.includes('<meta charset="utf-8">'));

  const cite = "Result. fileciteturn0file0L169628-L169728 Done";
  const citeArchive = { conversationId: "c2", title: "t", messages: [{ id: "x", role: "ChatGPT", text: cite, images: [] }] };
  const citeHtml = A.buildHtmlExport(citeArchive, new Map(), {});
  const citeMd = A.buildMarkdownExport(citeArchive, {});
  check("ChatGPT citation tokens (seen live) are removed from both exports",
    !/[-]|filecite|turn0file0/.test(citeHtml) && !/[-]|filecite/.test(citeMd) &&
    citeMd.includes("Result.") && citeMd.includes("Done"));
  check("the server full export drops citation tokens too",
    mainSrc.includes(".replace(/\\uE200[^\\uE201]*\\uE201/g, \"\")"));

  const md = A.buildMarkdownExport(archive, { exportedAt: "now" });
  check("Markdown export never contains image bytes", !md.includes("data:image"));
  check("Markdown export notes images live in the HTML export", md.includes("included in the HTML export") && md.includes("### User:"));
}

/* ---------------- 7. Storage adapter ---------------- */
console.log("\n--- PART 7: storage adapter ---");
{
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  storage.data.turbogpt_settings = { enabled: true };
  const a = A.emptyArchive("conv-1");
  a.title = "T";
  a.messages = [S("m1", "hi", T, { role: "User" })];
  await A.saveConversation(a);
  const loaded = await A.loadConversation("conv-1");
  check("conversation round-trips through storage", loaded && loaded.messages[0].text === "hi" && loaded.title === "T");
  check("missing conversation loads as null", (await A.loadConversation("nope")) === null);

  const rec = await A.saveImage("k1", { dataUrl: PNG, mime: "image/png" });
  check("image saves with a content hash", !!rec && typeof rec.hash === "string");
  check("hasImage reflects the saved image", (await A.hasImage("k1")) === true && (await A.hasImage("k2")) === false);
  const unsafe = await A.saveImage("bad", { dataUrl: "javascript:alert(1)" });
  check("non-image data is refused", unsafe === false && (await A.hasImage("bad")) === false);
  const imgs = await A.loadImages(["k1", "k1", "absent"]);
  check("loadImages returns only stored images", imgs.size === 1 && imgs.get("k1").dataUrl === PNG);

  const st = await A.stats();
  check("stats count conversations and images", st.conversations === 1 && st.images === 1 && st.bytes > 0, JSON.stringify(st));

  const removed = await A.clearAll();
  check("clearAll removes only archive keys", removed >= 3 && !!storage.data.turbogpt_settings &&
    !Object.keys(storage.data).some((k) => k.startsWith("turbogpt_archive_")), Object.keys(storage.data).join(","));
}

/* ---------------- 8. Background image fetcher guard ---------------- */
console.log("\n--- PART 8: background fetcher host guard ---");
{
  const ctx = { URL };
  vm.createContext(ctx);
  vm.runInContext("const IMAGE_HOST_RE = /(^|\\.)(chatgpt\\.com|openai\\.com|oaiusercontent\\.com)$/i;\n" +
    grab("isAllowedImageUrl", bgSrc) + "\nglobalThis.ok = isAllowedImageUrl;", ctx);
  check("OpenAI file hosts are allowed",
    ctx.ok("https://files.oaiusercontent.com/file-x") && ctx.ok("https://sdmntprwestus.oaiusercontent.com/files/x") && ctx.ok("https://chatgpt.com/backend-api/estuary/content?id=x"));
  check("other hosts, lookalikes and plain http are refused",
    !ctx.ok("https://evil.com/x") && !ctx.ok("https://chatgpt.com.evil.com/x") && !ctx.ok("http://chatgpt.com/x") && !ctx.ok("file:///etc/passwd"));
  check("background only serves this extension's own scripts", bgSrc.includes("if (sender.id !== chrome.runtime.id)"));
  check("background host regex matches the tested one",
    bgSrc.includes("const IMAGE_HOST_RE = /(^|\\.)(chatgpt\\.com|openai\\.com|oaiusercontent\\.com)$/i;"));
}

/* ---------------- 9. Wiring ---------------- */
console.log("\n--- PART 9: wiring between scripts ---");

const cs = manifest.content_scripts.find((c) => c.js.includes("src/content/index.js"));
check("manifest loads archive.js before index.js", cs && cs.js.indexOf("src/content/archive.js") === 0 && cs.js.indexOf("src/content/index.js") === 1);
check("manifest grants unlimitedStorage and the image host", manifest.permissions.includes("unlimitedStorage") &&
  manifest.host_permissions.includes("https://*.oaiusercontent.com/*"));
check("archive is on by default everywhere",
  bgSrc.includes("enableLocalArchive: true") && popupJs.includes("enableLocalArchive: true") && contentSrc.includes("enableLocalArchive: true"));
check("existing users get the new default without losing their settings",
  bgSrc.includes("const merged = { ...DEFAULT_SETTINGS, ...current };"));
check("popup exposes the toggle, stats and delete button, and loads archive.js",
  popupHtml.includes('id="toggleLocalArchive"') && popupHtml.includes('id="archiveStats"') &&
  popupHtml.includes('id="clearArchiveBtn"') && popupHtml.includes('<script src="../content/archive.js"></script>'));
check("popup backup no longer loads the archive into memory",
  popupJs.includes('filter((k) => !k.startsWith("turbogpt_archive_"))'));

check("mainWorld feeds the archive from every payload path (open, export, booster-off/older pages, count walk, history fill)",
  (mainSrc.match(/postArchiveSnapshot\(/g) || []).length === 9);

/* ---------------- 10. Real ChatGPT history endpoint (verified live) ---------------- */
console.log("\n--- PART 10: live-verified history endpoint ---");
{
  const ctx = { window: { location: { origin: "https://chatgpt.com" } }, URL };
  vm.createContext(ctx);
  vm.runInContext([
    grab("messagesEndpointFor", mainSrc),
    grab("buildOlderMessagesUrl", mainSrc),
    grab("isOlderMessagesUrl", mainSrc),
    "globalThis.ep = messagesEndpointFor; globalThis.older = buildOlderMessagesUrl; globalThis.isOlder = isOlderMessagesUrl;"
  ].join("\n"), ctx);
  const cid = "6aaeb31d-6d58-83ed-8679-ab19b5e82071";
  const open = `https://chatgpt.com/backend-api/conversations/${cid}?include_has_versions=true&num_turns=10`;
  const e = ctx.ep(open);
  check("opening request with num_turns is recognised as the current client", !!e && e.conversationId === cid && e.numTurns === "10");
  check("legacy opening request (no num_turns) keeps the old pagination path",
    ctx.ep(`https://chatgpt.com/backend-api/conversation/${cid}`) === null &&
    ctx.ep(`https://chatgpt.com/backend-api/conversations/${cid}`) === null);
  const url = new URL(ctx.older(e, "msg-123"));
  check("older page URL matches ChatGPT's own request exactly",
    url.pathname === `/backend-api/conversations/${cid}/messages` &&
    url.searchParams.get("before") === "msg-123" &&
    url.searchParams.get("include_has_versions") === "true" &&
    url.searchParams.get("num_turns") === "10", url.toString());
  check("older-page requests are recognised (and only GETs)",
    ctx.isOlder(url.toString(), "GET") && !ctx.isOlder(url.toString(), "POST") && !ctx.isOlder(open, "GET"));
  check("server walks use the real endpoint instead of guessing parameter names",
    grab("resolveBackwardPagination", mainSrc).includes('source: "messages-endpoint"') &&
    mainSrc.includes("if (pagesFetched === 0 && !loadObservedPagination() && !messagesEndpointFor(baseUrl)) {"));
  check("ChatGPT's own older pages are archived untouched in both booster modes",
    mainSrc.includes("if (isOlderMessagesUrl(url, method)) {\n      const res = await originalFetch.apply(this, args);\n      archiveFromUntouchedResponse(res, url);") &&
    mainSrc.includes("|| isOlderMessagesUrl(url, method)) {"));
  check("history fill is throttled, resumable and stops on refusal",
    mainSrc.includes("const BACKFILL_PAGE_DELAY_MS = 1500;") &&
    contentSrc.includes("before: a.oldestCursor,") &&
    contentSrc.includes("backfillState.stoppedFor.add(result.conversationId);"));
}

{
  const a = A.emptyArchive("c");
  a.messages = A.mergeMessages([], [S("n1", "newest page", T + 100)], { complete: false });
  A.updateHistoryCursor(a, { messages: [S("n1", "", T + 100)], cursor: { start: "n1", hasPrevious: true } });
  check("first page sets the resume cursor", a.oldestCursor === "n1" && !a.reachedStart);
  a.messages = A.mergeMessages(a.messages, [S("o1", "older", T)], { complete: false });
  A.updateHistoryCursor(a, { messages: [S("o1", "", T)], cursor: { start: "o1", hasPrevious: true } });
  check("an older page at the edge moves the cursor back", a.oldestCursor === "o1" && a.messages[0].id === "o1");
  a.messages = A.mergeMessages(a.messages, [S("n1", "newest page", T + 100), S("n2", "brand new", T + 200)], { complete: false });
  A.updateHistoryCursor(a, { messages: [S("n1", "", T + 100)], cursor: { start: "n1", hasPrevious: true } });
  check("re-opening the chat (newest page) never resets the cursor", a.oldestCursor === "o1");
  A.updateHistoryCursor(a, { messages: [], cursor: { start: "x", hasPrevious: false } });
  check("the last page marks the archive complete from the first message", a.reachedStart === true);
}
check("archive still works with the speed booster switched off (untouched response is cloned, not modified)",
  mainSrc.includes("archiveFromUntouchedResponse(res, url);\n        return res;") &&
  mainSrc.includes("try { copy = response.clone(); } catch { return; }"));
check("mainWorld re-sends the last snapshot on request (content script loads late)",
  mainSrc.includes('e.data.type !== "turbogpt-request-archive-snapshot"') &&
  contentSrc.includes('window.postMessage({ type: "turbogpt-request-archive-snapshot" }, "*");'));
check("mainWorld resolves missing images through ChatGPT's file endpoint only on request",
  mainSrc.includes('e.data.type !== "turbogpt-resolve-image"') && mainSrc.includes("/backend-api/files/"));

check("content script ingests snapshots and resolved images",
  contentSrc.includes('e.data.type === "turbogpt-archive-snapshot"') && contentSrc.includes('e.data.type === "turbogpt-resolved-image"'));
check("messages are captured only after streaming ends, in idle time",
  contentSrc.includes("if (!isStreaming) scheduleArchiveCapture();") && contentSrc.includes("requestIdleCallback(run"));
check("archive work waits for stored settings (respects the off switch)",
  (contentSrc.match(/await settingsReady;\n\s+if \(!archiveEnabled\(\)\) return;/g) || []).length === 2);
check("pending archive writes are flushed when the tab is hidden or closed",
  contentSrc.includes("archiveRun(archiveFlushNow);") && contentSrc.includes('window.addEventListener("pagehide"'));
check("export modal has the two local buttons, independent of message selection",
  contentSrc.includes('id="turbogpt-export-local-html"') && contentSrc.includes('id="turbogpt-export-local-md"') &&
  contentSrc.includes('.turbogpt-export-option-btn:not(.turbogpt-local-btn)'));
check("local export captures what is on screen first, then reads storage only",
  contentSrc.includes("await archiveCaptureLive({ all: true });") && contentSrc.includes("return Archive.loadConversation(convId);"));

const totalPassed = results.filter((r) => r.pass).length;
console.log(`\n================ ${totalPassed}/${results.length} passed ================`);
process.exit(totalPassed === results.length ? 0 : 1);
