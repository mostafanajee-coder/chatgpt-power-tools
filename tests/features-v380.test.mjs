/**
 * Tests for TurboGPT v3.8.0 features:
 * 1. Active DOM Turn Limit Enforcement (Visible Messages = 2)
 * 2. Backup & Restore (JSON)
 * 3. Full-History Search matching and highlighting
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

/* ---------------- 1. Active DOM Turn Limit (Visible Messages) ---------------- */
console.log("--- PART 1: Active DOM Turn Limit Enforcement ---");

function createMockTurnDom(turnCount) {
  const turns = [];
  for (let i = 1; i <= turnCount; i++) {
    const classList = new Set();
    const userRoleEl = {
      tagName: "DIV",
      getAttribute: (k) => (k === "data-message-author-role" ? "user" : null)
    };
    const turnEl = {
      tagName: "DIV",
      id: `turn-${i}`,
      classList: {
        add: (c) => classList.add(c),
        remove: (c) => classList.delete(c),
        contains: (c) => classList.has(c)
      },
      getAttribute: (k) => (k === "data-testid" ? `conversation-turn-${i}` : null),
      querySelector: (sel) => (sel.includes('author-role="user"') ? userRoleEl : null),
      querySelectorAll: () => [],
      textContent: `Turn ${i} user query and assistant response.`
    };
    turns.push(turnEl);
  }
  return turns;
}

// Exercise the turn enforcement logic
function testTurnLimitEnforcement(turns, messageLimit) {
  const userTurns = [];
  turns.forEach((turn, idx) => {
    if (turn.querySelector('[data-message-author-role="user"]') || turn.getAttribute('data-message-author-role') === 'user') {
      userTurns.push(idx);
    }
  });

  const effectiveLimit = Math.max(1, messageLimit);
  let cutoffIdx = 0;
  if (userTurns.length > 0) {
    cutoffIdx = userTurns.length > effectiveLimit ? userTurns[userTurns.length - effectiveLimit] : 0;
  } else {
    const exchangeLimit = effectiveLimit * 2;
    cutoffIdx = turns.length > exchangeLimit ? turns.length - exchangeLimit : 0;
  }

  if (cutoffIdx > 0) {
    turns.forEach((turn, idx) => {
      if (idx < cutoffIdx) {
        turn.classList.add("turbogpt-dom-hidden");
      } else {
        turn.classList.remove("turbogpt-dom-hidden");
      }
    });
  } else {
    turns.forEach((turn) => turn.classList.remove("turbogpt-dom-hidden"));
  }
}

const tenTurns = createMockTurnDom(10);
// Apply limit: 2
testTurnLimitEnforcement(tenTurns, 2);

const hiddenCount = tenTurns.filter((t) => t.classList.contains("turbogpt-dom-hidden")).length;
const visibleCount = tenTurns.filter((t) => !t.classList.contains("turbogpt-dom-hidden")).length;

check("DOM Limit 2: exactly 8 turns hidden", hiddenCount === 8, `hidden=${hiddenCount}`);
check("DOM Limit 2: exactly 2 latest turns visible", visibleCount === 2, `visible=${visibleCount}`);
check("DOM Limit 2: turn 9 and 10 remain visible",
  !tenTurns[8].classList.contains("turbogpt-dom-hidden") && !tenTurns[9].classList.contains("turbogpt-dom-hidden"));
check("DOM Limit 2: earlier turns (1..8) hidden",
  tenTurns.slice(0, 8).every((t) => t.classList.contains("turbogpt-dom-hidden")));

// Now update to limit: 5 (live change)
testTurnLimitEnforcement(tenTurns, 5);
const newHidden = tenTurns.filter((t) => t.classList.contains("turbogpt-dom-hidden")).length;
const newVisible = tenTurns.filter((t) => !t.classList.contains("turbogpt-dom-hidden")).length;
check("DOM Limit 5: exactly 5 turns hidden", newHidden === 5, `hidden=${newHidden}`);
check("DOM Limit 5: exactly 5 latest turns visible", newVisible === 5, `visible=${newVisible}`);

