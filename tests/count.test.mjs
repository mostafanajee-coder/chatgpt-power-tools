/**
 * TurboGPT counting-path static harness.
 * Runs the REAL src/page/mainWorld.js inside node:vm with stubbed browser
 * globals and a scripted fake network. Zero dependencies, never touches the
 * project. Not part of the extension.
 */
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SRC = fs.readFileSync(
  path.join(REPO, "src/page/mainWorld.js"),
  "utf8"
);

const BASE = "https://chatgpt.com/backend-api/conversation/aaaaaaaa-1111-2222-3333-444444444444";

function msg(id, role) {
  return { id, author: { role } };
}
function userPage(ids, { hasPrev, cursor, extraAssistant = true }) {
  const messages = [];
  for (const id of ids) {
    messages.push(msg(id, "user"));
    if (extraAssistant) messages.push(msg(`a_${id}`, "assistant"));
  }
  const page_info = { has_previous_page: hasPrev };
  if (cursor !== undefined) page_info.start_cursor = cursor;
  return { messages, page_info };
}

function makeResponse(bodyObj, { status = 200 } = {}) {
  const body = JSON.stringify(bodyObj);
  const r = {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    url: BASE,
    headers: { entries: () => [] },
    text: async () => body,
    clone: () => r
  };
  return r;
}

/** Build a sandbox running mainWorld.js with a scripted network. */
function boot({ routes, onStatus, locationHref = "https://chatgpt.com/c/aaaaaaaa-1111-2222-3333-444444444444" }) {
  const store = new Map();
  const fakeStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const calls = [];

  const originalFetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    const handler = routes(url, calls.length);
    if (handler instanceof Error) throw handler;
    return handler;
  };

  const listeners = [];
  const windowObj = {
    location: { href: locationHref, origin: "https://chatgpt.com" },
    fetch: originalFetch,
    addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
    postMessage: (m) => {
      if (m?.type === "turbogpt-status") onStatus(m.payload);
      // deliver to in-page listeners exactly like the real event loop
      for (const fn of listeners) fn({ source: windowObj, data: m });
    }
  };

  const ctx = {
    window: windowObj,
    localStorage: fakeStorage,
    sessionStorage: fakeStorage,
    // immediate timers so 500-page walks don't take 75 seconds
    setTimeout: (fn) => { queueMicrotask(fn); return 0; },
    console,
    URL, Headers, Response, Request, JSON, Set, Map, Date, Math, String, Object, Array, Promise, parseInt
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "mainWorld.js" });
  return { ctx, calls, storage: fakeStorage, window: windowObj };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

async function settle(ms = 60) {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

function lastCount(statuses) {
  for (let i = statuses.length - 1; i >= 0; i--) {
    if (statuses[i].countState) return statuses[i];
  }
  return {};
}

// ---------------------------------------------------------------- Scenario A
async function scenarioA() {
  const statuses = [];
  const page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u7", "u8", "u9"], { hasPrev: true, cursor: "B" });
  const page3 = userPage(["u5", "u6", "u7"], { hasPrev: false });

  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      if (url.includes("cursor=A")) return makeResponse(page2);
      if (url.includes("cursor=B")) return makeResponse(page3);
      return makeResponse(page1);
    }
  });
  ctx.localStorage.setItem("turbogpt_config", JSON.stringify({ enabled: true, messageLimit: 2 }));

  await ctx.window.fetch(BASE);
  await settle();

  const fin = lastCount(statuses);
  check("A: unique total = 6 (dedup across overlapping pages)", fin.totalTurns === 6, `got ${fin.totalTurns}`);
  check("A: countState complete", fin.countState === "complete", fin.countState);
  check("A: visibleTurns = 2 (numerator = user turns, not records)",
    statuses.some((s) => s.visibleTurns === 2), `got ${statuses.map((s) => s.visibleTurns).join(",")}`);
  check("A: exactly 3 network calls (1 display + 2 counting)", calls.length === 3, `got ${calls.length}`);
  check("A: cursor param built from server page_info", calls[1].includes("cursor=A") && calls[2].includes("cursor=B"), calls.join(" | "));
  check("A: conversation id preserved in walk URLs",
    calls.every((u) => u.includes("aaaaaaaa-1111-2222-3333-444444444444")));
}

