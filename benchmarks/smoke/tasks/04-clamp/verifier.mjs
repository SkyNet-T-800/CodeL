import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const moduleUrl = `${pathToFileURL(resolve("src/clamp.mjs")).href}?verify=1`;
const { clamp } = await import(moduleUrl);
assert.equal(clamp(-1, 0, 10), 0);
assert.equal(clamp(4, 0, 10), 4);
assert.equal(clamp(12, 0, 10), 10);
assert.throws(() => clamp(1, 5, 2), RangeError);
console.log("clamp handles ranges and invalid bounds");
