import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const moduleUrl = `${pathToFileURL(resolve("src/greeting.mjs")).href}?verify=1`;
const { greetPoint } = await import(moduleUrl);
const actual = greetPoint(" Ada ", { x: 2, y: -4 });
const expected = "Ada: (2, -4)";
if (actual !== expected) {
  console.error(
    `greetPoint mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
  );
  process.exitCode = 1;
} else {
  console.log("cross-file point summary is correct");
}
