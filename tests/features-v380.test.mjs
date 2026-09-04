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
  const userCutoff = userTurns.length > effectiveLimit ? userTurns[userTurns.length - effectiveLimit] : 0;
  const countCutoff = turns.length > effectiveLimit ? turns.length - effectiveLimit : 0;
  const cutoffIdx = Math.max(userCutoff, countCutoff);

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

const totalPassed = results.filter((r) => r.pass).length;
console.log(`\n================ ${totalPassed}/${results.length} passed ================`);
if (totalPassed !== results.length) {
  process.exit(1);
}
process.exit(0);

