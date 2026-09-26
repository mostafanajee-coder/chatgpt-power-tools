/**
 * TurboGPT - Main World Fetch Interceptor
 * 100% Original, Clean Architecture for Modern ChatGPT
 */

(() => {
  if (window.__TURBOGPT_PROXY_INSTALLED__) return;

  const STORAGE_CONFIG_KEY = "turbogpt_config";
  const STORAGE_EXTRA_KEY = "turbogpt_extra_turns";
  const STORAGE_COUNT_CACHE_KEY = "turbogpt_turn_count_cache";
  const STORAGE_DIAG_MAX_KEY = "turbogpt_diag_max_total_turns";
  const STORAGE_PAGINATION_KEY = "turbogpt_pagination_contract";

  const DEFAULT_CONFIG = {
    enabled: true,
    messageLimit: 15,
    enableAutoScrollLoad: false,
    liveAutoTrim: false
  };

  // Circuit breaker only - NOT a claim about any real ChatGPT conversation limit.
  const COUNT_MAX_PAGES = 500;
  const COUNT_REQUEST_DELAY_MS = 150;
  const COUNT_CACHE_MAX_CONVERSATIONS = 200;

  // Set to true only for local debugging. Never ships enabled.
  // Logs ids/counts/cursor FIELD NAMES only - never headers, tokens, cookies,
  // cursor values or message content.
  const DEBUG_COUNT = false;

  function logCount(stage, info) {
    if (!DEBUG_COUNT) return;
    try { console.debug("[TurboGPT Count]", stage, info); } catch {}
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // window.fetch is wrapped below, and ChatGPT calls fetch constantly
  // (telemetry, presence, typing state...). Re-reading and re-parsing the
  // config from localStorage on each of those calls was pointless work on
  // the main thread, so the parsed config is reused for a short window.
  const CONFIG_CACHE_TTL_MS = 1000;
  let cachedConfig = null;
  let cachedConfigAt = 0;

  function getActiveConfig() {
    const now = Date.now();
    if (cachedConfig && now - cachedConfigAt < CONFIG_CACHE_TTL_MS) return cachedConfig;
    let config = DEFAULT_CONFIG;
    try {
      const raw = localStorage.getItem(STORAGE_CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        config = {
          enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
          messageLimit: Math.max(1, parsed.messageLimit ?? DEFAULT_CONFIG.messageLimit),
          enableAutoScrollLoad: parsed.enableAutoScrollLoad === true,
          liveAutoTrim: parsed.liveAutoTrim === true
        };
      }
    } catch {}
    cachedConfig = config;
    cachedConfigAt = now;
    return config;
  }

  function getExtraTurns() {
    try {
      const raw = localStorage.getItem(STORAGE_EXTRA_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.url === window.location.href) {
          try { localStorage.removeItem(STORAGE_EXTRA_KEY); } catch {}
          return parsed.extra || 0;
        }
      }
    } catch {}
    return 0;
  }

  // ---------- Status broadcast ----------

  // Debug only. Logs ids/counts/state names - never message content,
  // headers, cookies, tokens or cursor values.
  const DEBUG_STATS = false;

  let currentStatus = {};

  function broadcastStatus(partial) {
    currentStatus = { ...currentStatus, ...partial };
    if (DEBUG_STATS) {
      try {
        console.debug("[TurboGPT Stats Debug] mainWorld", {
          conversationId: currentStatus.conversationId,
          visibleTurns: currentStatus.visibleTurns,
          totalTurns: currentStatus.totalTurns,
          countState: currentStatus.countState
        });
      } catch {}
    }
    window.postMessage({ type: "turbogpt-status", payload: currentStatus }, "*");
    try {
      sessionStorage.setItem("turbogpt_last_status", JSON.stringify({ ...currentStatus, url: window.location.href }));
    } catch {}
  }

  // The content script runs at document_idle, this script at document_start:
  // a status broadcast during page load happens before anyone is listening.
  // The content script asks for the current status once it is alive.
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== "turbogpt-request-status") return;
    if (!currentStatus || Object.keys(currentStatus).length === 0) return;
    window.postMessage({ type: "turbogpt-status", payload: currentStatus }, "*");
  });

  // ---------- Conversation identity ----------

  function extractConversationId(url) {
    if (!url) return null;
    const m = /\/backend-api\/conversations?\/([a-f0-9-]+)/i.exec(url);
    return m ? m[1] : null;
  }

  let activeConversationId = null;
  let countGeneration = 0;
  // Exactly one in-flight walk per conversation - prevents a request storm when
  // ChatGPT issues several GETs for the same conversation (remount, refocus...).
  let walkInFlightFor = null;

  function isGenerationActive(conversationId, generation) {
    return conversationId === activeConversationId && generation === countGeneration;
  }

  // ---------- Turn-count cache (localStorage, MAIN world only) ----------

  function getAllCountCache() {
    try {
      const raw = localStorage.getItem(STORAGE_COUNT_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function getCountCache(conversationId) {
    if (!conversationId) return null;
    const all = getAllCountCache();
    return all[conversationId] || null;
  }

  function saveCountCache(conversationId, record) {
    if (!conversationId) return;
    try {
      const all = getAllCountCache();
      all[conversationId] = record;
      const keys = Object.keys(all);
      if (keys.length > COUNT_CACHE_MAX_CONVERSATIONS) {
        keys.sort((a, b) => (all[a].countedAt || 0) - (all[b].countedAt || 0));
        delete all[keys[0]];
      }
      localStorage.setItem(STORAGE_COUNT_CACHE_KEY, JSON.stringify(all));
    } catch {}
  }

  function updateDiagnosticMax(total) {
    try {
      const prev = parseInt(localStorage.getItem(STORAGE_DIAG_MAX_KEY) || "0", 10) || 0;
      if (total > prev) localStorage.setItem(STORAGE_DIAG_MAX_KEY, String(total));
    } catch {}
  }

  // ---------- Helpers over message arrays ----------

  function getUserIdsInOrder(messages) {
    const ids = [];
    if (!Array.isArray(messages)) return ids;
    for (const msg of messages) {
      if (msg?.author?.role === "user") {
        ids.push(msg.id != null ? String(msg.id) : null);
      }
    }
    return ids;
  }

  function getRecordIds(messages) {
    const ids = [];
    if (!Array.isArray(messages)) return ids;
    for (const msg of messages) {
      if (msg?.id != null) ids.push(String(msg.id));
    }
    return ids;
  }

  function countMissing(ids) {
    let n = 0;
    for (const id of ids) if (!id) n++;
    return n;
  }

  function lastNonNull(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]) return arr[i];
    }
    return null;
  }

  // ---------- Pagination contract ----------
  //
  // Direction matters: we walk OLDER (backwards). ChatGPT's own payload pairs
  // `has_previous_page` with `start_cursor` (Relay-style backwards pagination:
  // startCursor/hasPreviousPage = backwards, endCursor/hasNextPage = forwards),
  // and this project's pre-existing display code rewrites `start_cursor`
  // together with `has_previous_page = false` in the very block whose purpose
  // is to stop older-message loading. That is our evidence for the field name.
  //
  // We deliberately do NOT fall back to `end_cursor` / `next_cursor` / `cursor`:
  // those either mean the OPPOSITE direction or are unproven names, and walking
  // the wrong direction would silently produce a wrong total. If no
  // backwards-directional cursor is present, the walk stops as "partial"
  // instead of guessing.
  //
  // NOT LIVE-VERIFIED against a real ChatGPT response. Runtime progress
  // verification below is what actually protects the number.
  const BACKWARD_CURSOR_FIELDS = ["start_cursor", "prev_cursor", "previous_cursor"];

  // Query parameters ChatGPT could plausibly use to page backwards. Used ONLY
  // to recognise a pagination request that ChatGPT itself made, so we can learn
  // its real contract instead of inventing one.
  const PAGINATION_PARAM_CANDIDATES = [
    "cursor", "before", "after", "starting_after", "ending_before", "offset", "page"
  ];

  function pickBackwardCursor(pageInfo) {
    if (!pageInfo) return null;
    for (const field of BACKWARD_CURSOR_FIELDS) {
      const v = pageInfo[field];
      if (v !== undefined && v !== null && v !== "") {
        return { value: String(v), fieldName: field };
      }
    }
    return null;
  }

  // ---------- Learned pagination contract ----------
  //
  // ChatGPT's own "load older messages" request is the single authoritative
  // description of how this API paginates. We already intercept (and block)
  // it for speed; before blocking we read its SHAPE - parameter names, and
  // plain numeric/boolean companions such as limit. Cursor values are kept in
  // memory for the session only and never persisted; nothing else about the
  // request (headers, auth, cookies, bodies) is read or stored.
  let observedPagination = null;

  function loadObservedPagination() {
    if (observedPagination) return observedPagination;
    try {
      const raw = localStorage.getItem(STORAGE_PAGINATION_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && parsed.parameterName) observedPagination = parsed;
    } catch {}
    return observedPagination;
  }

  function findPaginationParams(url) {
    try {
      const u = new URL(url, window.location.origin);
      const found = [];
      for (const name of PAGINATION_PARAM_CANDIDATES) {
        const v = u.searchParams.get(name);
        if (v !== null && v !== "") found.push({ name, value: v });
      }
      return found;
    } catch {
      return [];
    }
  }

  function isPaginationRequest(url) {
    return findPaginationParams(url).length > 0;
  }

  function observePaginationRequest(url) {
    const found = findPaginationParams(url);
    if (found.length === 0) return;
    const primary = found[0];
    // Plain scalar companions (limit=20 etc.) are safe to keep and may be
    // required for the request to be accepted.
    const extraParams = {};
    try {
      const u = new URL(url, window.location.origin);
      u.searchParams.forEach((value, name) => {
        if (name === primary.name) return;
        if (/^(?:\d+|true|false)$/i.test(value)) extraParams[name] = value;
      });
    } catch {}
    const record = {
      parameterName: primary.name,
      extraParams,
      learnedAt: Date.now()
    };
    observedPagination = { ...record, lastCursorValue: primary.value };
    try {
      // Persist the CONTRACT only - never the cursor value.
      localStorage.setItem(STORAGE_PAGINATION_KEY, JSON.stringify(record));
    } catch {}
    logCount("contract-observed", { parameterName: primary.name, extraParamNames: Object.keys(extraParams) });
  }

  /**
   * Decide how (and whether) to request the page older than the current one.
   * Never guesses a direction: the cursor VALUE always comes from the server
   * (page_info) or from a real ChatGPT request. Only the parameter NAME can
   * fall back to a default, and a wrong name fails loudly as an HTTP error
   * rather than silently miscounting.
   */
  // ---------- Current ChatGPT history endpoint (verified live 2026-09-25) ----------
  //
  // The web client opens a chat with
  //   GET /backend-api/conversations/<id>?include_has_versions=true&num_turns=10
  // and pages older history from a SEPARATE path:
  //   GET /backend-api/conversations/<id>/messages?before=<start_cursor>&include_has_versions=true&num_turns=10
  // where `before` is the previous page's page_info.start_cursor (the id of
  // its first message). Every earlier guess put the cursor on the opening
  // URL instead, which the server ignores - that is why server-side walks
  // stopped after one page ("no-progress") and full exports came out short.
  // The opening request carrying `num_turns` is the signal for this client.
  function messagesEndpointFor(requestUrl) {
    try {
      const u = new URL(requestUrl, window.location.origin);
      const m = /^\/backend-api\/conversations\/([0-9a-f-]+)\/?$/i.exec(u.pathname);
      if (!m || !u.searchParams.has("num_turns")) return null;
      return {
        conversationId: m[1],
        numTurns: u.searchParams.get("num_turns") || "10",
        includeHasVersions: u.searchParams.get("include_has_versions")
      };
    } catch {
      return null;
    }
  }

  function buildOlderMessagesUrl(ep, cursor) {
    const u = new URL(`/backend-api/conversations/${ep.conversationId}/messages`, window.location.origin);
    u.searchParams.set("before", cursor);
    if (ep.includeHasVersions != null) u.searchParams.set("include_has_versions", ep.includeHasVersions);
    u.searchParams.set("num_turns", ep.numTurns);
    return u.toString();
  }

  function isOlderMessagesUrl(url, method) {
    return method === "GET" && /\/backend-api\/conversations\/[0-9a-f-]+\/messages(?:\?|$)/i.test(url);
  }

  function resolveBackwardPagination({ requestUrl, pageInfo, oldestRecordId, allowProbe }) {
    const ep = messagesEndpointFor(requestUrl);
    if (ep) {
      const fromPageInfo = pickBackwardCursor(pageInfo);
      const cursorValue = fromPageInfo?.value || (allowProbe ? oldestRecordId : null);
      if (!cursorValue) return { supported: false, reason: "pagination-contract-unknown" };
      return {
        supported: true,
        nextUrl: buildOlderMessagesUrl(ep, cursorValue),
        cursorValue,
        parameterName: "before",
        source: "messages-endpoint"
      };
    }
    const observed = loadObservedPagination();
    const parameterName = observed?.parameterName || "cursor";

    let cursorValue = null;
    let source = null;

    const fromPageInfo = pickBackwardCursor(pageInfo);
    if (fromPageInfo) {
      cursorValue = fromPageInfo.value;
      source = observed ? "observed-chatgpt-request" : "page-info";
    } else if (observed?.lastCursorValue) {
      cursorValue = observed.lastCursorValue;
      source = "observed-chatgpt-request";
    } else if (allowProbe && oldestRecordId) {
      // page_info says older messages exist but carries no cursor field.
      // This project's own display code rewrites start_cursor with the first
      // message id of the page, i.e. the cursor IS a message id here. Probing
      // with the oldest known id is therefore a contract-consistent attempt,
      // and it is still policed by the progress check below: a page that
      // returns nothing new stops the walk as partial.
      cursorValue = oldestRecordId;
      source = "probe-oldest-id";
    }

    if (!cursorValue) {
      return { supported: false, reason: "pagination-contract-unknown" };
    }

    let nextUrl = null;
    try {
      const u = new URL(requestUrl, window.location.origin);
      // set() replaces (never appends) and percent-encodes the value.
      // Every other original query parameter and the path are preserved.
      u.searchParams.set(parameterName, cursorValue);
      if (observed?.extraParams) {
        for (const [k, v] of Object.entries(observed.extraParams)) {
          if (!u.searchParams.has(k)) u.searchParams.set(k, v);
        }
      }
      nextUrl = u.toString();
    } catch {
      return { supported: false, reason: "bad-url" };
    }

    return { supported: true, nextUrl, cursorValue, parameterName, source };
  }

  function buildBaseRequestInit(resource, fetchConfig) {
    // GET only, never a body. Headers/credentials are copied from whatever
    // ChatGPT itself used so an Authorization header (if any) is preserved.
    const init = { method: "GET" };
    const applyFrom = (src, isRequest) => {
      if (!src) return;
      try {
        if (src.headers) init.headers = new Headers(src.headers);
      } catch {}
      if (src.credentials) init.credentials = src.credentials;
      if (src.mode && src.mode !== "navigate") init.mode = src.mode;
      if (src.cache) init.cache = src.cache;
      if (src.referrer && src.referrer !== "about:client") init.referrer = src.referrer;
      if (src.referrerPolicy) init.referrerPolicy = src.referrerPolicy;
      if (isRequest && !init.credentials) init.credentials = "same-origin";
    };
    if (resource instanceof Request) applyFrom(resource, true);
    // An explicit init object wins over the Request it was passed alongside.
    applyFrom(fetchConfig, false);
    // Deliberately no `signal`: the counting walk must outlive the original
    // request's own AbortController (React aborts these on unmount).
    return init;
  }

  // ---------- Counting path (never touches DOM / React) ----------

  // Small bounded backoff for 429/5xx only. Never an infinite retry loop.
  const COUNT_RETRY_DELAYS = [500, 1000, 2000];

  async function fetchPageWithRetry(url, requestInit, isActive) {
    let lastStatus = null;
    for (let attempt = 0; attempt <= COUNT_RETRY_DELAYS.length; attempt++) {
      if (attempt > 0) {
        await sleep(COUNT_RETRY_DELAYS[attempt - 1]);
        if (!isActive()) return { error: "cancelled" };
      }
      let res;
      try {
        // originalFetch, bound to window: never re-enters our own interceptor
        // (so our pagination blocker can never swallow our own request).
        res = await originalFetch.call(window, url, requestInit);
      } catch {
        return { error: "network" };
      }
      if (!res) return { error: "http-none" };
      if (res.ok) return { res };
      lastStatus = res.status;
      // Only rate limiting / transient server errors are worth retrying.
      if (res.status !== 429 && res.status < 500) return { error: `http-${res.status}` };
    }
    return { error: `http-${lastStatus}` };
  }

  async function walkAndCount({
    conversationId, baseUrl, requestInit, initialPageInfo,
    initialUserIds, initialRecordIds, generation
  }) {
    const seenCursors = new Set();
    const seenMessageIds = new Set(initialUserIds.filter(Boolean)); // user turns -> the count
    const seenRecordIds = new Set(initialRecordIds);                // all records -> progress proof
    let idlessUserRecords = countMissing(initialUserIds);
    let dedupeReliable = idlessUserRecords === 0;

    let oldestId = initialUserIds.filter(Boolean)[0] || null;
    let oldestRecordId = initialRecordIds[0] || null;
    let pageInfo = initialPageInfo;
    let pagesWalked = 0;
    let reachedEnd = false;
    let failureReason = null;
    let contractSource = null;
    const isActive = () => isGenerationActive(conversationId, generation);

    try {
      while (true) {
        if (!isActive()) { failureReason = "cancelled"; break; }
        if (!pageInfo) { failureReason = "missing-page-info"; break; }
        if (pageInfo.has_previous_page !== true) { reachedEnd = true; break; }
        if (pagesWalked >= COUNT_MAX_PAGES) { failureReason = "max-pages"; break; }

        const plan = resolveBackwardPagination({
          requestUrl: baseUrl,
          pageInfo,
          oldestRecordId,
          // Probe only for the first hop; afterwards the server's own
          // page_info must carry us, or we stop.
          allowProbe: pagesWalked === 0
        });
        if (!plan.supported) { failureReason = plan.reason || "pagination-contract-unknown"; break; }
        if (seenCursors.has(plan.cursorValue)) { failureReason = "duplicate-cursor"; break; }
        seenCursors.add(plan.cursorValue);
        contractSource = plan.source;

        logCount("request", {
          conversationId,
          pageIndex: pagesWalked + 1,
          parameterName: plan.parameterName,
          source: plan.source
        });

        const attempt = await fetchPageWithRetry(plan.nextUrl, requestInit, isActive);
        if (attempt.error) { failureReason = attempt.error; break; }
        const res = attempt.res;
        if (!isActive()) { failureReason = "cancelled"; break; }

        let pageData;
        try {
          let text = await res.text();
          if (text.charCodeAt(0) === 65279) text = text.slice(1);
          pageData = JSON.parse(text);
        } catch {
          failureReason = "parse"; break;
        }
        if (!isGenerationActive(conversationId, generation)) { failureReason = "cancelled"; break; }
        if (!pageData || !Array.isArray(pageData.messages)) { failureReason = "schema"; break; }
        if (pageData.messages.length === 0) {
          if (!pageData.page_info || pageData.page_info.has_previous_page !== true) {
            reachedEnd = true;
            break;
          }
          failureReason = "empty-page";
          break;
        }

        // Progress proof over ALL records: a page that adds no record we have
        // not already seen means the cursor went the wrong way (newer), or
        // repeated itself. Never keep walking on an unproven direction.
        postArchiveSnapshot(conversationId, null, pageData.messages, false, pageData.page_info);

        const pageRecordIds = getRecordIds(pageData.messages);
        let newRecords = 0;
        for (const rid of pageRecordIds) {
          if (!seenRecordIds.has(rid)) { seenRecordIds.add(rid); newRecords++; }
        }
        if (newRecords === 0) {
          if (!pageData.page_info || pageData.page_info.has_previous_page !== true) {
            reachedEnd = true;
            break;
          }
          failureReason = "no-progress";
          break;
        }

        const pageUserIds = getUserIdsInOrder(pageData.messages);
        const pageMissing = countMissing(pageUserIds);
        if (pageMissing > 0) {
          // A user record with no id cannot be deduped across overlapping
          // pages. Count it so the number is not understated, but the result
          // can never be reported as an exact/complete total.
          idlessUserRecords += pageMissing;
          dedupeReliable = false;
        }
        let pageNewUserTurns = 0;
        for (const id of pageUserIds) {
          if (id && !seenMessageIds.has(id)) { seenMessageIds.add(id); pageNewUserTurns++; }
        }

        const firstPageUserId = pageUserIds.filter(Boolean)[0];
        if (firstPageUserId) oldestId = firstPageUserId;
        if (pageRecordIds[0]) oldestRecordId = pageRecordIds[0];

        pagesWalked++;
        pageInfo = pageData.page_info;

        logCount("page-result", {
          conversationId,
          pageIndex: pagesWalked,
          pageUserTurns: pageNewUserTurns,
          uniqueTotalTurns: seenMessageIds.size,
          newRecordsOnPage: newRecords,
          hasPreviousPage: !!(pageInfo && pageInfo.has_previous_page),
          nextCursorPresent: !!pickBackwardCursor(pageInfo)
        });

        if (!pageInfo || pageInfo.has_previous_page !== true) { reachedEnd = true; break; }

        await sleep(COUNT_REQUEST_DELAY_MS);
      }
    } catch {
      failureReason = failureReason || "unexpected";
    }

    // A cancelled walk writes nothing and broadcasts nothing: its numbers
    // belong to a conversation the user has already left.
    if (failureReason === "cancelled" || !isGenerationActive(conversationId, generation)) return;

    // COMPLETE INVARIANT: every one of these must hold.
    const complete = reachedEnd && dedupeReliable && !failureReason;
    const totalTurns = seenMessageIds.size + idlessUserRecords;

    const record = {
      conversationId,
      totalTurns,
      complete,
      countedAt: Date.now(),
      pagesWalked,
      failureReason: failureReason || null,
      dedupeReliable,
      newestKnownUserMessageId: lastNonNull(initialUserIds),
      oldestKnownUserMessageId: oldestId
    };
    saveCountCache(conversationId, record);
    if (complete) updateDiagnosticMax(totalTurns);

    logCount("walk-end", {
      conversationId, pagesWalked, totalTurns, complete,
      failureReason: failureReason || null, contractSource
    });

    broadcastStatus({
      totalTurns,
      countState: complete ? "complete" : "partial",
      countComplete: complete,
      countSource: "walk",
      countFailureReason: complete ? null : (failureReason || (dedupeReliable ? "unknown" : "idless-user-record")),
      countContractSource: contractSource
    });
  }

  function decideCountingPlan(conversationId, pageUserIds) {
    const cleanIds = pageUserIds.filter(Boolean);
    const cache = getCountCache(conversationId);
    const newestPageId = lastNonNull(pageUserIds);

    // Only a cache written by a fully-verified walk may ever be reused.
    if (!cache || cache.complete !== true) return { mode: "full", cache };

    // Verified against THIS fresh server response, not against wall-clock age:
    // same newest user turn -> the count still describes the active path.
    if (cache.newestKnownUserMessageId && cache.newestKnownUserMessageId === newestPageId) {
      return { mode: "reuse", cache };
    }

    if (cache.newestKnownUserMessageId) {
      const idx = cleanIds.indexOf(cache.newestKnownUserMessageId);
      if (idx !== -1 && idx < cleanIds.length - 1) {
        return { mode: "increment", cache, newIds: cleanIds.slice(idx + 1) };
      }
    }

    // Boundary id not visible in the current page (edit / branch / fork /
    // large gap) -> never guess a delta, recount for real.
    return { mode: "full", cache };
  }

  function startCountingPath(conversationId, requestUrl, requestInit, originalPageInfo, pageUserIdsOrdered, pageRecordIds, generation) {
    const pageHasIdlessUser = countMissing(pageUserIdsOrdered) > 0;
    const plan = decideCountingPlan(conversationId, pageUserIdsOrdered);

    if (plan.mode === "reuse") {
      // Clear any provisional stale marker: the server just confirmed the tail.
      if (plan.cache.staleSince) {
        saveCountCache(conversationId, { ...plan.cache, staleSince: null });
      }
      broadcastStatus({
        totalTurns: plan.cache.totalTurns,
        countState: "complete",
        countComplete: true,
        countSource: "cache",
        countFailureReason: null
      });
      return;
    }

    if (plan.mode === "increment") {
      const newTotal = plan.cache.totalTurns + new Set(plan.newIds).size;
      const complete = !pageHasIdlessUser;
      saveCountCache(conversationId, {
        ...plan.cache,
        totalTurns: newTotal,
        complete,
        dedupeReliable: complete,
        staleSince: null,
        newestKnownUserMessageId: lastNonNull(pageUserIdsOrdered),
        countedAt: Date.now()
      });
      if (complete) updateDiagnosticMax(newTotal);
      broadcastStatus({
        totalTurns: newTotal,
        countState: complete ? "complete" : "partial",
        countComplete: complete,
        countSource: "incremental",
        countFailureReason: complete ? null : "idless-user-record"
      });
      return;
    }

    // mode === "full"
    if (!originalPageInfo || originalPageInfo.has_previous_page !== true) {
      // This single response already is the entire active conversation:
      // no background request needed, and never a lingering "Counting…".
      const total = new Set(pageUserIdsOrdered.filter(Boolean)).size + countMissing(pageUserIdsOrdered);
      const complete = !pageHasIdlessUser;
      saveCountCache(conversationId, {
        conversationId,
        totalTurns: total,
        complete,
        dedupeReliable: complete,
        countedAt: Date.now(),
        pagesWalked: 0,
        failureReason: complete ? null : "idless-user-record",
        staleSince: null,
        newestKnownUserMessageId: lastNonNull(pageUserIdsOrdered),
        oldestKnownUserMessageId: pageUserIdsOrdered.filter(Boolean)[0] || null
      });
      if (complete) updateDiagnosticMax(total);
      broadcastStatus({
        totalTurns: total,
        countState: complete ? "complete" : "partial",
        countComplete: complete,
        countSource: "single-page",
        countFailureReason: complete ? null : "idless-user-record"
      });
      return;
    }

    // A full walk is needed. Only ever one at a time per conversation.
    if (walkInFlightFor === conversationId) {
      logCount("walk-skipped", { conversationId, reason: "already-in-flight" });
      return;
    }
    walkInFlightFor = conversationId;

    broadcastStatus({
      totalTurns: 0,
      countState: "counting",
      countComplete: false,
      countSource: "walk",
      countFailureReason: null
    });

    // Fire-and-forget: must never block or delay the display response.
    walkAndCount({
      conversationId,
      baseUrl: requestUrl,
      requestInit,
      initialPageInfo: originalPageInfo,
      initialUserIds: pageUserIdsOrdered,
      initialRecordIds: pageRecordIds,
      generation
    }).catch(() => {
      if (isGenerationActive(conversationId, generation)) {
        broadcastStatus({ countState: "error", countComplete: false, countSource: "walk", countFailureReason: "unexpected" });
      }
    }).finally(() => {
      if (walkInFlightFor === conversationId) walkInFlightFor = null;
    });
  }

  // A send (POST) can add a user turn that the cached total predates. Mark it
  // provisionally stale so the UI stops claiming an exact total; the next real
  // GET re-verifies against the server and either confirms or recounts.
  function markActiveConversationStale() {
    const conversationId = activeConversationId;
    if (!conversationId) return;
    const cache = getCountCache(conversationId);
    if (cache && cache.complete === true && !cache.staleSince) {
      saveCountCache(conversationId, { ...cache, staleSince: Date.now() });
    }
    if (currentStatus.countState === "complete") {
      broadcastStatus({ countState: "stale", countComplete: false });
    }
  }

  // ---------- Older-message hydration (the "Load More" path) ----------
  //
  // Trimming alone can never reveal turns that were not in the response, so
  // "Load +N" / "Load All" used to be capped by whatever the first page held.
  // This walks the same proven backwards pagination as the counter, but keeps
  // the messages instead of only counting them, and hands them to React.
  //
  // Runs ONLY when the user explicitly asked for more turns. It delays that
  // one response on purpose - the click already triggers a page reload.

  const HYDRATE_TIME_BUDGET_MS = 20000;
  // Full export is an explicit archive action with progress feedback, so it
  // gets a much larger budget than an interactive "Load more" reload. A chat
  // that is genuinely at ChatGPT's real length limit can need many pages
  // even with the correct pagination contract already known - 3 minutes was
  // observed cutting off a real 296+ message walk mid-way.
  const FULL_EXPORT_TIME_BUDGET_MS = 600000;

  function countUserTurns(messages) {
    if (!Array.isArray(messages)) return 0;
    let n = 0;
    for (const m of messages) if (m?.author?.role === "user") n++;
    return n;
  }

  // Some accounts/conversations never trigger ChatGPT's own "load older
  // messages" request while the speed booster is on (it deliberately tells
  // React has_previous_page:false to stop native infinite scroll - see the
  // fetch interceptor above). That means resolveBackwardPagination's default
  // parameter-name guess is sometimes just wrong, and the walk fails after
  // page 1 with "no-progress" even though the server has plenty more.
  //
  // Instead of trusting the guess, try every plausible parameter name once
  // (cheap: a handful of GETs, first hop only) and keep whichever one
  // actually returns records we do not already have. The winner is cached
  // via observePaginationRequest's own storage key so every later page in
  // this walk, and every future export, skips straight to the right name.
  async function discoverPaginationContract({ baseUrl, requestInit, pageInfo, oldestRecordId, seenRecordIds }) {
    const fromPageInfo = pickBackwardCursor(pageInfo);
    const cursorValue = fromPageInfo?.value || oldestRecordId;
    if (!cursorValue) return { error: "pagination-contract-unknown" };

    // A real server/network error is far more useful to surface than a flat
    // "unknown contract" once every candidate has been tried, so the last one
    // seen wins unless a later candidate actually succeeds.
    let lastError = null;

    for (const name of PAGINATION_PARAM_CANDIDATES) {
      let candidateUrl;
      try {
        const u = new URL(baseUrl, window.location.origin);
        u.searchParams.set(name, cursorValue);
        candidateUrl = u.toString();
      } catch {
        continue;
      }

      let res;
      try {
        // Single attempt per candidate, straight through originalFetch: this
        // is a cheap probe for the real parameter name, not a resilient
        // fetch - retrying every wrong guess would multiply the cost by the
        // whole candidate list for nothing.
        res = await originalFetch.call(window, candidateUrl, requestInit);
      } catch {
        lastError = "network";
        continue;
      }
      if (!res.ok) {
        lastError = `http-${res.status}`;
        continue;
      }

      let pageData;
      try {
        let text = await res.text();
        if (text.charCodeAt(0) === 65279) text = text.slice(1);
        pageData = JSON.parse(text);
      } catch {
        lastError = "parse";
        continue;
      }
      if (!pageData || !Array.isArray(pageData.messages)) {
        lastError = "schema";
        continue;
      }

      const fresh = pageData.messages.filter((m) => m?.id == null || !seenRecordIds.has(String(m.id)));
      if (fresh.length > 0) {
        const record = { parameterName: name, extraParams: {}, learnedAt: Date.now() };
        observedPagination = { ...record, lastCursorValue: cursorValue };
        try { localStorage.setItem(STORAGE_PAGINATION_KEY, JSON.stringify(record)); } catch {}
        logCount("contract-discovered", { parameterName: name });
        return { parameterName: name, pageData };
      }
    }
    return { error: lastError || "pagination-contract-unknown" };
  }

  async function hydrateOlderMessages({
    baseUrl, requestInit, pageInfo, messages, turnLimit,
    timeBudgetMs = HYDRATE_TIME_BUDGET_MS, onProgress = null
  }) {
    let merged = messages.slice();
    const seenRecordIds = new Set(getRecordIds(messages));
    const seenCursors = new Set();
    let currentPageInfo = pageInfo;
    let oldestRecordId = getRecordIds(messages)[0] || null;
    let pagesFetched = 0;
    let reachedStart = false;
    let failureReason = null;
    const deadline = Date.now() + timeBudgetMs;

    try {
      while (countUserTurns(merged) < turnLimit) {
        if (!currentPageInfo || currentPageInfo.has_previous_page !== true) { reachedStart = true; break; }
        if (pagesFetched >= COUNT_MAX_PAGES) { failureReason = "max-pages"; break; }
        if (Date.now() > deadline) { failureReason = "time-budget"; break; }

        let pageData;

        if (pagesFetched === 0 && !loadObservedPagination() && !messagesEndpointFor(baseUrl)) {
          const discovery = await discoverPaginationContract({
            baseUrl, requestInit, pageInfo: currentPageInfo, oldestRecordId, seenRecordIds
          });
          if (discovery.error) { failureReason = discovery.error; break; }
          pageData = discovery.pageData;
        } else {
          const plan = resolveBackwardPagination({
            requestUrl: baseUrl,
            pageInfo: currentPageInfo,
            oldestRecordId,
            allowProbe: pagesFetched === 0
          });
          if (!plan.supported) { failureReason = plan.reason || "pagination-contract-unknown"; break; }
          if (seenCursors.has(plan.cursorValue)) { failureReason = "duplicate-cursor"; break; }
          seenCursors.add(plan.cursorValue);

          const attempt = await fetchPageWithRetry(plan.nextUrl, requestInit, () => true);
          if (attempt.error) { failureReason = attempt.error; break; }

          try {
            let text = await attempt.res.text();
            if (text.charCodeAt(0) === 65279) text = text.slice(1);
            pageData = JSON.parse(text);
          } catch {
            failureReason = "parse"; break;
          }
        }
        if (!pageData || !Array.isArray(pageData.messages)) { failureReason = "schema"; break; }
        if (pageData.messages.length === 0) {
          if (!pageData.page_info || pageData.page_info.has_previous_page !== true) {
            reachedStart = true;
            break;
          }
          failureReason = "empty-page";
          break;
        }

        // Keep only records we do not already hold, preserving server order.
        const fresh = pageData.messages.filter(
          (m) => m?.id == null || !seenRecordIds.has(String(m.id))
        );
        if (fresh.length === 0) {
          if (!pageData.page_info || pageData.page_info.has_previous_page !== true) {
            reachedStart = true;
            break;
          }
          failureReason = "no-progress";
          break;
        }
        for (const m of fresh) if (m?.id != null) seenRecordIds.add(String(m.id));

        // concat, not unshift(...spread): a long chat would blow the stack.
        merged = fresh.concat(merged);

        const pageRecords = getRecordIds(pageData.messages);
        if (pageRecords[0]) oldestRecordId = pageRecords[0];
        currentPageInfo = pageData.page_info;
        pagesFetched++;

        logCount("hydrate-page", {
          pageIndex: pagesFetched,
          addedRecords: fresh.length,
          userTurnsNow: countUserTurns(merged),
          turnLimit,
          hasPreviousPage: !!(currentPageInfo && currentPageInfo.has_previous_page)
        });
        if (onProgress) {
          try { onProgress({ pages: pagesFetched, turns: countUserTurns(merged) }); } catch {}
        }

        if (!currentPageInfo || currentPageInfo.has_previous_page !== true) { reachedStart = true; break; }
        await sleep(COUNT_REQUEST_DELAY_MS);
      }
    } catch {
      failureReason = failureReason || "unexpected";
    }

    return { messages: merged, pagesFetched, reachedStart, failureReason, lastPageInfo: currentPageInfo };
  }

  // ---------- Full-conversation collection (export source) ----------
  //
  // Exporting from the DOM can only ever yield what trimming left on screen.
  // This walks the conversation API instead, so a maxed-out chat can be
  // archived in full WITHOUT flooding the DOM and killing the speed booster.
  // The API also hands back `content.parts` as the model's original markdown,
  // which round-trips far better than anything recovered from rendered HTML.

  // Last real conversation GET, reused so export requests look exactly like
  // ChatGPT's own (headers included - never read, stored or logged by us).
  let lastConversationRequest = null;
  let fullExportInFlight = false;

  function apiMessagesToExport(messages) {
    const out = [];
    if (!Array.isArray(messages)) return out;
    for (const m of messages) {
      const role = m?.author?.role;
      if (role !== "user" && role !== "assistant") continue;
      if (m?.metadata?.is_visually_hidden_from_conversation) continue;
      const parts = m?.content?.parts;
      if (!Array.isArray(parts)) continue;
      // Drop ChatGPT's private-use citation tokens (U+E200 ... U+E201):
      // they only mean something inside ChatGPT's own renderer.
      const text = parts.filter((p) => typeof p === "string").join("\n")
        .replace(/\uE200[^\uE201]*\uE201/g, "").replace(/[\uE200-\uE2FF]/g, "").trim();
      if (!text) continue;
      out.push({ role: role === "user" ? "User" : "ChatGPT", text });
    }
    return out;
  }

  // ---------- Local archive feed ----------
  //
  // Every conversation payload ChatGPT loads already passes through this
  // interceptor in full, before trimming. Handing a copy to the content
  // script lets it keep a local archive, so exporting never needs a second
  // (refusable, rate-limited) request to OpenAI. No extra request is made
  // here; this only reuses what ChatGPT fetched for itself.

  // Must stay identical to imageKeyFromPointer() in src/content/archive.js.
  function archiveImageKey(pointer) {
    const m = /(file[-_][A-Za-z0-9]{6,})/.exec(String(pointer || "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""));
    if (!m) return null;
    return /^file_[0-9a-f]+$/i.test(m[1]) ? m[1].toLowerCase() : m[1];
  }

  function apiMessagesToArchive(messages) {
    const out = [];
    if (!Array.isArray(messages)) return out;
    for (const m of messages) {
      const role = m?.author?.role;
      if (role !== "user" && role !== "assistant" && role !== "tool") continue;
      if (m?.metadata?.is_visually_hidden_from_conversation) continue;
      if (m.id == null) continue;
      const parts = m?.content?.parts;
      if (!Array.isArray(parts)) continue;
      const texts = [];
      const images = [];
      for (const p of parts) {
        if (typeof p === "string") { texts.push(p); continue; }
        if (p && typeof p === "object" && p.content_type === "image_asset_pointer" && typeof p.asset_pointer === "string") {
          const key = archiveImageKey(p.asset_pointer);
          if (key) {
            images.push({
              key,
              pointer: p.asset_pointer,
              width: Number.isFinite(p.width) ? p.width : null,
              height: Number.isFinite(p.height) ? p.height : null
            });
          }
        }
      }
      // Tool output text (browsing results, code runs) is noise in an
      // archive; tool messages are kept only for the images they carry
      // (generated pictures).
      const text = role === "tool" ? "" : texts.join("\n").trim();
      if (!text && images.length === 0) continue;
      out.push({
        id: String(m.id),
        role: role === "user" ? "User" : "ChatGPT",
        text,
        createTime: typeof m.create_time === "number" ? m.create_time : null,
        origin: "server",
        images
      });
    }
    return out;
  }

  // The first snapshot of a page load is posted at document_start, before
  // the content script exists. The latest one is kept so it can be re-sent.
  let lastArchiveSnapshot = null;

  function postArchiveSnapshot(conversationId, title, messages, complete, pageInfo = null) {
    if (!conversationId) return;
    try {
      const archiveMessages = apiMessagesToArchive(messages);
      // A page of only tool/system records still moves the history cursor.
      if (archiveMessages.length === 0 && !pageInfo) return;
      lastArchiveSnapshot = {
        conversationId,
        title: typeof title === "string" ? title : null,
        complete: complete === true,
        messages: archiveMessages,
        cursor: pageInfo
          ? { start: pageInfo.start_cursor || null, hasPrevious: pageInfo.has_previous_page === true }
          : null
      };
      window.postMessage({ type: "turbogpt-archive-snapshot", payload: lastArchiveSnapshot }, "*");
    } catch {}
  }

  // Read a copy of a response ChatGPT receives unmodified. clone() happens
  // synchronously, before ChatGPT can consume the body; parsing runs in the
  // background and never delays or alters the original.
  function archiveFromUntouchedResponse(response, requestUrl) {
    if (!response || !response.ok) return;
    let copy;
    try { copy = response.clone(); } catch { return; }
    (async () => {
      let text = await copy.text();
      if (text.charCodeAt(0) === 65279) text = text.slice(1);
      const data = JSON.parse(text);
      if (!data) return;
      const conversationId = extractConversationId(requestUrl) || extractConversationId(response.url);
      if (data.mapping && typeof data.current_node === "string") {
        postArchiveSnapshot(conversationId, data.title, extractMessagesFromMapping(data.mapping, data.current_node), true);
      } else if (Array.isArray(data.messages)) {
        const firstPage = !isOlderMessagesUrl(requestUrl, "GET");
        postArchiveSnapshot(conversationId, firstPage ? data.title : null, data.messages,
          firstPage && data.page_info?.has_previous_page !== true, data.page_info || null);
      }
    })().catch(() => {});
  }

  // Background history fill for the local archive. Walks older pages with
  // ChatGPT's own request shape and headers, one page every 1.5s, posting
  // each page the moment it arrives - so a refusal or a closed tab loses
  // nothing, and the next run resumes from the oldest saved page.
  const BACKFILL_PAGE_DELAY_MS = 1500;
  let backfillInFlightFor = null;

  async function backfillArchive(conversationId, before, maxPages) {
    const req = lastConversationRequest;
    if (!req || req.conversationId !== conversationId) return { error: "no-conversation", pages: 0 };
    const ep = messagesEndpointFor(req.url);
    if (!ep) return { error: "unsupported-client", pages: 0 };
    if (walkInFlightFor === conversationId) return { error: "walk-in-flight", pages: 0 };
    const stillHere = () => lastConversationRequest?.conversationId === conversationId;
    let cursor = before;
    let pages = 0;
    while (cursor && pages < maxPages) {
      if (!stillHere()) return { error: "cancelled", pages };
      const attempt = await fetchPageWithRetry(buildOlderMessagesUrl(ep, cursor), req.init, stillHere);
      if (attempt.error) return { error: attempt.error, pages };
      let data;
      try {
        let text = await attempt.res.text();
        if (text.charCodeAt(0) === 65279) text = text.slice(1);
        data = JSON.parse(text);
      } catch {
        return { error: "parse", pages };
      }
      if (!data || !Array.isArray(data.messages)) return { error: "schema", pages };
      pages++;
      postArchiveSnapshot(conversationId, null, data.messages, false, data.page_info || { has_previous_page: false });
      const pi = data.page_info || {};
      if (pi.has_previous_page !== true) return { reachedStart: true, pages };
      if (!pi.start_cursor || pi.start_cursor === cursor) return { error: "no-progress", pages };
      cursor = pi.start_cursor;
      await sleep(BACKFILL_PAGE_DELAY_MS);
    }
    return { more: true, pages };
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== "turbogpt-archive-backfill") return;
    const { conversationId, before } = e.data;
    const maxPages = Math.max(1, Math.min(200, Number(e.data.maxPages) || 40));
    if (!conversationId || !before || backfillInFlightFor === conversationId) return;
    backfillInFlightFor = conversationId;
    backfillArchive(conversationId, String(before), maxPages)
      .catch(() => ({ error: "unexpected", pages: 0 }))
      .then((result) => {
        backfillInFlightFor = null;
        window.postMessage({ type: "turbogpt-archive-backfill-done", payload: { conversationId, ...result } }, "*");
      });
  });

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== "turbogpt-request-archive-snapshot") return;
    if (!lastArchiveSnapshot) return;
    window.postMessage({ type: "turbogpt-archive-snapshot", payload: lastArchiveSnapshot }, "*");
  });

  // Images the page never rendered (trimmed turns) can only be saved by
  // asking ChatGPT's own file endpoint for a fresh signed URL - the same
  // call ChatGPT makes when it displays an image. One lightweight GET per
  // missing image, only on the content script's request, never repeated
  // once the image is stored. Endpoint shapes are tried in turn because
  // they differ between upload kinds; a miss just leaves the image out.
  async function resolveImageDownloadUrl(pointer, conversationId) {
    const idMatch = /(file[-_][A-Za-z0-9]+)/.exec(String(pointer || "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""));
    if (!idMatch) return null;
    const fileId = encodeURIComponent(idMatch[1]);
    const cid = conversationId ? `conversation_id=${encodeURIComponent(conversationId)}&` : "";
    const origin = window.location.origin;
    const viaDownload = `${origin}/backend-api/files/download/${fileId}?${cid}inline=false`;
    const viaFile = `${origin}/backend-api/files/${fileId}/download`;
    const candidates = /^sediment:\/\//.test(String(pointer)) ? [viaDownload, viaFile] : [viaFile, viaDownload];
    const init = lastConversationRequest?.init || { method: "GET", credentials: "include" };
    for (const url of candidates) {
      let res;
      try {
        res = await originalFetch.call(window, url, init);
      } catch {
        continue;
      }
      if (!res || !res.ok) continue;
      let data;
      try { data = await res.json(); } catch { continue; }
      const u = data && (data.download_url || data.url);
      if (typeof u === "string" && /^https:\/\//i.test(u)) return u;
    }
    return null;
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== "turbogpt-resolve-image") return;
    const { requestId, pointer, conversationId } = e.data;
    resolveImageDownloadUrl(pointer, conversationId)
      .catch(() => null)
      .then((url) => {
        window.postMessage({ type: "turbogpt-resolved-image", requestId, url: url || null }, "*");
      });
  });

  function extractMessagesFromMapping(mapping, currentNode) {
    if (!mapping || typeof mapping !== "object" || !currentNode) return [];
    const messages = [];
    const seen = new Set();
    let curr = currentNode;
    while (curr && mapping[curr] && !seen.has(curr)) {
      seen.add(curr);
      const node = mapping[curr];
      if (node.message) {
        // push + reverse, not unshift: unshift in a loop is quadratic and
        // this chain is walked for every conversation open.
        messages.push(node.message);
      }
      curr = node.parent;
    }
    messages.reverse();
    return messages;
  }

  // The interceptor replaces the body, so the original transfer headers no
  // longer describe it. Spreading `undefined` into a Headers init used to
  // turn them into the literal string "undefined" instead of removing them.
  function buildJsonResponse(original, data) {
    const headers = new Headers(original.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "application/json; charset=utf-8");
    const modified = new Response(JSON.stringify(data), {
      status: original.status,
      statusText: original.statusText,
      headers
    });
    try { Object.defineProperty(modified, "url", { value: original.url }); } catch {}
    return modified;
  }

  async function collectFullConversation() {
    if (!lastConversationRequest) return { error: "no-conversation" };
    const { url, init, conversationId } = lastConversationRequest;

    const first = await fetchPageWithRetry(url, init, () => true);
    if (first.error) return { error: first.error };

    let data;
    try {
      let text = await first.res.text();
      if (text.charCodeAt(0) === 65279) text = text.slice(1);
      data = JSON.parse(text);
    } catch {
      return { error: "parse" };
    }
    if (!data) return { error: "schema" };

    if (data.mapping && typeof data.current_node === "string") {
      const chain = extractMessagesFromMapping(data.mapping, data.current_node);
      postArchiveSnapshot(conversationId, data.title, chain, true);
      return {
        conversationId,
        messages: apiMessagesToExport(chain),
        complete: true,
        pagesFetched: 1,
        failureReason: null
      };
    }

    if (!Array.isArray(data.messages)) return { error: "schema" };

    const result = await hydrateOlderMessages({
      baseUrl: url,
      requestInit: init,
      pageInfo: data.page_info,
      messages: data.messages,
      turnLimit: Number.MAX_SAFE_INTEGER,
      timeBudgetMs: FULL_EXPORT_TIME_BUDGET_MS,
      onProgress: (p) => {
        window.postMessage({ type: "turbogpt-full-export-progress", payload: p }, "*");
      }
    });
    postArchiveSnapshot(conversationId, data.title, result.messages, result.reachedStart === true,
      result.pagesFetched > 0 ? result.lastPageInfo : data.page_info);

    return {
      conversationId,
      messages: apiMessagesToExport(result.messages),
      complete: result.reachedStart,
      pagesFetched: result.pagesFetched,
      failureReason: result.failureReason
    };
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== "turbogpt-request-full-export") return;
    if (fullExportInFlight) return;
    fullExportInFlight = true;
    collectFullConversation()
      .then((payload) => {
        window.postMessage({ type: "turbogpt-full-export", payload }, "*");
      })
      .catch(() => {
        window.postMessage({ type: "turbogpt-full-export", payload: { error: "unexpected" } }, "*");
      })
      .finally(() => { fullExportInFlight = false; });
  });

  // ---------- Display path (behavior unchanged) ----------

  function isConversationUrl(url, method) {
    if (method !== "GET") return false;
    return /\/backend-api\/conversations?\/[a-f0-9-]+(?:\?|$)/i.test(url) &&
           !url.includes("/textdocs") &&
           !url.includes("/init");
  }

  function isConversationSendUrl(url, method) {
    if (method !== "POST") return false;
    if (!/\/backend-api\/conversation(?:\/|\?|$)/i.test(url)) return false;
    return !/\/(?:gen_title|textdocs|init|voice|share)\b/i.test(url);
  }

  function trimConversationMessages(messages, turnLimit) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    const userIndices = [];
    messages.forEach((msg, idx) => {
      if (msg.author?.role === "user") {
        userIndices.push(idx);
      }
    });

    if (userIndices.length === 0 || userIndices.length <= turnLimit) {
      return messages;
    }

    const startIdx = userIndices[userIndices.length - turnLimit];
    return messages.slice(startIdx);
  }

  async function processConversationPayload(response, config, requestUrl, requestInit) {
    try {
      let rawText = await response.clone().text();
      if (rawText.charCodeAt(0) === 65279) rawText = rawText.slice(1);

      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        return response;
      }

      if (!data) return response;

      const isMessagesFormat = Array.isArray(data.messages);
      const isMappingFormat = data.mapping && typeof data.mapping === "object" && typeof data.current_node === "string";

      if (!isMessagesFormat && !isMappingFormat) {
        return response;
      }

      const conversationId = extractConversationId(requestUrl) || extractConversationId(response.url);
      if (conversationId !== activeConversationId) {
        activeConversationId = conversationId;
        countGeneration++;
        // Drop every field of the previous conversation - a leftover
        // totalTurns/countState must never be shown against a new chat.
        currentStatus = {};
      }
      const myGeneration = countGeneration;

      const extra = getExtraTurns();
      const autoScrollActive = config.enableAutoScrollLoad === true && !config.liveAutoTrim && extra === 0;

      // When auto-scroll loading is active on initial open, preserve older turns up to a safe buffer
      // (e.g. up to 50 user turns) so that React mounts them into the DOM.
      // enforceDomTurnLimit in content script immediately hides any turns beyond
      // messageLimit using .turbogpt-dom-hidden (display: none !important), keeping DOM layout cost zero.
      // When the user scrolls up, these turns are unhidden instantly in 0ms without any page reload!
      const payloadTurnLimit = autoScrollActive
        ? Math.max(50, config.messageLimit)
        : Math.max(1, config.messageLimit + extra);

      if (isMappingFormat) {
        const allMessages = extractMessagesFromMapping(data.mapping, data.current_node);
        // Full active branch, captured before any trimming.
        postArchiveSnapshot(conversationId, data.title, allMessages, true);
        const totalUserTurns = countUserTurns(allMessages);
        const allUserIdsOrdered = getUserIdsInOrder(allMessages);

        let keptMessages = allMessages;
        if (!autoScrollActive && totalUserTurns > payloadTurnLimit) {
          keptMessages = trimConversationMessages(allMessages, payloadTurnLimit);
          const firstKeptId = keptMessages[0]?.id;
          if (firstKeptId) {
            // Node ids equal message ids in this format; try the direct key
            // first and only scan the whole tree if that misses.
            let targetNodeId = data.mapping[firstKeptId] ? firstKeptId : null;
            if (!targetNodeId) {
              for (const nid in data.mapping) {
                if (data.mapping[nid]?.message?.id === firstKeptId) {
                  targetNodeId = nid;
                  break;
                }
              }
            }
            if (targetNodeId && data.mapping[targetNodeId]) {
              data.mapping[targetNodeId].parent = "client-created-root";
            }
          }
        }

        const visibleTurns = autoScrollActive
          ? Math.min(config.messageLimit + extra, totalUserTurns)
          : countUserTurns(keptMessages);
        const hasOlder = totalUserTurns > visibleTurns;

        saveCountCache(conversationId, {
          conversationId,
          totalTurns: totalUserTurns,
          complete: true,
          countedAt: Date.now(),
          pagesWalked: 0,
          failureReason: null,
          dedupeReliable: true,
          newestKnownUserMessageId: lastNonNull(allUserIdsOrdered),
          oldestKnownUserMessageId: allUserIdsOrdered.filter(Boolean)[0] || null
        });
        updateDiagnosticMax(totalUserTurns);

        broadcastStatus({
          conversationId,
          visibleTurns,
          totalMessages: allMessages.length,
          renderedMessages: keptMessages.length,
          totalBackendRecords: allMessages.length,
          loadedBackendRecords: keptMessages.length,
          visibleBackendRecords: keptMessages.length,
          hasOlderMessages: hasOlder,
          serverHasOlder: false,
          extraTurns: extra,
          turnLimit: config.messageLimit + extra,
          hydratedPages: 0,
          hydrationFailureReason: null,
          reachedConversationStart: true,
          rootId: keptMessages[0]?.id || null,
          totalTurns: totalUserTurns,
          countState: "complete",
          countComplete: true,
          countSource: "mapping-tree",
          countFailureReason: null
        });

        return buildJsonResponse(response, data);
      }

      // Capture pagination truth BEFORE any mutation, for the counting path.
      const originalPageInfo = data.page_info ? { ...data.page_info } : null;
      const pageUserIdsOrdered = getUserIdsInOrder(data.messages);
      const pageRecordIds = getRecordIds(data.messages);

      // "Load older messages" fix: the requested turns may live on pages the
      // first response never contained. When (and ONLY when) the user has
      // explicitly asked for more, fetch older pages and merge them in before
      // React renders. A normal chat open never enters this branch, so the
      // speed booster is untouched.
      let workingMessages = data.messages;
      let hydration = { pagesFetched: 0, reachedStart: false, failureReason: null };
      const serverHasOlderInitially = originalPageInfo?.has_previous_page === true;

      const shouldHydrate = (extra > 0 || autoScrollActive) && serverHasOlderInitially && countUserTurns(workingMessages) < payloadTurnLimit;

      if (shouldHydrate) {
        hydration = await hydrateOlderMessages({
          baseUrl: requestUrl,
          requestInit,
          pageInfo: originalPageInfo,
          messages: workingMessages,
          turnLimit: payloadTurnLimit
        });
        workingMessages = hydration.messages;
      }

      postArchiveSnapshot(
        conversationId,
        data.title,
        workingMessages,
        hydration.pagesFetched > 0 ? hydration.reachedStart : !serverHasOlderInitially,
        hydration.pagesFetched > 0 ? hydration.lastPageInfo : originalPageInfo
      );

      const totalMessages = workingMessages.length;
      const keptMessages = trimConversationMessages(workingMessages, payloadTurnLimit);
      const renderedCount = keptMessages.length;
      const visibleTurns = autoScrollActive
        ? Math.min(config.messageLimit + extra, countUserTurns(keptMessages))
        : countUserTurns(keptMessages);
      // Older messages still exist on the server that are not on screen.
      const serverHasOlder = hydration.pagesFetched > 0
        ? !hydration.reachedStart
        : serverHasOlderInitially;
      const hasOlder = serverHasOlder || totalMessages > renderedCount;

      broadcastStatus({
        conversationId,
        visibleTurns,
        // Legacy fields kept as-is (record counts, now across merged pages).
        // Diagnostic only - never the popup's ratio.
        totalMessages,
        renderedMessages: renderedCount,
        totalBackendRecords: totalMessages,
        loadedBackendRecords: renderedCount,
        visibleBackendRecords: renderedCount,
        hasOlderMessages: hasOlder,
        serverHasOlder,
        extraTurns: extra,
        turnLimit: config.messageLimit + extra,
        hydratedPages: hydration.pagesFetched,
        hydrationFailureReason: hydration.failureReason,
        reachedConversationStart: hydration.pagesFetched > 0 ? hydration.reachedStart : !serverHasOlderInitially,
        rootId: keptMessages[0]?.id || null
      });

      // Counting path runs independently of the response below - it must
      // never delay or influence what React receives.
      // When hydration already pulled older pages, hand those to the counter
      // so it resumes where hydration stopped instead of re-fetching them.
      // If hydration reached the start, the merged array IS the whole
      // conversation and the count needs no requests at all.
      const hydrated = hydration.pagesFetched > 0;
      const countUserIds = hydrated ? getUserIdsInOrder(workingMessages) : pageUserIdsOrdered;
      const countRecordIds = hydrated ? getRecordIds(workingMessages) : pageRecordIds;
      const countPageInfo = hydrated
        ? (hydration.reachedStart ? { has_previous_page: false } : hydration.lastPageInfo)
        : originalPageInfo;
      try {
        startCountingPath(conversationId, requestUrl, requestInit, countPageInfo, countUserIds, countRecordIds, myGeneration);
      } catch {}

      data.messages = keptMessages;
      if (data.page_info) {
        data.page_info.start_cursor = keptMessages[0]?.id || data.page_info.start_cursor;
        // Disable native infinite scroll observer to prevent unintended scroll-jumping
        data.page_info.has_previous_page = false;
      }

      return buildJsonResponse(response, data);
    } catch (err) {
      return response;
    }
  }

  // Intercept window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const [resource, fetchConfig] = args;
    const url = resource instanceof Request ? resource.url : String(resource);
    const method = (fetchConfig?.method || (resource instanceof Request ? resource.method : "GET")).toUpperCase();

    const appConfig = getActiveConfig();

    // Observe (never block) regardless of the on/off switch: with acceleration
    // off, ChatGPT loads its own history, and that is the one moment it really
    // issues a pagination request. Learning its shape then is what lets the
    // fast background paths work afterwards.
    if (isConversationUrl(url, method)) {
      if (isPaginationRequest(url)) {
        try { observePaginationRequest(url); } catch {}
      } else {
        lastConversationRequest = {
          url,
          init: buildBaseRequestInit(resource, fetchConfig),
          conversationId: extractConversationId(url)
        };
      }
    }

    if (!appConfig.enabled) {
      // Booster off: the response goes to ChatGPT untouched, but the local
      // archive still gets its copy. It is independent of the speed switch.
      if ((isConversationUrl(url, method) && !isPaginationRequest(url)) || isOlderMessagesUrl(url, method)) {
        const res = await originalFetch.apply(this, args);
        archiveFromUntouchedResponse(res, url);
        return res;
      }
      return originalFetch.apply(this, args);
    }

    // ChatGPT's own "load older messages" page. Display behaviour is left
    // exactly as ChatGPT intends; the archive just keeps a copy.
    if (isOlderMessagesUrl(url, method)) {
      const res = await originalFetch.apply(this, args);
      archiveFromUntouchedResponse(res, url);
      return res;
    }

    if (isConversationSendUrl(url, method)) {
      try { markActiveConversationStale(); } catch {}
      return originalFetch.apply(this, args);
    }

    if (isConversationUrl(url, method)) {
      // Block ChatGPT's own "load older messages" request from prepending
      // history into the DOM - but read its SHAPE first. This request is the
      // only authoritative description of how this API paginates, so we learn
      // the real parameter name from it instead of inventing one.
      if (isPaginationRequest(url)) {
        try { observePaginationRequest(url); } catch {}
        const emptyPayload = { messages: [], page_info: { has_previous_page: false } };
        return new Response(JSON.stringify(emptyPayload), {
          status: 200,
          headers: new Headers({ "content-type": "application/json; charset=utf-8" })
        });
      }

      const requestInit = buildBaseRequestInit(resource, fetchConfig);
      lastConversationRequest = {
        url,
        init: requestInit,
        conversationId: extractConversationId(url)
      };
      const rawResponse = await originalFetch.apply(this, args);
      return processConversationPayload(rawResponse, appConfig, url, requestInit);
    }

    return originalFetch.apply(this, args);
  };

  window.__TURBOGPT_PROXY_INSTALLED__ = true;
})();
