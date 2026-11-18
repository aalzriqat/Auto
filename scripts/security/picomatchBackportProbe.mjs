// Runs in a separately bounded process: a blocked regexp cannot time itself out.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function runControls(pm) {
  const input = "a".repeat(60000) + "/";
  const patterns = [
    "+(*a)",
    "*(*a)",
    "+(*)b",
    "+(a*)b",
    "+(@(*a))",
    "+(@(*)a)",
    "+(*a|b)",
    "+(*a|b)b",
    "*(*a|b)b",
    "+(a*a*a*a*a*)",
    "*(a*|b)z",
    "+(a*|b)z",
  ];
  let measured = 0;
  for (const options of [
    {},
    { dot: true },
    { windows: true },
    { bash: true },
    { capture: true },
  ]) {
    for (const pattern of patterns) {
      assert.equal(pm(pattern, options)(input), false);
      measured++;
    }
  }
  for (const options of [{ nocase: true }, { flags: "i" }]) {
    for (const pattern of ["+(A*|a)", "*(A*|a)"]) {
      assert.equal(pm(pattern, options)(input), false);
      measured++;
    }
  }
  for (const options of [{}, { nobracket: true }]) {
    assert.equal(pm("+([*a)", options)("[a".repeat(10000) + "!"), false);
    assert.equal(pm("+([*a])", options)("[a]".repeat(10000) + "!"), false);
    measured += 2;
  }
  for (const pattern of ["+(W*, *)z", "*(W*, *)z"]) {
    assert.equal(pm(pattern)("W, ".repeat(10000) + "!"), false);
    measured++;
  }
  // Positive controls prevent a matcher that rejects everything from passing.
  for (const [pattern, value] of [
    ["*.js", "index.js"],
    ["*(a*|b)", "ax"],
    ["+(a*|b)", "bbab"],
    ["+(ab*|c)", "ccabcc"],
    ["*/*(W*, *)*", "my/folder (Work, Accts)"],
    ["+(W*, *)", "W, W, "],
    ["+(*a)", "aaa"],
    ["+(a*b)", "abab"],
  ]) {
    assert.equal(pm(pattern)(value), true);
    measured++;
  }
  assert.equal(measured, 78);
  return measured;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const require = createRequire(import.meta.url);
  process.stdout.write(
    JSON.stringify({ measured: runControls(require(process.argv[2])) }),
  );
}