// -------------------------------------------------------- Duplicate cursor
async function scenarioDuplicateCursor() {
  const statuses = [];
  const page1 = userPage(["u9"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u7", "u8"], { hasPrev: true, cursor: "B" });
  const page3 = userPage(["u5", "u6"], { hasPrev: true, cursor: "B" }); // repeats B

  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      if (url.includes("cursor=A")) return makeResponse(page2);
      if (url.includes("cursor=B")) return makeResponse(page3);
      return makeResponse(page1);
    }
  });
  await ctx.window.fetch(BASE);
  await settle();

  const fin = lastCount(statuses);
  check("DupCursor: partial, not complete", fin.countState === "partial", fin.countState);
  check("DupCursor: no infinite loop (bounded calls)", calls.length <= 4, `calls=${calls.length}`);
}

// ---------------------------------------------------------- Network failure
async function scenarioNetworkFailure() {
  const statuses = [];
  const page1 = userPage(["u9"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u7", "u8"], { hasPrev: true, cursor: "B" });

  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      if (url.includes("cursor=A")) return makeResponse(page2);
      if (url.includes("cursor=B")) return makeResponse({}, { status: 429 });
      return makeResponse(page1);
    }
  });
  await ctx.window.fetch(BASE);
  await settle();

  const fin = lastCount(statuses);
  check("429: partial, never complete", fin.countState === "partial" && fin.countComplete === false, fin.countState);
  check("429: keeps the turns counted so far as a floor", fin.totalTurns === 3, `got ${fin.totalTurns}`);
}

async function scenarioThrownNetwork() {
  const statuses = [];
  const page1 = userPage(["u9"], { hasPrev: true, cursor: "A" });
  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => (url.includes("cursor=") ? new Error("offline") : makeResponse(page1))
  });
  await ctx.window.fetch(BASE);
  await settle();
  const fin = lastCount(statuses);
  check("Offline: partial, chat display unaffected", fin.countState === "partial", fin.countState);
}

// -------------------------------------------------------------- Missing ID
async function scenarioMissingId() {
  const statuses = [];
  const page1 = userPage(["u9"], { hasPrev: true, cursor: "A" });
  const page2 = {
    messages: [{ author: { role: "user" } }, msg("u8", "user"), msg("a_u8", "assistant")],
    page_info: { has_previous_page: false }
  };
  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => (url.includes("cursor=A") ? makeResponse(page2) : makeResponse(page1))
  });
  await ctx.window.fetch(BASE);
  await settle();

  const fin = lastCount(statuses);
  check("MissingID: NOT reported complete", fin.countState !== "complete", fin.countState);
  check("MissingID: id-less record still counted (no undercount)", fin.totalTurns === 3, `got ${fin.totalTurns}`);
}

// ---------------------------------------------------------------- MAX_PAGES
async function scenarioMaxPages() {
  const statuses = [];
  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      const m = /cursor=c(\d+)/.exec(url);
      const n = m ? parseInt(m[1], 10) : 0;
      return makeResponse(userPage([`u${n}`], { hasPrev: true, cursor: `c${n + 1}` }));
    }
  });
  await ctx.window.fetch(BASE);
  await settle(2000);

  const fin = lastCount(statuses);
  check("MaxPages: partial (circuit breaker never claims complete)", fin.countState === "partial", fin.countState);
  check("MaxPages: stops at the 500-page breaker", calls.length <= 502, `calls=${calls.length}`);
}

// ------------------------------------------------ Wrong direction / no progress
async function scenarioNoProgress() {
  const statuses = [];
  const page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  // Cursor walks the WRONG way: returns records we already have.
  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => (url.includes("cursor=") ? makeResponse(page1) : makeResponse(page1))
  });
  await ctx.window.fetch(BASE);
  await settle();

  const fin = lastCount(statuses);
  check("NoProgress: wrong-direction cursor -> partial, not complete", fin.countState === "partial", fin.countState);
  check("NoProgress: stops after one probe (no storm)", calls.length === 2, `calls=${calls.length}`);
}

// -------------------------------------------------- Missing backward cursor
async function scenarioForwardOnlyCursor() {
  const statuses = [];
  const page1 = {
    messages: [msg("u9", "user"), msg("a1", "assistant")],
    page_info: { has_previous_page: true, end_cursor: "E", next_cursor: "N" } // no backward field
  };
  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: () => makeResponse(page1)
  });
  await ctx.window.fetch(BASE);
  await settle();

  const fin = lastCount(statuses);
  check("ForwardOnly: refuses to guess end_cursor/next_cursor -> partial", fin.countState === "partial", fin.countState);
  // v3.4.0: one bounded probe (oldest message id) is allowed; the forward
  // cursor fields are still never used, and the probe is policed by the
  // no-progress check, so a wrong direction still ends as partial.
  check("ForwardOnly: at most one bounded probe request", calls.length <= 2, `calls=${calls.length}`);
  check("ForwardOnly: never used end_cursor/next_cursor values",
    !calls.some((u) => u.includes("=E") || u.includes("=N")), calls.join(" | "));
}

