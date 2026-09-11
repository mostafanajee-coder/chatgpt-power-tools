/**
 * TurboGPT stats-flow + temporary-chat harness.
 * Extracts the REAL popup renderStats() and the REAL content-script helpers
 * from source and exercises them. Zero dependencies, outside the project.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROOT = path.join(REPO, "src");
const popupSrc = fs.readFileSync(path.join(ROOT, "popup/popup.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(ROOT, "content/index.js"), "utf8");

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

/* ---------------- popup renderStats, extracted verbatim ---------------- */

// includes FAILURE_LABELS + failureLabel(), which renderStats now depends on
const renderStatsSrc = popupSrc.slice(
  popupSrc.indexOf("const FAILURE_LABELS = {"),
  popupSrc.indexOf("function getCurrentSettings()")
);

function makePopup() {
  const els = {
    statMemorySaved: { textContent: "" },
    statShown: { textContent: "" },
    statHidden: { textContent: "" },
    statCountNote: { textContent: "" },
    memoryRingFill: { setAttribute() {} }
  };
  const ctx = {
    document: { getElementById: (id) => els[id] || null },
    Number, Math, String, Object, console
  };
  vm.createContext(ctx);
  vm.runInContext(`${renderStatsSrc}\nglobalThis.__render = renderStats;`, ctx);
  return {
    render: (s) => { ctx.__render(s); return {
      shown: els.statShown.textContent,
      hidden: els.statHidden.textContent,
      note: els.statCountNote.textContent,
      mem: els.statMemorySaved.textContent
    }; }
  };
}

/* ------------- content-script helpers, extracted verbatim -------------- */

