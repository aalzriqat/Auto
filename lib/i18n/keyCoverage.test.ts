import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { dictionaries } from "./dictionaries";

/**
 * `useLanguage().t` is typed as `keyof typeof dictionaries.en | (string & {})`.
 * That union deliberately accepts any string, so the compiler cannot catch a
 * typo or a key nobody ever added — and `t` returns the key itself when it
 * can't resolve one, so the mistake ships as raw text in the UI. Three had
 * already reached production that way: "ExportPDF" rendered as a button label
 * on the VAT return report, and "MessagesExpand"/"MessagesMinimize" as the
 * floating chat window's aria-labels (i.e. read aloud verbatim by a screen
 * reader, in both languages).
 *
 * Narrowing the `t` signature is the real fix, but it requires updating every
 * component that declares `t: (key: string) => string` and giving the handful
 * of genuinely dynamic lookups an explicit escape hatch. Until that lands,
 * this test provides the same protection from the outside.
 */

const SCAN_ROOTS = ["app", "components", "hooks"];
const LITERAL_T_CALL = /\bt\(\s*"([^"]+)"\s*\)/g;

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|\.next|_generated/.test(full)) collectSourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Only literal `t("Key")` calls are checkable; dynamic keys are skipped by design. */
function collectLiteralKeys(): Map<string, string> {
  const usages = new Map<string, string>();
  for (const file of SCAN_ROOTS.flatMap((root) => collectSourceFiles(root))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(LITERAL_T_CALL)) {
      const key = match[1];
      if (!usages.has(key)) {
        const line = source.slice(0, match.index).split("\n").length;
        usages.set(key, `${file}:${line}`);
      }
    }
  }
  return usages;
}

describe("i18n key coverage", () => {
  const usages = collectLiteralKeys();

  test("finds translation usages to check", () => {
    // Guards against the scan silently matching nothing (e.g. after a refactor
    // moves components), which would make the assertions below vacuous.
    expect(usages.size).toBeGreaterThan(100);
  });

  test("every literal t() key exists in the English dictionary", () => {
    const missing = [...usages.entries()]
      .filter(([key]) => !(key in dictionaries.en))
      .map(([key, where]) => `${key} (${where})`);
    expect(missing).toEqual([]);
  });

  test("every literal t() key exists in the Arabic dictionary", () => {
    // A key present only in English renders English text inside an otherwise
    // Arabic, RTL screen.
    const missing = [...usages.entries()]
      .filter(([key]) => !(key in dictionaries.ar))
      .map(([key, where]) => `${key} (${where})`);
    expect(missing).toEqual([]);
  });
});