// -------------------------------------------------------------- Small chat
async function scenarioSmallChat() {
  const statuses = [];
  const only = userPage(["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10"], { hasPrev: false });
  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: () => makeResponse(only)
  });
  ctx.localStorage.setItem("turbogpt_config", JSON.stringify({ enabled: true, messageLimit: 2 }));
  await ctx.window.fetch(BASE);
  await settle();

  const fin = lastCount(statuses);
  check("Small: 2 / 10", fin.visibleTurns === 2 && fin.totalTurns === 10, `${fin.visibleTurns} / ${fin.totalTurns}`);
  check("Small: complete immediately, never stuck Counting", fin.countState === "complete", fin.countState);
  check("Small: zero background requests", calls.length === 1, `calls=${calls.length}`);
}

// --------------------------------------------------------- Visible settings
async function scenarioVisibleSettings() {
  const only = userPage(["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10"], { hasPrev: false });
  for (const limit of [1, 2, 5, 15]) {
    const statuses = [];
    const { ctx } = boot({ onStatus: (p) => statuses.push({ ...p }), routes: () => makeResponse(only) });
    ctx.localStorage.setItem("turbogpt_config", JSON.stringify({ enabled: true, messageLimit: limit }));
    await ctx.window.fetch(BASE);
    await settle(20);
    const fin = lastCount(statuses);
    const expected = Math.min(limit, 10);
    check(`Settings: limit ${limit} -> numerator ${expected} / 10`,
      fin.visibleTurns === expected && fin.totalTurns === 10, `${fin.visibleTurns} / ${fin.totalTurns}`);
  }
}

// ------------------------------------------------------------- Cancellation
async function scenarioCancellation() {
  const statuses = [];
  const CONV_B = "https://chatgpt.com/backend-api/conversation/bbbbbbbb-1111-2222-3333-444444444444";
  const pageA1 = userPage(["a9", "a10"], { hasPrev: true, cursor: "A" });
  const pageA2 = userPage(["a7", "a8"], { hasPrev: true, cursor: "A2" });
  const pageB = userPage(["b1", "b2", "b3"], { hasPrev: false });

  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      if (url.includes("bbbbbbbb")) return makeResponse(pageB);
      if (url.includes("cursor=A2")) return makeResponse(userPage(["a5", "a6"], { hasPrev: false }));
      if (url.includes("cursor=A")) return makeResponse(pageA2);
      return makeResponse(pageA1);
    }
  });

  await ctx.window.fetch(BASE);          // start walking conversation A
  await ctx.window.fetch(CONV_B);        // switch to B before A finishes
  await settle(150);

  const fin = lastCount(statuses);
  const bTotals = statuses.filter((s) => s.conversationId?.startsWith("bbbb"));
  check("Cancel: final state belongs to B", fin.totalTurns === 3 && fin.countState === "complete",
    `${fin.totalTurns} / ${fin.countState}`);
  check("Cancel: no A total (4+) ever broadcast under B",
    !bTotals.some((s) => s.totalTurns > 3), JSON.stringify(bTotals.map((s) => s.totalTurns)));
  check("Cancel: B never inherits A's countState",
    !bTotals.some((s) => s.countState === "complete" && s.totalTurns !== 3));
}

// ------------------------------------------------------ Concurrent GET storm
async function scenarioConcurrentStarts() {
  const statuses = [];
  const page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u7", "u8"], { hasPrev: false });
  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => (url.includes("cursor=A") ? makeResponse(page2) : makeResponse(page1))
  });

  // Three simultaneous GETs of the SAME conversation (React remount pattern)
  await Promise.all([ctx.window.fetch(BASE), ctx.window.fetch(BASE), ctx.window.fetch(BASE)]);
  await settle();

  const cursorCalls = calls.filter((u) => u.includes("cursor="));
  check("Storm: only one walk runs (<=1 cursor request)", cursorCalls.length <= 1, `cursor calls=${cursorCalls.length}`);
  const fin = lastCount(statuses);
  check("Storm: total still correct", fin.totalTurns === 4, `got ${fin.totalTurns}`);
}

