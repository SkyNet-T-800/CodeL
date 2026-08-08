import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const moduleUrl = `${pathToFileURL(resolve("src/config.mjs")).href}?verify=1`;
const { courseWeek } = await import(moduleUrl);
assert.equal(courseWeek, 3);
console.log("courseWeek is 3");
