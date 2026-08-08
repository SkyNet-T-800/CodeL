import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const moduleUrl = `${pathToFileURL(resolve("src/calculator.mjs")).href}?verify=1`;
const { add } = await import(moduleUrl);
assert.equal(add(2, 3), 5);
assert.equal(add(-7, 2), -5);
assert.equal(add(0, 0), 0);
assert.equal(add(1_000_000, 2_000_000), 3_000_000);
console.log("add handles the smoke cases");