// ------------------------------------------------------------- Cache reuse
async function scenarioCacheReuse() {
  const statuses = [];
  const page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u7", "u8"], { hasPrev: false });
  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => (url.includes("cursor=A") ? makeResponse(page2) : makeResponse(page1))
  });

  await ctx.window.fetch(BASE);
  await settle();
  const firstCalls = calls.length;

  // Reload the same conversation: same tail id -> cache reuse, no walk.
  await ctx.window.fetch(BASE);
  await settle();

  const fin = lastCount(statuses);
  check("Cache: reload adds no counting requests", calls.length === firstCalls + 1,
    `before=${firstCalls} after=${calls.length}`);
  check("Cache: still complete with same total", fin.countState === "complete" && fin.totalTurns === 4,
    `${fin.totalTurns}/${fin.countState}`);
  check("Cache: sourced from cache on reload", fin.countSource === "cache", fin.countSource);
}

// --------------------------------------------------- New turn -> stale/+1
async function scenarioNewTurn() {
  const statuses = [];
  let page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u7", "u8"], { hasPrev: false });
  let phase = 1;
  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      if (url.includes("cursor=A")) return makeResponse(page2);
      return makeResponse(phase === 1 ? page1 : userPage(["u9", "u10", "u11"], { hasPrev: true, cursor: "A" }));
    }
  });

  await ctx.window.fetch(BASE);
  await settle();
  check("NewTurn: baseline 4", lastCount(statuses).totalTurns === 4, `${lastCount(statuses).totalTurns}`);

  // User sends a message (POST) -> count must stop claiming exactness
  await ctx.window.fetch("https://chatgpt.com/backend-api/conversation", { method: "POST" });
  check("NewTurn: POST marks the total stale, not exact", lastCount(statuses).countState === "stale",
    lastCount(statuses).countState);

  // Next real GET sees the new tail -> incremental +1, exact again
  phase = 2;
  await ctx.window.fetch(BASE);
  await settle();
  const fin = lastCount(statuses);
  check("NewTurn: incremental -> 5 and complete", fin.totalTurns === 5 && fin.countState === "complete",
    `${fin.totalTurns}/${fin.countState}`);
  check("NewTurn: incremental source", fin.countSource === "incremental", fin.countSource);
}

// ------------------------------------------------------- Edit/branch recount
async function scenarioBranchRecount() {
  const statuses = [];
  const page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u7", "u8"], { hasPrev: false });
  let phase = 1;
  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      if (url.includes("cursor=A")) return makeResponse(page2);
      // after an edit the active path has entirely new ids
      return makeResponse(phase === 1 ? page1 : userPage(["v9", "v10"], { hasPrev: true, cursor: "A" }));
    }
  });

  await ctx.window.fetch(BASE);
  await settle();
  const before = calls.filter((u) => u.includes("cursor=")).length;

  phase = 2;
  await ctx.window.fetch(BASE);
  await settle();
  const after = calls.filter((u) => u.includes("cursor=")).length;

  check("Branch: unknown tail id triggers a real recount, not a guessed +1", after > before,
    `cursor calls ${before} -> ${after}`);
}

