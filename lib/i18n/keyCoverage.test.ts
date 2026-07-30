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

/**
 * Matches `t("Key")` and `t("Key" as any)` alike.
 *
 * The optional cast is the whole point. `t`'s parameter is
 * `keyof typeof dictionaries.en | (string & {})`, and TypeScript resolves a
 * string literal against the `keyof` half first — so a key that is not in the
 * English dictionary is an error at the call site, and the codebase silences it
 * with `as any`. That is by far the common form: **2,462** call sites use the
 * cast against 704 plain ones.
 *
 * Requiring `"Key"` to be followed immediately by `)` therefore checked 22% of
 * the surface and reported the other 78% as clean. Which is how eight `sales.*`
 * keys shipped present in English and absent in Arabic, one of them
 * ("sales.ExceedsFinancingLimit") on a live validation message in the F&I flow,
 * while this file's own tests passed.
 *
 * The cast is also exactly the signal worth checking hardest: a call site that
 * had to silence the compiler to name a key is the one most likely to have named
 * a key that does not exist.
 */
const LITERAL_T_CALL = /\bt\(\s*"([^"]+)"(?:\s+as\s+\w+)?\s*\)/g;

/**
 * Pinned so a regex change cannot quietly shrink the checked surface again — the
 * exact failure this file is being fixed for. If a real change moves these,
 * update them in the same commit, deliberately.
 */
export const EXPECTED_SCAN_COVERAGE = { minimumKeys: 700, minimumCallSites: 3100 };

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
function collectLiteralKeys(): { usages: Map<string, string>; callSites: number } {
  const usages = new Map<string, string>();
  let callSites = 0;
  for (const file of SCAN_ROOTS.flatMap((root) => collectSourceFiles(root))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(LITERAL_T_CALL)) {
      const key = match[1];
      callSites++;
      if (!usages.has(key)) {
        const line = source.slice(0, match.index).split("\n").length;
        usages.set(key, `${file}:${line}`);
      }
    }
  }
  return { usages, callSites };
}

describe("i18n key coverage", () => {
  const { usages, callSites } = collectLiteralKeys();

  test("finds translation usages to check", () => {
    // Guards against the scan silently matching nothing (e.g. after a refactor
    // moves components), which would make the assertions below vacuous.
    expect(usages.size).toBeGreaterThan(100);
  });

  test("scans the whole t() surface, not the fraction that skips the cast", () => {
    // Floors rather than exact figures: labels are added constantly, and a test
    // that fails on every new one is a test people delete. They still fail hard
    // if the regex stops matching `as any`, which drops the call-site count by
    // roughly three quarters — the precise regression this file already shipped
    // once.
    expect(usages.size).toBeGreaterThanOrEqual(EXPECTED_SCAN_COVERAGE.minimumKeys);
    expect(callSites).toBeGreaterThanOrEqual(EXPECTED_SCAN_COVERAGE.minimumCallSites);
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