// Test: 5 messages on screen with limit 2 -> exactly 3 hidden, 2 visible
const fiveTurns = createMockTurnDom(5);
testTurnLimitEnforcement(fiveTurns, 2);
const fiveHidden = fiveTurns.filter((t) => t.classList.contains("turbogpt-dom-hidden")).length;
const fiveVisible = fiveTurns.filter((t) => !t.classList.contains("turbogpt-dom-hidden")).length;
check("DOM Limit 2 on 5 messages: exactly 3 hidden", fiveHidden === 3, `hidden=${fiveHidden}`);
check("DOM Limit 2 on 5 messages: exactly 2 visible", fiveVisible === 2, `visible=${fiveVisible}`);

// Realistic Alternating Chat: User & Assistant pairs (10 elements = 5 exchanges)
function createAlternatingChatDom(exchangeCount) {
  const turns = [];
  for (let i = 1; i <= exchangeCount; i++) {
    // User turn
    const uClassList = new Set();
    const userRoleEl = { tagName: "DIV", getAttribute: (k) => (k === "data-message-author-role" ? "user" : null) };
    turns.push({
      tagName: "DIV",
      id: `turn-user-${i}`,
      classList: { add: (c) => uClassList.add(c), remove: (c) => uClassList.delete(c), contains: (c) => uClassList.has(c) },
      getAttribute: (k) => (k === "data-testid" ? `conversation-turn-user-${i}` : null),
      querySelector: (sel) => (sel.includes('author-role="user"') ? userRoleEl : null),
      textContent: `User Question ${i}`
    });
    // Assistant turn
    const aClassList = new Set();
    const astRoleEl = { tagName: "DIV", getAttribute: (k) => (k === "data-message-author-role" ? "assistant" : null) };
    turns.push({
      tagName: "DIV",
      id: `turn-assistant-${i}`,
      classList: { add: (c) => aClassList.add(c), remove: (c) => aClassList.delete(c), contains: (c) => aClassList.has(c) },
      getAttribute: (k) => (k === "data-testid" ? `conversation-turn-assistant-${i}` : null),
      querySelector: (sel) => (sel.includes('author-role="assistant"') ? astRoleEl : null),
      textContent: `ChatGPT Response ${i}`
    });
  }
  return turns;
}

const alternatingChat = createAlternatingChatDom(5); // 5 Q&A pairs (10 DOM turns)
// Setting limit = 1 must preserve the last user question AND the assistant response (both visible)
testTurnLimitEnforcement(alternatingChat, 1);
const altHidden = alternatingChat.filter((t) => t.classList.contains("turbogpt-dom-hidden")).length;
const altVisible = alternatingChat.filter((t) => !t.classList.contains("turbogpt-dom-hidden")).length;
check("DOM Limit 1 on alternating chat: keeps 1 complete exchange (user question + bot reply)",
  altVisible === 2 && altHidden === 8, `visible=${altVisible} hidden=${altHidden}`);
check("DOM Limit 1 on alternating chat: last user turn is visible",
  !alternatingChat[8].classList.contains("turbogpt-dom-hidden"), `turn-user-5 visible`);
check("DOM Limit 1 on alternating chat: last assistant turn is visible",
  !alternatingChat[9].classList.contains("turbogpt-dom-hidden"), `turn-assistant-5 visible`);

// Verify getStats adjusted visibleTurns calculation:
function computeReportedVisible({ baseVisible, hiddenCount, enabled }) {
  return (enabled && hiddenCount > 0 && Number.isFinite(baseVisible))
    ? Math.max(1, baseVisible - hiddenCount)
    : baseVisible;
}
check("Stats: adjusts visibleTurns from 10 to 2 when 8 turns hidden",
  computeReportedVisible({ baseVisible: 10, hiddenCount: 8, enabled: true }) === 2);
check("Stats: keeps original visibleTurns if booster disabled",
  computeReportedVisible({ baseVisible: 10, hiddenCount: 8, enabled: false }) === 10);

/* ---------------- 2. Backup & Restore (JSON) ---------------- */
console.log("\n--- PART 2: Backup & Restore (JSON) ---");

const sampleItems = {
  turbogpt_settings: { enabled: true, messageLimit: 2, loadBatchSize: 5 },
  turbogpt_folders: [
    { id: "f1", name: "AI Dev", chats: [{ id: "c1", title: "Test Chat" }] }
  ],
  turbogpt_bookmarks_c1: [
    { id: "m1", snippet: "Pinned message snippet", timestamp: 123456789 }
  ],
  unrelated_key: "should_not_leak"
};