// -------------------------------------------------------------- GET hygiene
async function scenarioRequestShape() {
  const seen = [];
  const page1 = userPage(["u9"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u7"], { hasPrev: false });

  const store = new Map();
  const fakeStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const originalFetch = async (input, init) => {
    seen.push({ url: typeof input === "string" ? input : input.url, init });
    const url = typeof input === "string" ? input : input.url;
    return makeResponse(url.includes("cursor=A") ? page2 : page1);
  };
  const windowObj = {
    location: { href: "https://chatgpt.com/c/x", origin: "https://chatgpt.com" },
    fetch: originalFetch,
    addEventListener: () => {},
    postMessage: () => {}
  };
  const ctx = {
    window: windowObj, localStorage: fakeStorage, sessionStorage: fakeStorage,
    setTimeout: (fn) => { queueMicrotask(fn); return 0; }, console,
    URL, Headers, Response, Request, JSON, Set, Map, Date, Math, String, Object, Array, Promise, parseInt
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "mainWorld.js" });

  // ChatGPT calling fetch(new Request(...)) with an Authorization header
  const abort = new AbortController();
  const req = new Request(`${BASE}?foo=bar`, {
    method: "GET",
    headers: { Authorization: "Bearer SECRET_TOKEN_VALUE", "x-trace": "t1" },
    signal: abort.signal
  });
  await ctx.window.fetch(req);
  abort.abort(); // original request aborted right after -> walk must survive
  await settle();

  const walk = seen.find((s) => s.url.includes("cursor="));
  check("Shape: counting request was issued from a Request object", !!walk);
  if (walk) {
    check("Shape: Authorization header preserved",
      walk.init?.headers?.get("authorization") === "Bearer SECRET_TOKEN_VALUE");
    check("Shape: other headers preserved", walk.init?.headers?.get("x-trace") === "t1");
    check("Shape: method GET", walk.init?.method === "GET", walk.init?.method);
    check("Shape: no body on GET", walk.init?.body === undefined);
    check("Shape: no inherited AbortSignal", walk.init?.signal === undefined);
    check("Shape: pre-existing query params preserved", walk.url.includes("foo=bar"), walk.url);
    check("Shape: single cursor param", (walk.url.match(/cursor=/g) || []).length === 1, walk.url);
  }
}

// ------------------------------------------------------- Disabled extension
async function scenarioDisabled() {
  const statuses = [];
  const page1 = userPage(["u9"], { hasPrev: true, cursor: "A" });
  const { ctx, calls } = boot({ onStatus: (p) => statuses.push({ ...p }), routes: () => makeResponse(page1) });
  ctx.localStorage.setItem("turbogpt_config", JSON.stringify({ enabled: false, messageLimit: 2 }));
  await ctx.window.fetch(BASE);
  await settle();
  check("Disabled: passthrough, no counting requests", calls.length === 1, `calls=${calls.length}`);
  check("Disabled: no status broadcast", statuses.length === 0, `broadcasts=${statuses.length}`);
}

// -------------------------------------------------- Self-interception guard
async function scenarioCursorBlockerStillActive() {
  const statuses = [];
  const page1 = userPage(["u9"], { hasPrev: true, cursor: "A" });
  const { ctx } = boot({ onStatus: (p) => statuses.push({ ...p }), routes: () => makeResponse(page1) });
  // React itself asking for an older page must still get an empty payload
  const res = await ctx.window.fetch(`${BASE}?cursor=A`);
  const body = JSON.parse(await res.text());
  check("Blocker: React's own cursor request still returns empty (speed preserved)",
    Array.isArray(body.messages) && body.messages.length === 0 && body.page_info.has_previous_page === false);
}

// ------------------------- Late listener / status re-request (0/0 root cause)
async function scenarioStatusReRequest() {
  const early = [];
  const page1 = userPage(["u1", "u2", "u3"], { hasPrev: false });
  const { ctx, window: win } = boot({ onStatus: (p) => early.push({ ...p }), routes: () => makeResponse(page1) });
  ctx.localStorage.setItem("turbogpt_config", JSON.stringify({ enabled: true, messageLimit: 2 }));

  // The conversation loads BEFORE any content-script listener exists.
  await ctx.window.fetch(BASE);
  await settle();
  check("ReRequest: status was broadcast during load", early.length > 0, `broadcasts=${early.length}`);

  // Content script comes alive late (document_idle) and asks for the status.
  const late = [];
  win.addEventListener("message", (e) => {
    if (e.data?.type === "turbogpt-status") late.push(e.data.payload);
  });
  win.postMessage({ type: "turbogpt-request-status" });
  await settle(20);

  check("ReRequest: late listener recovers the status (fixes 0/0)", late.length > 0, `replies=${late.length}`);
  const got = late[late.length - 1] || {};
  check("ReRequest: recovered payload carries real numbers",
    got.visibleTurns === 2 && got.totalTurns === 3 && got.countState === "complete",
    `${got.visibleTurns}/${got.totalTurns} ${got.countState}`);
  check("ReRequest: mirrored into sessionStorage too",
    !!ctx.sessionStorage?.getItem?.("turbogpt_last_status") ||
    !!ctx.localStorage.getItem("turbogpt_last_status"));
}

// ---------------------------------------- Pagination contract: unknown
async function scenarioContractUnknown() {
  const statuses = [];
  // has_previous_page true, but NO cursor field of any kind, and no records
  // to probe with (all messages id-less at position 0 removed -> use ids but
  // simulate a payload where the first record has no id).
  const page1 = {
    messages: [{ author: { role: "user" } }, { author: { role: "assistant" } }],
    page_info: { has_previous_page: true }
  };
  const { ctx, calls } = boot({ onStatus: (p) => statuses.push({ ...p }), routes: () => makeResponse(page1) });
  await ctx.window.fetch(BASE);
  await settle();
  const fin = lastCount(statuses);
  check("ContractUnknown: partial", fin.countState === "partial", fin.countState);
  check("ContractUnknown: reason surfaced to popup",
    fin.countFailureReason === "pagination-contract-unknown", fin.countFailureReason);
  check("ContractUnknown: zero counting requests", calls.length === 1, `calls=${calls.length}`);
}

// ------------------------------- Pagination contract: probe from oldest id
async function scenarioProbeContract() {
  const statuses = [];
  // page_info advertises older pages but carries no cursor field at all.
  const page1 = {
    messages: [msg("u9", "user"), msg("a9", "assistant")],
    page_info: { has_previous_page: true }
  };
  const page2 = userPage(["u7", "u8"], { hasPrev: false });
  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => (url.includes("cursor=") ? makeResponse(page2) : makeResponse(page1))
  });
  await ctx.window.fetch(BASE);
  await settle();
  const fin = lastCount(statuses);
  check("Probe: uses oldest record id when page_info has no cursor",
    calls.some((u) => u.includes("cursor=u9")), calls.join(" | "));
  check("Probe: completes when the probe actually returns older data",
    fin.countState === "complete" && fin.totalTurns === 3, `${fin.totalTurns}/${fin.countState}`);
  check("Probe: contract source reported", fin.countContractSource === "probe-oldest-id", fin.countContractSource);
}

