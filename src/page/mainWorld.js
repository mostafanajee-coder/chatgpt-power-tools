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
    messageLimit: 15
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

  function getActiveConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
          messageLimit: Math.max(1, parsed.messageLimit ?? DEFAULT_CONFIG.messageLimit)
        };
      }
    } catch {}
    return DEFAULT_CONFIG;
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
  function resolveBackwardPagination({ requestUrl, pageInfo, oldestRecordId, allowProbe }) {
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
  // gets a much larger budget than an interactive "Load more" reload.
  const FULL_EXPORT_TIME_BUDGET_MS = 180000;

  function countUserTurns(messages) {
    if (!Array.isArray(messages)) return 0;
    let n = 0;
    for (const m of messages) if (m?.author?.role === "user") n++;
    return n;
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

        let pageData;
        try {
          let text = await attempt.res.text();
          if (text.charCodeAt(0) === 65279) text = text.slice(1);
          pageData = JSON.parse(text);
        } catch {
          failureReason = "parse"; break;
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
      const text = parts.filter((p) => typeof p === "string").join("\n").trim();
      if (!text) continue;
      out.push({ role: role === "user" ? "User" : "ChatGPT", text });
    }
    return out;
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
    if (!data || !Array.isArray(data.messages)) return { error: "schema" };

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

      if (!data || !Array.isArray(data.messages)) {
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

      // Capture pagination truth BEFORE any mutation, for the counting path.
      const originalPageInfo = data.page_info ? { ...data.page_info } : null;
      const pageUserIdsOrdered = getUserIdsInOrder(data.messages);
      const pageRecordIds = getRecordIds(data.messages);

      const extra = getExtraTurns();
      const turnLimit = Math.max(1, config.messageLimit + extra);

      // "Load older messages" fix: the requested turns may live on pages the
      // first response never contained. When (and ONLY when) the user has
      // explicitly asked for more, fetch older pages and merge them in before
      // React renders. A normal chat open never enters this branch, so the
      // speed booster is untouched.
      let workingMessages = data.messages;
      let hydration = { pagesFetched: 0, reachedStart: false, failureReason: null };
      const serverHasOlderInitially = originalPageInfo?.has_previous_page === true;

      if (extra > 0 && serverHasOlderInitially && countUserTurns(workingMessages) < turnLimit) {
        hydration = await hydrateOlderMessages({
          baseUrl: requestUrl,
          requestInit,
          pageInfo: originalPageInfo,
          messages: workingMessages,
          turnLimit
        });
        workingMessages = hydration.messages;
      }

      const totalMessages = workingMessages.length;
      const keptMessages = trimConversationMessages(workingMessages, turnLimit);
      const renderedCount = keptMessages.length;
      const visibleTurns = countUserTurns(keptMessages);
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
        turnLimit: turnLimit,
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

      const modifiedResponse = new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers({
          ...Object.fromEntries(response.headers.entries()),
          "content-type": "application/json; charset=utf-8",
          "content-length": undefined,
          "content-encoding": undefined
        })
      });

      Object.defineProperty(modifiedResponse, "url", { value: response.url });
      return modifiedResponse;
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
      return originalFetch.apply(this, args);
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
