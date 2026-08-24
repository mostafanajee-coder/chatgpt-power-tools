/**
 * Export pipeline: structured DOM extraction, markdown fidelity,
 * full-conversation collection and the continuation prompt.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentSrc = fs.readFileSync(path.join(REPO, "src/content/index.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(REPO, "src/page/mainWorld.js"), "utf8");

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

/** Extract a function source, skipping a destructured parameter list. */
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

/* ---------------- minimal DOM good enough for the extractor -------------- */

function el(tag, opts = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs: opts.attrs || {},
    childNodes: [],
    _text: "",
    get children() { return node.childNodes.filter((c) => c.nodeType === 1); },
    getAttribute(k) { return node.attrs[k] ?? null; },
    matches(sel) {
      return sel.split(",").some((raw) => {
        const s = raw.trim();
        if (/^[a-z]+$/.test(s)) return node.tagName === s.toUpperCase();
        const m = /^\[([^\]=]+)(?:=("?)([^"\]]*)\2)?\]$/.exec(s);
        if (m) {
          const v = node.attrs[m[1]];
          if (v === undefined) return false;
          return m[3] === undefined || String(v) === m[3];
        }
        if (s.startsWith(".")) return (node.attrs.class || "").split(/\s+/).includes(s.slice(1));
        return false;
      });
    },
    querySelector(sel) {
      const stack = [...node.childNodes];
      while (stack.length) {
        const n = stack.shift();
        if (n.nodeType === 1) {
          if (n.matches(sel)) return n;
          stack.push(...n.childNodes);
        }
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => n.childNodes.forEach((c) => {
        if (c.nodeType === 1) { if (c.matches(sel)) out.push(c); walk(c); }
      });
      walk(node);
      return out;
    },
    get textContent() {
      let t = node._text;
      node.childNodes.forEach((c) => { t += c.nodeType === 3 ? c.nodeValue : c.textContent; });
      return t;
    },
    get innerText() { return node.textContent; }
  };
  if (opts.text) node.childNodes.push({ nodeType: 3, nodeValue: opts.text });
  (opts.children || []).forEach((c) => node.childNodes.push(c));
  return node;
}
const txt = (t) => ({ nodeType: 3, nodeValue: t });

function makeExtractor() {
  const ctx = { console, Array, String, Number, Math, JSON };
  vm.createContext(ctx);
  vm.runInContext([
    contentSrc.slice(contentSrc.indexOf("const EXPORT_SKIP ="), contentSrc.indexOf("function isSkippable")),
    grab("isSkippable", contentSrc),
    grab("inlineMarkdown", contentSrc),
    grab("tableToBlock", contentSrc),
    grab("domToBlocks", contentSrc),
    grab("blocksToMarkdown", contentSrc),
    grab("buildContinuationPrompt", contentSrc),
    grab("conversationToMarkdown", contentSrc).replace(/new Date\(\)\.toLocaleString\(\)/g, '"DATE"'),
    "globalThis.api = { domToBlocks, blocksToMarkdown, buildContinuationPrompt, conversationToMarkdown };"
  ].join("\n"), ctx);
  return ctx.api;
}

const api = makeExtractor();

console.log("--- structured extraction ---");

// A rendered ChatGPT answer: code block with a language label + copy button,
// a paragraph with a link, a list, and a table.
const answer = el("div", { children: [
  el("p", { children: [
    txt("Use "),
    el("code", { text: "map()" }),
    txt(" — see "),
    el("a", { attrs: { href: "https://example.com/docs" }, text: "the docs" }),
    txt(".")
  ] }),
  el("pre", { children: [
    el("div", { children: [el("span", { text: "python" }), el("button", { text: "Copy" })] }),
    el("code", { attrs: { class: "language-python" }, text: "def add(a, b):\n    return a + b" })
  ] }),
  el("ul", { children: [el("li", { text: "first" }), el("li", { text: "second" })] }),
  el("table", { children: [
    el("tr", { children: [el("th", { text: "Name" }), el("th", { text: "Value" })] }),
    el("tr", { children: [el("td", { text: "x" }), el("td", { text: "1" })] })
  ] })
] });

const blocks = api.domToBlocks(answer);
const md = api.blocksToMarkdown(blocks);

check("code block detected as code", blocks.some((b) => b.type === "code"));
check("code language captured",
  blocks.find((b) => b.type === "code")?.lang === "python",
  blocks.find((b) => b.type === "code")?.lang);