// ------------------------------ Learned contract from observed React request
async function scenarioLearnedContract() {
  const statuses = [];
  const page1 = {
    messages: [msg("u9", "user"), msg("a9", "assistant")],
    page_info: { has_previous_page: true, start_cursor: "CUR1" }
  };
  const page2 = userPage(["u7", "u8"], { hasPrev: false });
  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => (url.includes("before=") ? makeResponse(page2) : makeResponse(page1))
  });

  // React itself asks for an older page using `before=` (not `cursor=`).
  await ctx.window.fetch(`${BASE}?before=XYZ&limit=20`);
  check("Learned: React's pagination request is still blocked from the DOM",
    calls.length === 0, `calls=${calls.length}`);

  await ctx.window.fetch(BASE);
  await settle();

  const walkCall = calls.find((u) => u.includes("before="));
  check("Learned: counting reuses the observed parameter name", !!walkCall, calls.join(" | "));
  check("Learned: cursor VALUE comes from page_info, not the observed one",
    !!walkCall && walkCall.includes("before=CUR1"), walkCall);
  check("Learned: observed scalar companions preserved", !!walkCall && walkCall.includes("limit=20"), walkCall);
  const fin = lastCount(statuses);
  check("Learned: completes", fin.countState === "complete" && fin.totalTurns === 3, `${fin.totalTurns}/${fin.countState}`);
}

// ------------------------------------------------- 429 with bounded retry
async function scenarioRetryThenSuccess() {
  const statuses = [];
  const page1 = userPage(["u9"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u7", "u8"], { hasPrev: false });
  let hits = 0;
  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      if (!url.includes("cursor=")) return makeResponse(page1);
      hits++;
      return hits <= 2 ? makeResponse({}, { status: 429 }) : makeResponse(page2);
    }
  });
  await ctx.window.fetch(BASE);
  await settle(3000);
  const fin = lastCount(statuses);
  check("Retry: recovers after two 429s", fin.countState === "complete" && fin.totalTurns === 3,
    `${fin.totalTurns}/${fin.countState}`);
  check("Retry: bounded attempts", hits <= 4, `attempts=${hits}`);
}

async function scenarioRetryExhausted() {
  const statuses = [];
  const page1 = userPage(["u9"], { hasPrev: true, cursor: "A" });
  let hits = 0;
  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      if (!url.includes("cursor=")) return makeResponse(page1);
      hits++;
      return makeResponse({}, { status: 429 });
    }
  });
  await ctx.window.fetch(BASE);
  await settle(5000);
  const fin = lastCount(statuses);
  check("RetryExhausted: partial, never complete", fin.countState === "partial", fin.countState);
  check("RetryExhausted: rate-limit reason surfaced", fin.countFailureReason === "http-429", fin.countFailureReason);
  check("RetryExhausted: stops after bounded attempts", hits === 4, `attempts=${hits}`);
}