// Simulation of the export logic in popup.js
function buildBackupPayload(items, manifestVersion = "3.8.0") {
  const backup = {
    app: "TurboGPT",
    version: manifestVersion,
    exportedAt: new Date().toISOString(),
    settings: items.turbogpt_settings || {},
    folders: items.turbogpt_folders || [],
    bookmarks: {}
  };
  Object.keys(items || {}).forEach((key) => {
    if (key.startsWith("turbogpt_bookmarks_")) {
      backup.bookmarks[key] = items[key];
    }
  });
  return backup;
}

const backupJson = buildBackupPayload(sampleItems);
check("Backup: app identifier set to TurboGPT", backupJson.app === "TurboGPT");
check("Backup: folders preserved", backupJson.folders.length === 1 && backupJson.folders[0].name === "AI Dev");
check("Backup: settings preserved with messageLimit 2", backupJson.settings.messageLimit === 2);
check("Backup: bookmarks captured", !!backupJson.bookmarks.turbogpt_bookmarks_c1);
check("Backup: unrelated keys excluded", backupJson.unrelated_key === undefined);

// Validate restore
function validateAndExtractRestore(parsedJson) {
  if (!parsedJson || (parsedJson.app !== "TurboGPT" && !parsedJson.folders && !parsedJson.bookmarks && !parsedJson.settings)) {
    throw new Error("Invalid TurboGPT backup file.");
  }
  const toSet = {};
  if (Array.isArray(parsedJson.folders)) toSet["turbogpt_folders"] = parsedJson.folders;
  if (parsedJson.settings) toSet["turbogpt_settings"] = parsedJson.settings;
  if (parsedJson.bookmarks) {
    Object.keys(parsedJson.bookmarks).forEach((k) => {
      if (k.startsWith("turbogpt_bookmarks_")) toSet[k] = parsedJson.bookmarks[k];
    });
  }
  return toSet;
}

const restored = validateAndExtractRestore(backupJson);
check("Restore: validates valid backup", !!restored.turbogpt_folders && !!restored.turbogpt_settings);
let invalidCaught = false;
try { validateAndExtractRestore({ random: "payload" }); } catch { invalidCaught = true; }
check("Restore: rejects invalid payload", invalidCaught);

/* ---------------- 3. Full-History Search Matching ---------------- */
console.log("\n--- PART 3: Full-History Search Matching ---");

const fullMessages = [
  { role: "User", text: "How do I build a Chrome extension without external dependencies?" },
  { role: "ChatGPT", text: "You can use native Vanilla JS and standard browser Web APIs." },
  { role: "User", text: "Can we implement a ZIP generator and DOCX builder in pure JS?" },
  { role: "ChatGPT", text: "Yes, by generating the OOXML XML files and packaging them via raw Uint8Array ZIP structures." }
];

function searchFullHistory(messages, query) {
  const q = query.trim().toLowerCase();
  const matches = [];
  if (!q) return matches;
  messages.forEach((msg, idx) => {
    const lower = msg.text.toLowerCase();
    const matchPos = lower.indexOf(q);
    if (matchPos !== -1) {
      matches.push({
        index: idx,
        role: msg.role,
        text: msg.text,
        matchPos
      });
    }
  });
  return matches;
}

const zipMatches = searchFullHistory(fullMessages, "zip");
check("Search: finds matches across conversation history", zipMatches.length === 2);
check("Search: matches correct user turn", zipMatches[0].index === 2 && zipMatches[0].role === "User");
check("Search: matches correct assistant turn", zipMatches[1].index === 3 && zipMatches[1].role === "ChatGPT");

const emptyMatches = searchFullHistory(fullMessages, "nonexistentwordxyz");
check("Search: empty results on no match", emptyMatches.length === 0);

/* ---------------- 4. Modern ChatGPT DOM & Navigator Badge ---------------- */
console.log("\n--- PART 4: Modern ChatGPT Turn Container & Navigator Badge ---");

function computeOutlineBadgeText({ allUserTurns, visibleUserTurns }) {
  if (allUserTurns.length === 0) return "0";
  if (visibleUserTurns.length < allUserTurns.length) {
    return `${visibleUserTurns.length}`;
  }
  return `${allUserTurns.length}`;
}

const mockAll = [1, 2, 3, 4, 5];
const mockVis = [4, 5]; // 2 visible out of 5
check("Navigator Badge: displays 2 when 2 visible out of 5",
  computeOutlineBadgeText({ allUserTurns: mockAll, visibleUserTurns: mockVis }) === "2");
