import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const moduleUrl = `${pathToFileURL(resolve("src/greeting.mjs")).href}?verify=1`;
const { greet } = await import(moduleUrl);
assert.equal(greet(" Ada "), "Hello, Ada!");
assert.equal(greet(""), "Hello, stranger!");
assert.equal(greet("   "), "Hello, stranger!");
console.log("greet normalizes names");
