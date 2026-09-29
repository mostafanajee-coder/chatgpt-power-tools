/**
 * ChatGPT current "app" DOM compatibility.
 *
 * The current renderer groups exchanges under [data-turn-key] and marks the
 * user bubble with [data-user-message-bubble]. This suite loads the real
 * turn-discovery and limiting functions and verifies Visible Messages = 1.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(REPO, "src/content/index.js"), "utf8");
const popupSrc = fs.readFileSync(path.join(REPO, "src/popup/popup.js"), "utf8");
const results = [];

function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  let i = src.indexOf("(", start);
  let parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") parens++;
    else if (src[i] === ")" && --parens === 0) break;
  }
  i = src.indexOf("{", i);
  let braces = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") braces++;
    else if (src[i] === "}" && --braces === 0) break;
  }
  return src.slice(start, i + 1);
}

const hidden = new Set();
const turns = Array.from({ length: 5 }, (_, i) => {
  const user = true;
  const classList = {
    add: (name) => hidden.add(turn.id + ":" + name),
    remove: (name) => hidden.delete(turn.id + ":" + name),
    contains: (name) => hidden.has(turn.id + ":" + name)
  };
  const turn = {
    id: `app-turn-${i + 1}`,
    parentElement: null,
    classList,
    style: {
      display: "",
      setProperty(_name, value) { this.display = value; },
      removeProperty(_name) { this.display = ""; }
    },
    getAttribute(name) {
      return name === "data-turn-key" ? `turn-${i + 1}` : null;
    },
    matches(selector) {
      return user && selector.includes("[data-user-message-bubble]");
    },
    querySelector(selector) {
      if (user && (selector.includes("[data-user-message-bubble]") || selector.includes('data-content-search-unit-key$=":user"'))) {
        return { getAttribute: () => null };
      }
      return null;
    },
    querySelectorAll() { return []; }
  };
  return turn;
});

const ctx = {
  CHATGPT_APP_TURN_SELECTOR: "[data-turn-key]",
  USER_MESSAGE_SELECTOR: '[data-message-author-role="user"], [data-user-message-bubble], [data-content-search-unit-key$=":user"]',
  ASSISTANT_MESSAGE_SELECTOR: '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"], [data-content-search-unit-key$=":assistant"]',
  document: {
    querySelectorAll(selector) {
      if (selector === "[data-turn-key]") return turns;
      if (selector === ".turbogpt-dom-hidden") return turns.filter((t) => t.classList.contains("turbogpt-dom-hidden"));
      return [];
    },
    querySelector() { return null; }
  },
  appSettings: { enabled: true, messageLimit: 1, liveAutoTrim: false },
  manuallyUnhiddenTurnsCount: 0,
  initialEnforcementDone: false,
  domHiddenCountCache: null,
  syncAppVirtualizerRails() {},
  updateOutlineBadge() {}
};

vm.createContext(ctx);
vm.runInContext([
  grab("isUserTurn"),
  grab("isAppTurn"),
  grab("getAllConversationTurns"),
  grab("getTurnItemContainer"),
  grab("hideAppTurn"),
  grab("invalidateHiddenCount"),
  grab("getDomHiddenCount"),
  grab("hideTurnEl"),
  grab("showTurnEl"),
  grab("enforceDomTurnLimit"),
  "globalThis.result = { getAllConversationTurns, isUserTurn, enforceDomTurnLimit };"
].join("\n"), ctx);

const discovered = ctx.result.getAllConversationTurns();
check("current app renderer: discovers data-turn-key containers", discovered.length === 5, `turns=${discovered.length}`);
check("current app renderer: identifies user bubbles", discovered.filter(ctx.result.isUserTurn).length === 5);

ctx.result.enforceDomTurnLimit({ force: true });
const hiddenCount = turns.filter((t) => t.classList.contains("turbogpt-dom-hidden")).length;
check("Visible Messages = 1: hides the four older app turns", hiddenCount === 4, `hidden=${hiddenCount}`);
check("Visible Messages = 1: keeps only the newest app turn visible",
  turns[4].classList.contains("turbogpt-dom-hidden") === false);

check("React-safe window: older app turns stay in React's DOM tree",
  src.includes("function hideAppTurn(turn)") &&
  src.includes("return hideTurnEl(container);") &&
  !src.includes("container.replaceWith(spacer);"));
check("React-safe window: virtualizer rail is resynchronized after hiding",
  src.includes("function syncAppVirtualizerRails()") &&
  src.includes("content.scrollHeight") &&
  src.includes("if (changed) syncAppVirtualizerRails();"));
check("local archive: live capture supports the current app message markers",
  src.includes("[data-turn-key] img") &&
  src.includes("getMessageIdFromElement(el)") &&
  src.includes("turn.matches?.(USER_MESSAGE_SELECTOR)"));

check("source keeps the new ChatGPT selectors centralized",
  src.includes("const CHATGPT_APP_TURN_SELECTOR = '[data-turn-key]';") &&
  src.includes("[data-user-message-bubble]") &&
  src.includes("[data-content-search-unit-key$=\":user\"]"));
check("Save & Apply syncs settings without forcing a page reload",
  !/refreshBtn[\s\S]{0,1800}chrome\.tabs\.reload/.test(popupSrc) &&
  popupSrc.includes("syncTabSettings(settings);"));

const passed = results.filter((r) => r.pass).length;
console.log(`\n================ ${passed}/${results.length} passed ================`);
process.exit(passed === results.length ? 0 : 1);