check("Navigator Badge: displays 5 when all 5 visible",
  computeOutlineBadgeText({ allUserTurns: mockAll, visibleUserTurns: mockAll }) === "5");

// Test container wrapper logic
function getMockTurnItemContainer(turn) {
  if (turn.parentElement && turn.parentElement.parentElement?.classList?.contains("qMYqUG_convSearchResultHighlightRoot")) {
    return turn.parentElement;
  }
  return turn;
}

const mockRoot = { classList: { contains: (cls) => cls === "qMYqUG_convSearchResultHighlightRoot" } };
const mockParentDiv = { parentElement: mockRoot, classList: { add: () => {}, remove: () => {}, contains: () => false }, style: {} };
const mockSectionTurn = { parentElement: mockParentDiv, classList: { add: () => {}, remove: () => {} } };

check("Modern ChatGPT DOM: identifies parent wrapper div inside qMYqUG_convSearchResultHighlightRoot",
  getMockTurnItemContainer(mockSectionTurn) === mockParentDiv);

/* ---------------- 5. Load Older Pill In-Flow Placement ---------------- */
console.log("\n--- PART 5: Load Older Pill In-Flow Placement (Not Sticky) ---");

const indexJsContent = fs.readFileSync("src/content/index.js", "utf8");

check("Floating Pill: uses relative positioning (not sticky top)",
  indexJsContent.includes(".turbogpt-floating-pill {\n        position: relative;") ||
  indexJsContent.includes(".turbogpt-floating-pill {\r\n        position: relative;"));

check("Floating Pill: does not use position: sticky",
  !indexJsContent.includes(".turbogpt-floating-pill {\n        position: sticky;") &&
  !indexJsContent.includes(".turbogpt-floating-pill {\r\n        position: sticky;"));

check("Floating Pill: targets turn item container for insertion",
  indexJsContent.includes("const targetTurn = firstVisibleTurn ? getTurnItemContainer(firstVisibleTurn) : null;") &&
  indexJsContent.includes("targetTurn.parentNode.insertBefore(pill, targetTurn);"));

/* ---------------- 6. Configurable Live Auto-Trim Setting ---------------- */
console.log("\n--- PART 6: Configurable Live Auto-Trim Setting ---");

const popupHtmlContent = fs.readFileSync("src/popup/popup.html", "utf8");
const popupJsContent = fs.readFileSync("src/popup/popup.js", "utf8");

check("Live Auto-Trim: popup HTML contains toggleLiveAutoTrim checkbox",
  popupHtmlContent.includes('id="toggleLiveAutoTrim"'));

check("Live Auto-Trim: popup JS defaults liveAutoTrim to false",
  popupJsContent.includes("liveAutoTrim: false"));

check("Live Auto-Trim: index.js defaults liveAutoTrim to false",
  indexJsContent.includes("liveAutoTrim: false"));

check("Live Auto-Trim: enforces on page load and skips live chat when false",
  indexJsContent.includes("if (isLiveUpdate && !appSettings.liveAutoTrim && initialEnforcementDone)"));

check("Live Auto-Trim: passes { live: true } in MutationObserver",
  indexJsContent.includes("enforceDomTurnLimit({ live: true });"));

/* ---------------- 7. Seamless Auto-Load on Scroll Up ---------------- */
console.log("\n--- PART 7: Seamless Auto-Load on Scroll Up (Gemini-Style) ---");

const bgJsContent = fs.readFileSync("src/background/background.js", "utf8");

check("Auto-Load on Scroll: popup HTML contains toggleAutoScrollLoad checkbox",
  popupHtmlContent.includes('id="toggleAutoScrollLoad"'));

check("Auto-Load on Scroll: popup JS defaults enableAutoScrollLoad to true",
  popupJsContent.includes("enableAutoScrollLoad: true"));

check("Auto-Load on Scroll: index.js defaults enableAutoScrollLoad to true",
  indexJsContent.includes("enableAutoScrollLoad: true"));

check("Auto-Load on Scroll: background.js defaults enableAutoScrollLoad to true",
  bgJsContent.includes("enableAutoScrollLoad: true"));

check("Auto-Load on Scroll: index.js injects turbogpt-scroll-loader styles",
  indexJsContent.includes(".turbogpt-scroll-loader") &&
  indexJsContent.includes(".turbogpt-scroll-spinner"));

