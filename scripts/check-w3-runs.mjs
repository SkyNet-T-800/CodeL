import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { validateRunDirectory } from "../packages/harness/dist/index.js";

const runsRoot = resolve(process.argv[2] ?? "runs");
const entries = (await readdir(runsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name));

let valid = 0;
let completed = 0;
for (const entry of entries) {
  const result = await validateRunDirectory(resolve(runsRoot, entry.name));
  if (!result.valid) {
    console.error(`${entry.name}: invalid`);
    for (const issue of result.issues) {
      console.error(`  ${issue.path}: ${issue.message}`);
    }
    continue;
  }
  valid += 1;
  if (result.runMeta?.outcome.terminalReason === "verified") {
    completed += 1;
  }
  console.log(`${entry.name}: valid (${result.runMeta?.outcome.terminalReason})`);
}

console.log(
  JSON.stringify(
    {
      attempted: entries.length,
      validEvidenceBundles: valid,
      verified: completed,
      failed: entries.length - completed
    },
    null,
    2
  )
);

process.exitCode = valid === entries.length && entries.length > 0 ? 0 : 1;
