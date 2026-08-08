import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const moduleUrl = `${pathToFileURL(resolve("src/async-cache.mjs")).href}?verify=1`;
const { createAsyncCache } = await import(moduleUrl);

let calls = 0;
const cache = createAsyncCache(async (key) => {
  calls += 1;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  return key.toUpperCase();
});
assert.deepEqual(await Promise.all([cache.get("a"), cache.get("a")]), ["A", "A"]);
assert.equal(calls, 1);

let attempts = 0;
const retrying = createAsyncCache(async () => {
  attempts += 1;
  if (attempts === 1) throw new Error("transient");
  return "ok";
});
await assert.rejects(retrying.get("x"), /transient/);
assert.equal(await retrying.get("x"), "ok");
assert.equal(attempts, 2);
console.log("async cache shares loads and evicts failures");