function grab(name, src) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  let depth = 0, i = src.indexOf("{", start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

function makeContent({ href, domUserTurns = 0, title = "" }) {
  const ctx = {
    window: { location: { href, pathname: new URL(href).pathname } },
    document: {
      title,
      querySelectorAll: (sel) =>
        sel.includes('author-role="user"') ? new Array(domUserTurns).fill({}) : []
    },
    URL, Date, Math, String, Number, console
  };
  vm.createContext(ctx);
  const code = [
    grab("getConversationId", contentSrc),
    grab("isTemporaryChat", contentSrc),
    grab("countDomUserTurns", contentSrc),
    grab("timestampSlug", contentSrc),
    grab("cleanTitle", contentSrc),
    grab("sanitizeFilename", contentSrc),
    grab("extractConversationContent", contentSrc).replace(
      /const turns = [^;]+;/,
      "const turns = [];"
    ),
    `globalThis.api = { getConversationId, isTemporaryChat, countDomUserTurns, cleanTitle, sanitizeFilename };`
  ].join("\n");
  vm.runInContext(code, ctx);
  return ctx.api;
}

/* ------------------------------- tests -------------------------------- */

console.log("--- PART A: 0/0 regression ---");
const popup = makePopup();

// 1. stats present + matching id
let r = popup.render({ available: true, visibleTurns: 2, totalTurns: 703, countState: "complete" });
check("1. real stats render as 2 / 703", r.shown === "2" && r.hidden === "703", `${r.shown}/${r.hidden}`);
check("1. percentage shown only when complete", r.mem === "100%" || /%$/.test(r.mem), r.mem);

// 2. content script: stats present but page id not extractable -> must NOT be stale
const cNoId = makeContent({ href: "https://chatgpt.com/", domUserTurns: 5 });
const pageId = cNoId.getConversationId();
const statusId = "abc-123";
const definitelyStale = !!pageId && !!statusId && pageId !== statusId;
check("2. missing page id is NOT treated as a mismatch", definitelyStale === false, `pageId=${pageId}`);

// 3. stats undefined -> initializing, never 0/0
r = popup.render(undefined);
check("3. no stats -> em-dash, not 0", r.shown === "—" && r.hidden === "—", `${r.shown}/${r.hidden}`);
check("3. no stats -> waiting note", /Waiting/.test(r.note), r.note);

r = popup.render({ available: false, countState: "initializing" });
check("3b. explicit unavailable -> not 0/0", r.shown === "—" && r.hidden === "—", `${r.shown}/${r.hidden}`);

// the exact live failure: content replied with nothing usable
r = popup.render({ visibleTurns: undefined, totalTurns: undefined, countState: undefined });
check("3c. LIVE BUG: undefined fields no longer become 0 / 0",
  !(r.shown === "0" && r.hidden === "0"), `${r.shown}/${r.hidden}`);

// 4. genuinely empty conversation
r = popup.render({ available: true, visibleTurns: 0, totalTurns: 0, countState: "complete" });
check("4. true empty chat may show 0 / 0", r.shown === "0" && r.hidden === "0", `${r.shown}/${r.hidden}`);

// counting / partial / error states
r = popup.render({ available: true, visibleTurns: 2, totalTurns: 0, countState: "counting" });
check("5. counting -> 2 / … + Counting note", r.shown === "2" && r.hidden === "…" && /Counting/.test(r.note), `${r.shown}/${r.hidden} ${r.note}`);
r = popup.render({ available: true, visibleTurns: 2, totalTurns: 315, countState: "partial" });
check("5b. partial -> 2 / 315+ marked not final", r.hidden === "315+" && /not final/.test(r.note), `${r.hidden} ${r.note}`);

// the live 2 / 5+ case: the reason must now be visible
r = popup.render({ available: true, visibleTurns: 2, totalTurns: 5, countState: "partial", countFailureReason: "pagination-contract-unknown" });
check("5b-i. LIVE 2/5+ now states the reason",
  r.hidden === "5+" && /Partial — pagination cursor unavailable/.test(r.note), `${r.hidden} ${r.note}`);
r = popup.render({ available: true, visibleTurns: 2, totalTurns: 5, countState: "partial", countFailureReason: "http-429" });
check("5b-ii. rate limit reason humanised", /rate limited/.test(r.note), r.note);
r = popup.render({ available: true, visibleTurns: 2, totalTurns: 5, countState: "partial", countFailureReason: "http-403" });
check("5b-iii. unmapped http reason still shown", /403/.test(r.note), r.note);
r = popup.render({ available: true, visibleTurns: 1, totalTurns: 5, countState: "partial", countFailureReason: "no-progress" });
check("5b-iv. no-progress shows exact count without + and calculates savedPct",
  r.shown === "1" && r.hidden === "5" && r.mem === "80%" && r.note === "", `${r.shown}/${r.hidden} ${r.mem} ${r.note}`);
r = popup.render({ available: true, visibleTurns: 1, totalTurns: 5, countState: "partial", countFailureReason: "empty-page" });
check("5b-v. empty-page shows exact count without + and calculates savedPct",
  r.shown === "1" && r.hidden === "5" && r.mem === "80%" && r.note === "", `${r.shown}/${r.hidden} ${r.mem} ${r.note}`);
r = popup.render({ available: true, visibleTurns: 2, totalTurns: null, countState: "error" });
check("5c. error -> 2 / ? unavailable", r.hidden === "?" && /unavailable/i.test(r.note), `${r.hidden} ${r.note}`);
r = popup.render({ available: false, countState: "switching" });
check("6. chat switch -> no previous numbers", r.shown === "—" && r.hidden === "—" && /Switching/.test(r.note), `${r.shown}/${r.hidden}`);

console.log("\n--- PART B: temporary chat ---");

// 8. detection
const temp = makeContent({ href: "https://chatgpt.com/?temporary-chat=true", domUserTurns: 18, title: "ChatGPT" });
check("8. ?temporary-chat=true detected", temp.isTemporaryChat() === true);
const normal = makeContent({ href: "https://chatgpt.com/c/aaaa-bbbb", domUserTurns: 4, title: "My chat - ChatGPT" });
check("8b. normal chat not flagged temporary", normal.isTemporaryChat() === false);
const tricky = makeContent({ href: "https://chatgpt.com/c/x?temporary-chat=false", domUserTurns: 1, title: "x" });
check("8c. temporary-chat=false not flagged", tricky.isTemporaryChat() === false);

// 9. export without conversationId
check("9. temporary chat has no conversationId", temp.getConversationId() === null);
let exportOk = true, exportErr = "";
try {
  const t = temp.cleanTitle();
  const f = temp.sanitizeFilename(t);
  check("10. filename fallback without title", /^ChatGPT-Temporary-\d{4}-\d{2}-\d{2}-\d{4}$/.test(f), f);
} catch (e) { exportOk = false; exportErr = e.message; }
check("9b. export path does not crash without conversationId", exportOk, exportErr);

check("10b. normal chat keeps its real title", normal.cleanTitle() === "My chat", normal.cleanTitle());

// 12. local-only counter semantics
check("12. DOM turn count available for temporary chat", temp.countDomUserTurns() === 18);
r = popup.render({ available: true, visibleTurns: 2, totalTurns: 18, countState: "local-only" });
check("12b. temporary renders 2 / 18 labelled local", r.shown === "2" && r.hidden === "18" && /temporary/i.test(r.note), `${r.shown}/${r.hidden} ${r.note}`);
check("12c. temporary count never claims a percentage", r.mem === "—", r.mem);

// scope identity isolation
const scopeSrc = `
${grab("getConversationId", contentSrc)}
${grab("isTemporaryChat", contentSrc)}
let temporarySessionId = null;
${grab("getStatsScopeId", contentSrc)}
globalThis.scope = () => getStatsScopeId();
globalThis.resetTemp = () => { temporarySessionId = null; };
`;
function scopeCtx(href) {
  const ctx = { window: { location: { href, pathname: new URL(href).pathname } }, URL, Date, Math, String, console };
  vm.createContext(ctx); vm.runInContext(scopeSrc, ctx); return ctx;
}
const s1 = scopeCtx("https://chatgpt.com/?temporary-chat=true");
const idA = s1.scope();
s1.resetTemp();
const idB = s1.scope();
check("7. two temporary chats get different scope ids", idA !== idB, `${idA} vs ${idB}`);
check("7b. temporary scope id is namespaced", idA.startsWith("temporary:"), idA);
const s2 = scopeCtx("https://chatgpt.com/c/real-id-123");
check("7c. normal chat scope = conversation id", s2.scope() === "real-id-123", s2.scope());

console.log("\n--- PART C: top-bar Export button ---");

/* Tiny DOM good enough for the injector's selector/insert logic. */
function makeDom({ withShare = true, withUserTurn = true, shareAttr = 'data-testid="share-chat-button"' } = {}) {
  let idSeq = 0;
  const mk = (tag, attrs = {}) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], parentNode: null, attrs,
      id: attrs.id || "", className: attrs.class || "", textContent: attrs.text || "",
      innerHTML: "", listeners: {}, _uid: ++idSeq,
      appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
      insertBefore(c, ref) {
        c.parentNode = el;
        const i = el.children.indexOf(ref);
        el.children.splice(i === -1 ? el.children.length : i, 0, c);
        return c;
      },
      remove() {
        if (!el.parentNode) return;
        const i = el.parentNode.children.indexOf(el);
        if (i !== -1) el.parentNode.children.splice(i, 1);
        el.parentNode = null;
      },
      setAttribute(k, v) { attrs[k] = v; },
      getAttribute(k) { return attrs[k]; },
      addEventListener(t, fn) { (el.listeners[t] ||= []).push(fn); },
      click() { (el.listeners.click || []).forEach((f) => f({ preventDefault() {}, stopPropagation() {} })); },
      closest() { return null; },
      querySelector() { return null; }
    };
    return el;
  };

  const all = [];
  const root = mk("body");
  const header = mk("header");
  root.appendChild(header);
  all.push(header);
  let share = null;
  if (withShare) {
    share = mk("button", { [shareAttr.split("=")[0]]: shareAttr.split("=")[1].replace(/"/g, ""), text: "Share" });
    header.appendChild(share);
    all.push(share);
  }
  if (withUserTurn) {
    const turn = mk("div", { "data-message-author-role": "user" });
    root.appendChild(turn);
    all.push(turn);
  }

  const walk = (n, out = []) => { out.push(n); n.children.forEach((c) => walk(c, out)); return out; };
  const matches = (el, sel) => {
    if (sel.startsWith("#")) return el.id === sel.slice(1);
    const attr = /^\[([^\]=*]+)(?:\*?=)?"?([^"\]]*)"?(?:\s+i)?\]$/.exec(sel);
    if (attr) {
      const v = el.attrs[attr[1]];
      if (v === undefined) return false;
      return attr[2] === "" || (sel.includes("*=") ? String(v).toLowerCase().includes(attr[2].toLowerCase()) : v === attr[2]);
    }
    const tagAttr = /^(\w+)\[([^\]*=]+)\*?="?([^"\]]*)"?(?:\s+i)?\]$/.exec(sel);
    if (tagAttr) {
      return el.tagName === tagAttr[1].toUpperCase() &&
        String(el.attrs[tagAttr[2]] ?? "").toLowerCase().includes(tagAttr[3].toLowerCase());
    }
    return false;
  };

  const document = {
    body: root,
    getElementById: (id) => walk(root).find((n) => n.id === id) || null,
    querySelector: (sel) => {
      for (const part of sel.split(",").map((s) => s.trim())) {
        const hit = walk(root).find((n) => matches(n, part) || (part === "header" && n.tagName === "HEADER"));
        if (hit) return hit;
      }
      return null;
    },
    querySelectorAll: (sel) => walk(root).filter((n) => sel.split(",").some((p) => matches(n, p.trim()))),
    createElement: (t) => mk(t),
    head: mk("head")
  };
  return { document, root, header, share, walk };
}