check("Auto-Load on Scroll: index.js creates and observes turbogpt-scroll-sentinel",
  indexJsContent.includes('sentinel.id = "turbogpt-scroll-sentinel"') &&
  indexJsContent.includes("scrollIntersectionObserver = new IntersectionObserver"));

check("Auto-Load on Scroll: index.js wires setupAutoScrollLoader into renderAllTools and MutationObserver",
  indexJsContent.includes("function renderAllTools() {") &&
  indexJsContent.includes("setupAutoScrollLoader();") &&
  indexJsContent.includes("removeAutoScrollLoader();"));

check("Auto-Load on Scroll: unhideOlderBatch uses scroll anchoring (diff check)",
  indexJsContent.includes("function unhideOlderBatch(options = {})") &&
  indexJsContent.includes("const diff = newTop - anchorTop;") &&
  indexJsContent.includes("chatContainer.scrollBy({ top: diff, behavior: \"instant\" });"));

check("Auto-Load on Scroll: zero-reload safeguard prevents automatic reload on scroll",
  indexJsContent.includes("if (options.fromScroll) {") &&
  indexJsContent.includes("removeAutoScrollLoader();") &&
  indexJsContent.includes("return false;"));

check("Auto-Load on Scroll: gesture listeners guard against scroll loops when domHidden is 0",
  indexJsContent.includes("st <= 150 && domHidden > 0") &&
  indexJsContent.includes("currentST <= 150 && !isAutoLoadingBatch"));

const mainWorldContent = fs.readFileSync("src/page/mainWorld.js", "utf8");
check("Auto-Load on Scroll: mainWorld buffers up to 50 turns when enableAutoScrollLoad is true",
  mainWorldContent.includes("const autoScrollActive = config.enableAutoScrollLoad === true && !config.liveAutoTrim && extra === 0;") &&
  mainWorldContent.includes("Math.max(50, config.messageLimit)"));

check("Live Auto-Trim: background.js defaults liveAutoTrim to false",
  bgJsContent.includes("liveAutoTrim: false"));

check("Live Auto-Trim: mainWorld.js supports liveAutoTrim in config",
  mainWorldContent.includes("liveAutoTrim: false") &&
  mainWorldContent.includes("liveAutoTrim: parsed.liveAutoTrim === true"));

check("Live Auto-Trim: index.js syncs liveAutoTrim to localStorage and storage change",
  indexJsContent.includes("liveAutoTrim: appSettings.liveAutoTrim === true") &&
  indexJsContent.includes("if (appSettings.liveAutoTrim) {\n      manuallyUnhiddenTurnsCount = 0;"));

check("Live Auto-Trim: setupAutoScrollLoader is disabled when liveAutoTrim is active",
  indexJsContent.includes("appSettings.liveAutoTrim === true") &&
  indexJsContent.includes("removeAutoScrollLoader();"));

check("Live Auto-Trim: immediate triggers on send and streaming completion",
  indexJsContent.includes("wasStreaming && !isStreaming") &&
  indexJsContent.includes("e.key === \"Enter\" && !e.shiftKey && appSettings.enabled && appSettings.liveAutoTrim"));

console.log("\n--- PART 8: Modern Mapping Tree & Virtualizer Spacer Preservation ---");
check("Mapping Tree: mainWorld extracts conversation history from node tree",
  mainWorldContent.includes("function extractMessagesFromMapping(mapping, currentNode)") &&
  mainWorldContent.includes("const chain = extractMessagesFromMapping(data.mapping, data.current_node);") &&
  mainWorldContent.includes("countSource: \"mapping-tree\""));

check("Virtualizer Spacers: index.js preserves scroll spacers during DOM turn limit enforcement",
  indexJsContent.includes("const isSpacer =") &&
  indexJsContent.includes("c.classList.contains(\"h-[var(--last-known-height,var(--estimated-turn-height,50vh))]\")") &&
  indexJsContent.includes("c.className.includes(\"min-h-\")"));

check("Auto-Load on Scroll: hasOlderTurnsToLoad factors in manually unhidden turns",
  indexJsContent.includes("lastStatus.totalTurns > (lastStatus.visibleTurns + manuallyUnhiddenTurnsCount)") &&
  indexJsContent.includes("manuallyUnhiddenTurnsCount += batchSize;"));

const totalPassed = results.filter((r) => r.pass).length;
console.log(`\n================ ${totalPassed}/${results.length} passed ================`);
if (totalPassed !== results.length) {
  process.exit(1);
}
process.exit(0);