check("code text is exactly the code (no Copy button, no language label)",
  blocks.find((b) => b.type === "code").text === "def add(a, b):\n    return a + b",
  JSON.stringify(blocks.find((b) => b.type === "code").text));
check("markdown emits real ``` fences", /```python\n/.test(md) && /```\s*$/m.test(md), md.slice(0, 60));
check("link keeps its URL", /\[the docs\]\(https:\/\/example\.com\/docs\)/.test(md));
check("inline code preserved", /`map\(\)`/.test(md));
check("list preserved", /- first\n- second/.test(md));
check("table preserved as markdown", /\| Name \| Value \|/.test(md) && /\| --- \| --- \|/.test(md));
check("UI chrome never leaks into output", !/Copy/.test(md), md);

// The whole point: the .docx code path keys off ``` fences.
const ctx2 = { String, Array, console };
vm.createContext(ctx2);
vm.runInContext(grab("splitCodeSegments", contentSrc) + "\nglobalThis.split = splitCodeSegments;", ctx2);
const segs = ctx2.split(md);
check("docx monospace path now actually triggers",
  segs.filter((s) => s.code).length === 1, `${segs.filter((s) => s.code).length} code segments`);

// User prompts are plain text with no structure.
const prompt = el("div", { text: "just a plain question" });
check("plain user prompt still extracted",
  api.blocksToMarkdown(api.domToBlocks(prompt)) === "just a plain question");

console.log("\n--- continuation prompt ---");

const convo = [];
for (let i = 1; i <= 25; i++) {
  convo.push({ role: "User", text: `question ${i}` });
  convo.push({ role: "ChatGPT", text: `answer ${i}` });
}
const cont = api.buildContinuationPrompt("My Long Chat", convo, 10);
check("keeps exactly the last 10 turns", (cont.match(/### User:/g) || []).length === 10,
  `${(cont.match(/### User:/g) || []).length}`);
check("starts at the right turn", cont.includes("question 16") && !cont.includes("question 15"));
check("ends at the final turn", cont.includes("answer 25"));
check("tells the model to continue, not restart", /do not restart/i.test(cont));
check("names the source conversation", cont.includes("My Long Chat"));

const contShort = api.buildContinuationPrompt("Short", convo.slice(0, 4), 10);
check("asking for more turns than exist does not break",
  (contShort.match(/### User:/g) || []).length === 2);

console.log("\n--- full conversation markdown ---");

const full = api.conversationToMarkdown("My Long Chat", convo, { complete: true });
check("full export contains every message", (full.match(/### /g) || []).length === 50);
check("full export headed with the title", full.startsWith("# My Long Chat"));

const partial = api.conversationToMarkdown("My Long Chat", convo, { complete: false, failureReason: "http-429" });
check("incomplete export says so in the file itself", /INCOMPLETE: http-429/.test(partial));

console.log("\n--- API message mapping (mainWorld) ---");

const ctx3 = { console, Array, String };
vm.createContext(ctx3);
vm.runInContext(grab("apiMessagesToExport", mainSrc) + "\nglobalThis.map = apiMessagesToExport;", ctx3);

const apiMsgs = [
  { author: { role: "system" }, content: { parts: ["hidden system"] } },
  { author: { role: "user" }, content: { parts: ["hello"] } },
  { author: { role: "assistant" }, content: { parts: ["hi ```js\ncode()\n```"] } },
  { author: { role: "tool" }, content: { parts: ["tool output"] } },
  { author: { role: "assistant" }, content: { parts: [""] } },
  { author: { role: "assistant" }, metadata: { is_visually_hidden_from_conversation: true }, content: { parts: ["hidden"] } },
  { author: { role: "user" }, content: { parts: [{ image: "x" }] } }
];
const mapped = ctx3.map(apiMsgs);
check("system/tool records excluded", !mapped.some((m) => /system|tool output/.test(m.text)));
check("hidden records excluded", !mapped.some((m) => m.text === "hidden"));
check("empty parts excluded", !mapped.some((m) => m.text === ""));
check("non-string parts excluded safely", mapped.length === 2, `${mapped.length}`);
check("roles mapped to export labels",
  mapped[0].role === "User" && mapped[1].role === "ChatGPT",
  mapped.map((m) => m.role).join(","));
check("API markdown arrives with fences intact", /```js/.test(mapped[1].text));

const failed = results.filter((r) => !r.pass);
console.log(`\n================ ${results.length - failed.length}/${results.length} passed ================`);
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name} ${f.detail || ""}`);
  process.exitCode = 1;
}