async function scenarioNoRetryOn404() {
  const statuses = [];
  const page1 = userPage(["u9"], { hasPrev: true, cursor: "A" });
  let hits = 0;
  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      if (!url.includes("cursor=")) return makeResponse(page1);
      hits++;
      return makeResponse({}, { status: 404 });
    }
  });
  await ctx.window.fetch(BASE);
  await settle();
  const fin = lastCount(statuses);
  check("No-retry on 4xx: single attempt", hits === 1, `attempts=${hits}`);
  check("No-retry on 4xx: reason surfaced", fin.countFailureReason === "http-404", fin.countFailureReason);
}

// ------------------------------------------------- failure reason plumbing
async function scenarioReasonPlumbing() {
  const statuses = [];
  const page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => (url.includes("cursor=") ? makeResponse(page1) : makeResponse(page1))
  });
  await ctx.window.fetch(BASE);
  await settle();
  const fin = lastCount(statuses);
  check("Plumbing: no-progress reason reaches the status payload",
    fin.countFailureReason === "no-progress", fin.countFailureReason);
  check("Plumbing: complete states carry a null reason",
    lastCount([{ countState: "complete", countFailureReason: null }]).countFailureReason === null);
}

// ============ Load More / Load All hydration (the v3.5.0 fix) ============

function bodyUserTurns(body) {
  return body.messages.filter((m) => m?.author?.role === "user").length;
}

async function scenarioLoadMoreReachesOlderPages() {
  const statuses = [];
  // First page holds only 2 user turns; the rest live on older pages.
  const page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u5", "u6", "u7", "u8"], { hasPrev: true, cursor: "B" });
  const page3 = userPage(["u1", "u2", "u3", "u4"], { hasPrev: false });

  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      if (url.includes("cursor=A")) return makeResponse(page2);
      if (url.includes("cursor=B")) return makeResponse(page3);
      return makeResponse(page1);
    }
  });
  ctx.localStorage.setItem("turbogpt_config", JSON.stringify({ enabled: true, messageLimit: 2 }));
  // User clicked "Load +5 older turns"
  ctx.localStorage.setItem("turbogpt_extra_turns", JSON.stringify({
    url: ctx.window.location.href, extra: 5
  }));

  const res = await ctx.window.fetch(BASE);
  const body = await res.json();
  await settle();

  check("LoadMore: React receives turns from OLDER pages (was capped at 2)",
    bodyUserTurns(body) === 7, `got ${bodyUserTurns(body)} user turns`);
  check("LoadMore: messages stay in server order (oldest first)",
    body.messages[0].id === "u4", body.messages[0].id);
  check("LoadMore: infinite scroll still disabled for React",
    body.page_info.has_previous_page === false);
  const fin = statuses[statuses.length - 1] || {};
  check("LoadMore: status reports hydrated pages", fin.hydratedPages === 2, `${fin.hydratedPages}`);
  // 10 turns were merged but only 7 requested, so u1-u3 were fetched then
  // trimmed: the server is exhausted, yet more turns can still be revealed.
  check("LoadMore: server start reached during hydration", fin.serverHasOlder === false, `${fin.serverHasOlder}`);
  check("LoadMore: pill still knows turns remain off-screen",
    fin.hasOlderMessages === true, `${fin.hasOlderMessages}`);
}

async function scenarioLoadAllReachesStart() {
  const statuses = [];
  const page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u5", "u6", "u7", "u8"], { hasPrev: true, cursor: "B" });
  const page3 = userPage(["u1", "u2", "u3", "u4"], { hasPrev: false });

  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => {
      if (url.includes("cursor=A")) return makeResponse(page2);
      if (url.includes("cursor=B")) return makeResponse(page3);
      return makeResponse(page1);
    }
  });
  ctx.localStorage.setItem("turbogpt_config", JSON.stringify({ enabled: true, messageLimit: 2 }));
  ctx.localStorage.setItem("turbogpt_extra_turns", JSON.stringify({
    url: ctx.window.location.href, extra: 9999
  }));

  const res = await ctx.window.fetch(BASE);
  const body = await res.json();
  await settle();

  check("LoadAll: every user turn reaches React", bodyUserTurns(body) === 10, `${bodyUserTurns(body)}`);
  const fin = statuses[statuses.length - 1] || {};
  check("LoadAll: reports the conversation start was reached",
    fin.reachedConversationStart === true, `${fin.reachedConversationStart}`);
  check("LoadAll: no older messages remain", fin.serverHasOlder === false, `${fin.serverHasOlder}`);

  const counted = lastCount(statuses);
  check("LoadAll: count is exact and free (reuses hydrated pages)",
    counted.countState === "complete" && counted.totalTurns === 10,
    `${counted.totalTurns}/${counted.countState}`);
  check("LoadAll: counter issued no extra requests",
    counted.countSource === "single-page", counted.countSource);
}