function makeInjector(dom) {
  let exportCalls = 0;
  const ctx = {
    document: dom.document,
    appSettings: { enabled: true },
    openExportModal: () => { exportCalls++; },
    console
  };
  vm.createContext(ctx);
  vm.runInContext([
    'const TOPBAR_EXPORT_ID = "turbogpt-export-topbar";',
    grab("findShareButton", contentSrc),
    grab("findTopbarFallbackContainer", contentSrc),
    grab("buildTopbarExportButton", contentSrc),
    grab("injectTopbarExportButton", contentSrc),
    "globalThis.inject = injectTopbarExportButton;"
  ].join("\n"), ctx);
  return { inject: () => ctx.inject(), exportCalls: () => exportCalls, ctx };
}

// 9. Share present -> Export inserted immediately before it
let dom = makeDom();
let inj = makeInjector(dom);
inj.inject();
let btn = dom.document.getElementById("turbogpt-export-topbar");
check("9. Export button injected when Share exists", !!btn);
check("9b. placed as [Export][Share] in Share's container",
  !!btn && btn.parentNode === dom.share.parentNode &&
  dom.header.children.indexOf(btn) < dom.header.children.indexOf(dom.share),
  btn ? `idx ${dom.header.children.indexOf(btn)} vs share ${dom.header.children.indexOf(dom.share)}` : "n/a");

