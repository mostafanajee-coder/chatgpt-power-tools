/**
 * TurboGPT test runner.
 *
 *   node tests/run.mjs
 *
 * Zero dependencies, no build step. Each suite loads the REAL extension
 * source and exercises it inside node:vm with stubbed browser globals.
 * Exits non-zero if any assertion fails.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ["Counting path (mainWorld.js)", "count.test.mjs"],
  ["Stats flow + export button", "stats-flow.test.mjs"],
  ["Export pipeline (extraction, full export, continuation)", "export.test.mjs"],
  ["v3.8.0 Features (DOM Limit, Backup, Full Search)", "features-v380.test.mjs"]
];

let failed = 0;

for (const [label, file] of SUITES) {
  console.log(`\n########  ${label}  ########`);
  const res = spawnSync(process.execPath, [path.join(HERE, file)], { stdio: "inherit" });
  if (res.status !== 0) failed++;
}

console.log(
  failed === 0
    ? "\n✅ All suites passed."
    : `\n❌ ${failed} suite(s) failed.`
);
process.exit(failed === 0 ? 0 : 1);