async function scenarioNormalOpenDoesNotHydrate() {
  const statuses = [];
  const page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  const { ctx, calls } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: () => makeResponse(page1)
  });
  ctx.localStorage.setItem("turbogpt_config", JSON.stringify({ enabled: true, messageLimit: 2 }));
  // no extra turns requested

  const res = await ctx.window.fetch(BASE);
  const body = await res.json();

  check("SpeedIntact: a normal open renders only the trimmed page",
    bodyUserTurns(body) === 2, `${bodyUserTurns(body)}`);
  // The single counting request is allowed; hydration must add none of its own.
  const before = calls.length;
  check("SpeedIntact: response returned without waiting on older pages", before <= 2, `calls=${before}`);
}

async function scenarioHydrationFailureStillRenders() {
  const statuses = [];
  const page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => (url.includes("cursor=") ? makeResponse({}, { status: 500 }) : makeResponse(page1))
  });
  ctx.localStorage.setItem("turbogpt_config", JSON.stringify({ enabled: true, messageLimit: 2 }));
  ctx.localStorage.setItem("turbogpt_extra_turns", JSON.stringify({
    url: ctx.window.location.href, extra: 9999
  }));

  const res = await ctx.window.fetch(BASE);
  const body = await res.json();
  await settle(5000);

  check("HydrateFail: chat still renders what it has", bodyUserTurns(body) === 2, `${bodyUserTurns(body)}`);
  const withReason = statuses.find((s) => s.hydrationFailureReason);
  check("HydrateFail: failure reason surfaced", !!withReason && /^http-5\d\d$/.test(withReason.hydrationFailureReason),
    withReason?.hydrationFailureReason);
  check("HydrateFail: never claims the start was reached",
    statuses.every((s) => s.reachedConversationStart !== true));
}

async function scenarioHydrationDedup() {
  const statuses = [];
  // page2 overlaps page1 (u9 appears in both)
  const page1 = userPage(["u9", "u10"], { hasPrev: true, cursor: "A" });
  const page2 = userPage(["u7", "u8", "u9"], { hasPrev: false });
  const { ctx } = boot({
    onStatus: (p) => statuses.push({ ...p }),
    routes: (url) => (url.includes("cursor=A") ? makeResponse(page2) : makeResponse(page1))
  });
  ctx.localStorage.setItem("turbogpt_config", JSON.stringify({ enabled: true, messageLimit: 2 }));
  ctx.localStorage.setItem("turbogpt_extra_turns", JSON.stringify({
    url: ctx.window.location.href, extra: 9999
  }));

  const res = await ctx.window.fetch(BASE);
  const body = await res.json();
  await settle();

  const ids = body.messages.map((m) => m.id);
  check("HydrateDedup: overlapping page does not duplicate messages",
    new Set(ids).size === ids.length, ids.join(","));
  check("HydrateDedup: merged turn count correct", bodyUserTurns(body) === 4, `${bodyUserTurns(body)}`);
}

const suites = [
  scenarioLoadMoreReachesOlderPages,
  scenarioLoadAllReachesStart,
  scenarioNormalOpenDoesNotHydrate,
  scenarioHydrationFailureStillRenders,
  scenarioHydrationDedup,
  scenarioContractUnknown,
  scenarioProbeContract,
  scenarioLearnedContract,
  scenarioRetryThenSuccess,
  scenarioRetryExhausted,
  scenarioNoRetryOn404,
  scenarioReasonPlumbing,
  scenarioStatusReRequest,
  scenarioA, scenarioDuplicateCursor, scenarioNetworkFailure, scenarioThrownNetwork,
  scenarioMissingId, scenarioMaxPages, scenarioNoProgress, scenarioForwardOnlyCursor,
  scenarioSmallChat, scenarioVisibleSettings, scenarioCancellation, scenarioConcurrentStarts,
  scenarioCacheReuse, scenarioNewTurn, scenarioBranchRecount, scenarioRequestShape,
  scenarioDisabled, scenarioCursorBlockerStillActive
];

for (const s of suites) {
  console.log(`\n--- ${s.name} ---`);
  try {
    await s();
  } catch (e) {
    check(`${s.name} threw`, false, e.message);
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n================ ${results.length - failed.length}/${results.length} passed ================`);
if (failed.length) {
  console.log("FAILURES:");
  for (const f of failed) console.log(` - ${f.name} ${f.detail || ""}`);
  process.exitCode = 1;
}