// 10. re-render -> no duplicates
inj.inject(); inj.inject(); inj.inject();
const count = dom.document.querySelectorAll("#x").length; // sanity for matcher
const dupes = dom.walk(dom.root).filter((n) => n.id === "turbogpt-export-topbar").length;
check("10. repeated injection never duplicates the button", dupes === 1, `found ${dupes}`);

// 13. Share missing -> falls back to header container, no crash
let dom2 = makeDom({ withShare: false });
let inj2 = makeInjector(dom2);
let threw = "";
try { inj2.inject(); } catch (e) { threw = e.message; }
check("13. no crash when Share is absent", !threw, threw);
const fb = dom2.document.getElementById("turbogpt-export-topbar");
check("13b. falls back to a top-bar container (not over messages)", !!fb && fb.parentNode === dom2.header);

// 12. temporary chat (no Share, has turns) -> button still appears
check("12. button present in temporary-chat-like DOM", !!fb);

// 11. SPA switch: button removed by React re-render -> re-injected
fb.remove();
inj2.inject();
check("11. re-injected after being torn out by a re-render",
  !!dom2.document.getElementById("turbogpt-export-topbar"));

// empty chat -> stays out of the way
let dom3 = makeDom({ withUserTurn: false });
let inj3 = makeInjector(dom3);
inj3.inject();
check("13c. no button in an empty chat", !dom3.document.getElementById("turbogpt-export-topbar"));

// 14. click -> calls existing export path exactly once
dom.document.getElementById("turbogpt-export-topbar").click();
check("14. click invokes existing openExportModal exactly once", inj.exportCalls() === 1, `${inj.exportCalls()}`);

// 15. counter partial -> export button unaffected (no counter coupling at all)
const injectorSrc = grab("injectTopbarExportButton", contentSrc) + grab("buildTopbarExportButton", contentSrc);
check("15. Export button code never reads counter state",
  !/lastStatus|countState|totalTurns|countComplete/.test(injectorSrc));

console.log("\n--- PART D: Context Window & Token Meter ---");
function makeContextPopup() {
  const els = {
    statMemorySaved: { textContent: "" },
    statShown: { textContent: "" },
    statHidden: { textContent: "" },
    statCountNote: { textContent: "" },
    memoryRingFill: { setAttribute() {} },
    statContextUsed: { textContent: "" },
    statContextRemaining: { textContent: "" },
    statContextTokens: { textContent: "" },
    contextProgressFill: { style: {}, className: "" },
    contextStatusPill: { textContent: "", className: "" }
  };
  const ctx = {
    document: { getElementById: (id) => els[id] || null },
    Number, Math, String, Object, console
  };
  vm.createContext(ctx);
  vm.runInContext(`${renderStatsSrc}\nglobalThis.__render = renderStats;`, ctx);
  return {
    render: (s) => { ctx.__render(s); return {
      used: els.statContextUsed.textContent,
      remaining: els.statContextRemaining.textContent,
      tokens: els.statContextTokens.textContent,
      barWidth: els.contextProgressFill.style.width,
      barClass: els.contextProgressFill.className,
      pillText: els.contextStatusPill.textContent,
      pillClass: els.contextStatusPill.className
    }; }
  };
}

