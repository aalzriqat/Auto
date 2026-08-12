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

/**
 * The blind spot the scan above declares: `t(SOME_MAP[value] ?? value)`.
 *
 * The cockpit routes every workflow enum through a lookup table, precisely so
 * the raw enum never reaches the screen. But the `t()` call site is then a
 * variable, so `LITERAL_T_CALL` cannot see it, and a member missing from the
 * dictionaries is invisible to every assertion above — it simply renders as the
 * key. `STATUS_LABEL.DRAFT` shipped that way: a draft application showed the
 * English word "Draft" on an otherwise fully Arabic page, which is the exact
 * defect the table exists to prevent.
 *
 * Scoped to this one file on purpose. A repo-wide sweep of `*_LABEL` maps has
 * false positives — `app/(dashboard)/[orgId]/leads/page.tsx`'s `STAGE_LABELS`
 * holds display text ("Test Drive"), not keys — and a test that cries wolf gets
 * deleted. Widen it by adding files here deliberately.
 *
 * The key type is deliberately NOT pinned to `Record<string, string>`: the
 * blocked-profit reasons are keyed by their union (`Record<"NoApproved…" | …,
 * string>`), so a scan written for the looser type covered five maps while its
 * own description claimed all of them — a gate overstating its reach, which is
 * the defect this whole file exists to prevent.
 *
 * Still NOT covered, and left alone deliberately: `t(`Blocker${stage.blocker}`)`
 * builds its key by interpolation rather than by lookup, so neither scan can see
 * it. Every member of `DealStageBlocker` resolves today. Closing that one means
 * exporting the union for the test to enumerate, which edits backend source for
 * a test's benefit — worth doing, not worth doing here.
 */
describe("cockpit label maps resolve through the dictionaries", () => {
  const COCKPIT = path.join("components", "applications", "cockpit", "DealCockpit.tsx");
  const source = fs.readFileSync(COCKPIT, "utf8");
  // `\s*` around the closing `>` because a union-keyed map is written across
  // several lines, so `string` and `>` are not adjacent.
  const maps = [
    ...source.matchAll(/const (\w+): Record<[\s\S]*?,\s*string\s*>\s*= \{([\s\S]*?)\n\};/g),
  ];
  // Quote style and the trailing comma are conventions nothing enforces — this
  // repo has an empty `.prettierrc`, `lint` is `eslint .`, and no workflow runs
  // a format check. A scan that only matched double quotes with a trailing
  // comma would drop entries silently and still report itself clean.
  const entries = maps.flatMap(([, name, body]) =>
    [...body.matchAll(/^\s*[\w"']+:\s*["']([^"']+)["'],?\s*$/gm)].map(([, key]) => ({ name, key }))
  );

  test("finds the maps to check", () => {
    // Without this the whole describe passes by matching nothing the moment the
    // declaration style changes. Floors, not exact counts, so adding a label is
    // not a failing test — but tight enough that losing a whole map is.
    expect(maps.length).toBeGreaterThanOrEqual(6);
    expect(entries.length).toBeGreaterThanOrEqual(34);
  });

  test("every mapped key exists in both dictionaries", () => {
    const missing = entries
      .filter(({ key }) => !(key in dictionaries.en) || !(key in dictionaries.ar))
      .map(({ name, key }) => `${name} -> ${key}`);
    expect(missing).toEqual([]);
  });
});

/**
 * Keys that reach `t()` through a variable, not a literal.
 *
 * `computeApprovalGate` returns key STRINGS which the panel passes to `t()`, so
 * the call sites contain no literal key and static scanning cannot see them. A
 * rename in one dictionary would ship an untranslated string to exactly the
 * screen that unblocks an organization's general ledger. CodeRabbit caught this
 * as a direct consequence of the round-4 gate redesign.
 */
describe("dynamically-referenced i18n keys", () => {
  const gateKeys = [
    "OpeningBalanceUnbalanced",
    "OpeningBalanceCurrencyUnknown",
    "OpeningBalanceRejectAndResubmit",
    "OpeningBalanceOwnDraftNeedsAnotherReviewer",
    "OpeningBalanceSegregationOfDutiesNotice",
    "OpeningBalancePreparerUnknown",
    "OpeningBalanceRawMinorUnitsNote",
  ] as const;

  test("every key computeApprovalGate can return exists in both dictionaries", () => {
    for (const key of gateKeys) {
      expect(dictionaries.en[key as keyof typeof dictionaries.en], `missing EN: ${key}`).toBeTruthy();
      expect(dictionaries.ar[key as keyof typeof dictionaries.ar], `missing AR: ${key}`).toBeTruthy();
    }
  });

  test("the list above matches what the gate can actually return", async () => {
    // Guards the guard: if a future branch returns a new key and nobody adds it
    // above, this fails rather than silently narrowing the coverage.
    const { computeApprovalGate } = await import(
      "@/components/accounting/setup/OpeningBalanceApprovalPanel"
    );
    const produced = new Set<string>();
    for (const isOwnDraft of [true, false]) {
      for (const busy of [true, false]) {
        for (const balanced of [true, false]) {
          for (const denominationKnown of [true, false]) {
            const gate = computeApprovalGate({ isOwnDraft, busy, balanced, denominationKnown });
            if (gate.recoveryKey) produced.add(gate.recoveryKey);
            gate.blockingFacts.forEach((f) => produced.add(f.key));
          }
        }
      }
    }
    for (const key of produced) {
      expect(gateKeys as readonly string[], `gate returns unlisted key: ${key}`).toContain(key);
    }
  });
});
