/**
 * SCRUM-302 — STRUCTURAL RATCHET for the organization-lifecycle economic gate.
 *
 * The gate is enforced at the economic CHOKEPOINTS, not at the entry points,
 * and that choice rests on exactly one claim:
 *
 *   every ledger-core row in the repository is written behind
 *   `postAccountingEvent`, `reverseAccountingEvent`, the `subledger.ts`
 *   creators, the accounting outbox, or one of two authenticated-only mutations
 *
 * If that stops being true, the gate has a hole that LOOKS closed — every
 * existing test still passes while a new internal writer posts money for a
 * suspended organization. Prose cannot hold that line, so this does: a new
 * ledger-core insert outside the enumerated set fails CI, and whoever adds it
 * has to decide, deliberately, how lifecycle applies to it.
 *
 * Same posture and same reason as `scripts/tenantWriteGuard.test.ts`.
 *
 * ⚠️ THIS SCANS THE SOURCE DIRECTLY rather than trusting an index. During the
 * SCRUM-302 investigation a graph-index query over the identical pattern
 * returned 17 non-test sites where the source actually has 19 — it silently
 * omitted both `commitmentAuthority*` inserts. A completeness ratchet built on
 * a tool that can under-report is not a ratchet.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const CONVEX_DIR = join(__dirname, "..", "convex");

/**
 * The tables whose rows ARE the economic footprint of an organization — the set
 * the SCRUM-302 failing-first tests assert stays unchanged for a blocked org.
 */
const LEDGER_CORE_TABLES = [
  "accountingEvents",
  "pendingAccountingEvents",
  "journalEntries",
  "journalLines",
  "accountBalanceSnapshots",
  "canonicalPayments",
  "receivableDocuments",
  "paymentAllocations",
  "commitmentAuthorityWork",
  "commitmentAuthorityAttempt",
] as const;

/**
 * Files permitted to insert a ledger-core row, each with the reason it is
 * allowed to. A file is on this list because its writes are lifecycle-gated —
 * NOT merely because it happens to write today.
 */
const ALLOWED_WRITERS: Record<string, string> = {
  "accounting/postingEngine.ts":
    "the GL engine — calls assertOrgEconomicallyActive before the idempotency probe",
  "accounting/reversals.ts":
    "reversal writer, does not route through the engine — calls assertOrgEconomicallyActive first",
  "accounting/accountSnapshots.ts":
    "reached only from the two writers above, both already gated",
  "subledger.ts":
    "canonical payment / receivable / allocation creators — each calls assertOrgEconomicallyActive",
  "accountingOutbox.ts":
    "queue + authority dispatch — enqueue asserts, drainEntries classifies permanent vs temporary",
  "accountingCutover.ts":
    "approveOpeningBalance, a public mutation behind requireTenantAuth, which already refuses a suspended org",
  "financialAudit.ts":
    "approveManualJournal, a public mutation behind requireTenantAuth, which already refuses a suspended org",
};

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "_generated" || entry === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

interface WriteSite {
  file: string;
  line: number;
  table: string;
}

function findLedgerCoreWriteSites(): WriteSite[] {
  const sites: WriteSite[] = [];
  for (const full of collectSourceFiles(CONVEX_DIR)) {
    const rel = relative(CONVEX_DIR, full).split(sep).join("/");
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((text, idx) => {
      for (const table of LEDGER_CORE_TABLES) {
        // Both quote styles, and any whitespace the formatter may introduce
        // between `insert(` and the table name.
        if (new RegExp(`\\.insert\\(\\s*["']${table}["']`).test(text)) {
          sites.push({ file: rel, line: idx + 1, table });
        }
      }
    });
  }
  return sites;
}

describe("SCRUM-302 — ledger-core writes stay behind the lifecycle-gated chokepoints", () => {
  test("no ledger-core insert exists outside the enumerated writers", () => {
    const offenders = findLedgerCoreWriteSites().filter(
      (s) => !(s.file in ALLOWED_WRITERS)
    );

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : "A ledger-core row is inserted from a file that is not a lifecycle-gated " +
            "chokepoint:\n" +
            offenders.map((o) => `  ${o.file}:${o.line} inserts ${o.table}`).join("\n") +
            "\n\nSCRUM-302 gates organization lifecycle (suspension, irreversible " +
            "destructive purge) at the chokepoints, so that an internal, cron or " +
            "webhook caller cannot create economic state for an organization the " +
            "authenticated door would refuse. A new writer here bypasses that " +
            "silently.\n\nEither route the write through an existing gated " +
            "chokepoint, or gate the new one with `assertOrgEconomicallyActive` / " +
            "`orgEconomicLifecycleBlock` and add it to ALLOWED_WRITERS with the " +
            "reason it is safe."
    ).toEqual([]);
  });

  test("every enumerated writer still writes — a stale allowlist entry is a rotted claim", () => {
    const writingFiles = new Set(findLedgerCoreWriteSites().map((s) => s.file));
    const stale = Object.keys(ALLOWED_WRITERS).filter((f) => !writingFiles.has(f));

    // An entry that no longer writes anything is not harmless: it documents a
    // gate for code that has moved, and the next reader trusts it.
    expect(stale).toEqual([]);
  });

  test("both lifecycle helpers are actually applied at the internal chokepoints", () => {
    // The allowlist above records an INTENT. This asserts the intent is real
    // for the five files whose writes are reachable without authentication —
    // the two authenticated-only mutations are covered by requireTenantAuth
    // instead and deliberately are not required to call these helpers.
    const mustGate = [
      "accounting/postingEngine.ts",
      "accounting/reversals.ts",
      "subledger.ts",
      "accountingOutbox.ts",
    ];

    const ungated = mustGate.filter((rel) => {
      const source = readFileSync(join(CONVEX_DIR, rel), "utf8");
      return (
        !source.includes("assertOrgEconomicallyActive") &&
        !source.includes("orgEconomicLifecycleBlock")
      );
    });

    expect(ungated).toEqual([]);
  });
});