const ctxPopup = makeContextPopup();
const ctxRes1 = ctxPopup.render({
  available: true,
  visibleTurns: 10,
  totalTurns: 10,
  contextStats: {
    totalChars: 289753,
    estimatedTokens: 90548,
    contextUsedPct: 82,
    contextRemainingPct: 18,
    contextRemainingTokens: 19452,
    contextStatus: "warning"
  }
});

check("16. context used percentage rendered correctly", ctxRes1.used === "82% Used", ctxRes1.used);
check("16b. context remaining tokens formatted", ctxRes1.remaining.includes("18% Left"), ctxRes1.remaining);
check("16c. progress bar fill width matches percentage", ctxRes1.barWidth === "82%", ctxRes1.barWidth);
check("16d. progress bar color matches status warning", ctxRes1.barClass.includes("warning"), ctxRes1.barClass);
check("16e. status pill says Heavy on 82%", ctxRes1.pillText === "Heavy", ctxRes1.pillText);

const ctxRes2 = ctxPopup.render({ available: false });
check("17. em-dash shown when context stats unavailable", ctxRes2.used === "—", ctxRes2.used);
check("17b. bar width is 0% on initial", ctxRes2.barWidth === "0%", ctxRes2.barWidth);

// Direct extraction and testing of computeContextUsage
const computeContextUsageSrc = contentSrc.slice(
  contentSrc.indexOf("function computeContextUsage() {"),
  contentSrc.indexOf("function timestampSlug()")
);

function makeContextUsageTester() {
  const turns = [];
  let lastStatus = { totalTurns: 0 };
  const ctx = {
    getAllConversationTurns: () => turns,
    document: { querySelectorAll: () => turns },
    lastStatus,
    Array, Math, String, Number
  };
  vm.createContext(ctx);
  vm.runInContext(`${computeContextUsageSrc}\nglobalThis.__compute = computeContextUsage;`, ctx);
  return {
    setTurns: (newTurns) => { turns.length = 0; turns.push(...newTurns); },
    setLastStatus: (s) => { Object.assign(ctx.lastStatus, s); },
    compute: () => ctx.__compute()
  };
}

const usageTester = makeContextUsageTester();

// 18. Empty turns -> 0% used, 100% remaining
const emptyRes = usageTester.compute();
check("18. computeContextUsage on empty chat returns 0% used", emptyRes.contextUsedPct === 0, `${emptyRes.contextUsedPct}%`);
check("18b. computeContextUsage on empty chat gives 110k remaining tokens", emptyRes.contextRemainingTokens === 110000, `${emptyRes.contextRemainingTokens}`);

// 18c. Simulated 32,000 chars (~10,000 tokens) -> ~9% used, safe
usageTester.setTurns([
  { innerText: "x".repeat(16000), querySelector: () => true, getAttribute: () => "user" },
  { innerText: "y".repeat(16000), querySelector: () => null, getAttribute: () => "assistant" }
]);
const midRes = usageTester.compute();
check("18c. computeContextUsage calculates estimated tokens correctly", midRes.estimatedTokens === 10000, `${midRes.estimatedTokens}`);
check("18d. computeContextUsage assigns safe status under 70%", midRes.contextStatus === "safe", midRes.contextStatus);

// 18e. Server extrapolation: 1 user turn in DOM out of 10 on server
usageTester.setLastStatus({ totalTurns: 10 });
const scaledRes = usageTester.compute();
check("18e. computeContextUsage scales estimation with server totalTurns", scaledRes.estimatedTokens === 100000, `${scaledRes.estimatedTokens}`);
check("18f. computeContextUsage marks danger status over 85%", scaledRes.contextStatus === "danger", `${scaledRes.contextUsedPct}% -> ${scaledRes.contextStatus}`);

const failed = results.filter((x) => !x.pass);
console.log(`\n================ ${results.length - failed.length}/${results.length} passed ================`);
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name} ${f.detail || ""}`);
  process.exitCode = 1;
}
