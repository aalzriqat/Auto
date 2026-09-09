/**
 * SCRUM-302 — STRUCTURAL RATCHET for the organization-lifecycle economic gate.
 *
 * The gate is enforced at the economic CHOKEPOINTS, not at the entry points,
 * and that choice rests on exactly one claim:
 *
 *   every ledger-core row in the repository is written by one of an enumerated
 *   set of CALL SITES, and every one of those call sites is lifecycle-gated —
 *   either in its own function, or by every caller that can reach it
 *
 * If that stops being true, the gate has a hole that LOOKS closed — every
 * existing test still passes while a new internal writer posts money for a
 * suspended organization. Prose cannot hold that line, so this does.
 *
 * Same posture and same reason as `scripts/tenantWriteGuard.test.ts`.
 *
 * ⚠️ THIS SCANS THE SOURCE DIRECTLY rather than trusting an index. During the
 * SCRUM-302 investigation a graph-index query over the identical pattern
 * returned 17 non-test sites where the source actually has 19 — it silently
 * omitted both `commitmentAuthority*` inserts, which are the fourth economic
 * cron's path. A completeness ratchet built on a tool that can under-report is
 * not a ratchet.
 *
 * ⚠️ AND IT IS CALL-SITE GRANULAR, NOT FILE GRANULAR — THAT WAS R3.
 *
 * The first version of this file keyed on FILENAME: an allowlist of seven
 * files, plus a test that grepped each whole file for the string
 * `assertOrgEconomicallyActive`. Both checks passed for a brand-new, entirely
 * ungated `ctx.db.insert("journalEntries", …)` dropped into any allowlisted
 * file, because some OTHER function in that same file mentioned the helper.
 * The ratchet carried the exact defect class it exists to prevent, and the
 * SCRUM-302 review seat proved it by construction rather than by argument.
 *
 * So the unit of enumeration is now the SITE — `(file, table, enclosing
 * function)` — and the registry below is compared for EXACT equality against a
 * fresh scan. A new insert fails the ratchet even inside an already-approved
 * file, even in an already-approved function, and even for an already-approved
 * table. The fix is never to widen a filename list; it is to classify the new
 * writer and prove its gate.
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

/** The tokens that constitute a lifecycle gate at a chokepoint. */
const LIFECYCLE_GATES = ["assertOrgEconomicallyActive", "orgEconomicLifecycleBlock"] as const;

/**
 * How a given call site is prevented from writing for a blocked organization.
 *
 * GATED_IN_FUNCTION — the enclosing function itself invokes a lifecycle gate.
 *   Verified textually, within that function's braces.
 *
 * GATED_BY_CALLER — the enclosing function is a helper that never derives its
 *   own authority, so the gate lives in every function that can reach it. Each
 *   such caller is named, and each is itself verified to carry a lifecycle gate
 *   or `requireTenantAuth`. An unnamed new caller does NOT silently inherit
 *   this classification — it changes the call graph, and the reviewer of that
 *   change has to come back here.
 */
type GateKind = "GATED_IN_FUNCTION" | "GATED_BY_CALLER";

interface ClassifiedWriteSite {
  /** Path relative to `convex/`. */
  file: string;
  table: (typeof LEDGER_CORE_TABLES)[number];
  /** The enclosing top-level declaration. */
  fn: string;
  gate: GateKind;
  /** For GATED_BY_CALLER only: every non-test caller, as `file#fn`. */
  via?: string[];
  why: string;
}

/**
 * THE 19 LEDGER-CORE WRITE SITES, and the gate each one actually has.
 *
 * Re-measured by direct source scan on this branch. Per table: accountingEvents
 * 2 · pendingAccountingEvents 2 · journalEntries 4 · journalLines 4 ·
 * accountBalanceSnapshots 1 · canonicalPayments 1 · receivableDocuments 1 ·
 * paymentAllocations 2 · commitmentAuthorityWork 1 · commitmentAuthorityAttempt
 * 1 = 19, across 7 files.
 */
const CLASSIFIED_WRITE_SITES: ClassifiedWriteSite[] = [
  {
    file: "accounting/postingEngine.ts",
    table: "accountingEvents",
    fn: "postAccountingEvent",
    gate: "GATED_IN_FUNCTION",
    why: "the GL engine — gates before the idempotency probe, so a blocked org cannot even claim a key",
  },
  {
    file: "accounting/postingEngine.ts",
    table: "journalEntries",
    fn: "postAccountingEvent",
    gate: "GATED_IN_FUNCTION",
    why: "same transaction as the event above",
  },
  {
    file: "accounting/postingEngine.ts",
    table: "journalLines",
    fn: "postAccountingEvent",
    gate: "GATED_IN_FUNCTION",
    why: "same transaction as the event above",
  },
  {
    file: "accounting/reversals.ts",
    table: "accountingEvents",
    fn: "reverseAccountingEvent",
    gate: "GATED_IN_FUNCTION",
    why: "the reversal writer deliberately does NOT route through the engine, so it carries its own gate",
  },
  {
    file: "accounting/reversals.ts",
    table: "journalEntries",
    fn: "reverseAccountingEvent",
    gate: "GATED_IN_FUNCTION",
    why: "same transaction as the reversing event above",
  },
  {
    file: "accounting/reversals.ts",
    table: "journalLines",
    fn: "reverseAccountingEvent",
    gate: "GATED_IN_FUNCTION",
    why: "same transaction as the reversing event above",
  },
  {
    file: "accounting/accountSnapshots.ts",
    table: "accountBalanceSnapshots",
    fn: "incrementAccountSnapshot",
    gate: "GATED_BY_CALLER",
    via: [
      "accounting/postingEngine.ts#postAccountingEvent",
      "accounting/reversals.ts#reverseAccountingEvent",
      "accountingCutover.ts#postOpeningBalanceDraft",
      "financialAudit.ts#approveManualJournal",
    ],
    why: "a pure balance-roll helper that never derives authority; every non-test caller is gated or authenticated",
  },
  {
    file: "subledger.ts",
    table: "receivableDocuments",
    fn: "createReceivableDocument",
    gate: "GATED_IN_FUNCTION",
    why: "canonical receivable creator",
  },
  {
    file: "subledger.ts",
    table: "canonicalPayments",
    fn: "createCanonicalPayment",
    gate: "GATED_IN_FUNCTION",
    why: "the exact writer the payment webhook reaches — the originally reported defect",
  },
  {
    file: "subledger.ts",
    table: "paymentAllocations",
    fn: "allocatePaymentToReceivable",
    gate: "GATED_IN_FUNCTION",
    why: "canonical allocation creator",
  },
  {
    file: "subledger.ts",
    table: "paymentAllocations",
    fn: "reverseAllocation",
    gate: "GATED_IN_FUNCTION",
    why: "allocation reversal writes a compensating allocation row of its own",
  },
  {
    file: "accountingOutbox.ts",
    table: "pendingAccountingEvents",
    fn: "enqueuePendingPost",
    gate: "GATED_IN_FUNCTION",
    why: "queueing money work for a blocked org is itself an economic write",
  },
  {
    file: "accountingOutbox.ts",
    table: "pendingAccountingEvents",
    fn: "enqueuePendingReversal",
    gate: "GATED_IN_FUNCTION",
    why: "as above, for the reversal queue",
  },
  {
    file: "accountingOutbox.ts",
    table: "commitmentAuthorityWork",
    fn: "recordAuthorityWork",
    gate: "GATED_IN_FUNCTION",
    why: "queued authority work — one of the two sites a graph index silently dropped",
  },
  {
    file: "accountingOutbox.ts",
    table: "commitmentAuthorityAttempt",
    fn: "dispatchAuthorityWorkItem",
    gate: "GATED_IN_FUNCTION",
    why: "the fourth economic cron's per-item dispatcher; refuses before minting an attempt or spending budget",
  },
  {
    file: "accountingCutover.ts",
    table: "journalEntries",
    fn: "postOpeningBalanceDraft",
    gate: "GATED_BY_CALLER",
    via: ["accountingCutover.ts#approveOpeningBalance"],
    why: "a draft-posting helper; its only caller is a public mutation behind requireTenantAuth, which already refuses a suspended org",
  },
  {
    file: "accountingCutover.ts",
    table: "journalLines",
    fn: "postOpeningBalanceDraft",
    gate: "GATED_BY_CALLER",
    via: ["accountingCutover.ts#approveOpeningBalance"],
    why: "same transaction as the opening-balance entry above",
  },
  {
    file: "financialAudit.ts",
    table: "journalEntries",
    fn: "approveManualJournal",
    gate: "GATED_BY_CALLER",
    via: ["financialAudit.ts#approveManualJournal"],
    why: "a public mutation whose own body calls requireTenantAuth, which already refuses a suspended org",
  },
  {
    file: "financialAudit.ts",
    table: "journalLines",
    fn: "approveManualJournal",
    gate: "GATED_BY_CALLER",
    via: ["financialAudit.ts#approveManualJournal"],
    why: "same transaction as the manual journal entry above",
  },
];

const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/;

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
  fn: string;
}

/**
 * Every ledger-core insert in `convex/`, with the top-level declaration that
 * encloses it.
 */
function findLedgerCoreWriteSites(): WriteSite[] {
  const sites: WriteSite[] = [];
  for (const full of collectSourceFiles(CONVEX_DIR)) {
    const rel = relative(CONVEX_DIR, full).split(sep).join("/");
    const lines = readFileSync(full, "utf8").split("\n");
    let fn = "<module>";
    lines.forEach((text, idx) => {
      const decl = text.match(DECLARATION);
      if (decl) fn = decl[1] ?? decl[2]!;
      for (const table of LEDGER_CORE_TABLES) {
        // Both quote styles, and any whitespace the formatter may introduce
        // between `insert(` and the table name.
        if (new RegExp(`\\.insert\\(\\s*["']${table}["']`).test(text)) {
          sites.push({ file: rel, line: idx + 1, table, fn });
        }
      }
    });
  }
  return sites;
}

/**
 * The source text of one top-level declaration, by brace balance.
 *
 * Deliberately NOT the whole file — reading the whole file for a gate token is
 * precisely the R3 defect this rewrite exists to remove.
 */
function functionSource(file: string, fn: string): string | null {
  const lines = readFileSync(join(CONVEX_DIR, file), "utf8").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const decl = lines[i]!.match(DECLARATION);
    if (decl && (decl[1] ?? decl[2]) === fn) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  let depth = 0;
  let opened = false;
  const collected: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const text = lines[i]!;
    collected.push(text);
    for (const ch of text) {
      if (ch === "{" || ch === "(") {
        depth++;
        opened = true;
      } else if (ch === "}" || ch === ")") {
        depth--;
      }
    }
    if (opened && depth <= 0) break;
  }
  return collected.join("\n");
}

function siteKey(s: { file: string; table: string; fn: string }): string {
  return `${s.file}#${s.fn} inserts ${s.table}`;
}

describe("SCRUM-302 — ledger-core writes stay behind the lifecycle-gated chokepoints", () => {
  test("the set of ledger-core write SITES is exactly the classified set", () => {
    // Multiset equality, sorted. A new insert changes this set even when its
    // file, its function and its table are all already approved — which is the
    // whole point of R3.
    const found = findLedgerCoreWriteSites().map(siteKey).sort();
    const classified = CLASSIFIED_WRITE_SITES.map(siteKey).sort();

    const added = found.filter((k) => !classified.includes(k));
    const removed = classified.filter((k) => !found.includes(k));

    expect(
      { added, removed },
      added.length === 0 && removed.length === 0
        ? ""
        : "The ledger-core write surface changed.\n\n" +
            (added.length
              ? "NEW, UNCLASSIFIED write sites:\n" +
                added.map((k) => `  ${k}`).join("\n") +
                "\n\nSCRUM-302 gates organization lifecycle (suspension, irreversible " +
                "destructive purge) at the economic chokepoints, so that an internal, " +
                "cron or webhook caller cannot create economic state for an " +
                "organization the authenticated door would refuse.\n\n" +
                "⚠️ DO NOT SATISFY THIS BY ADDING A FILENAME. Classify the exact " +
                "writer: either call `assertOrgEconomicallyActive` in its own " +
                "function and register it as GATED_IN_FUNCTION, or register it as " +
                "GATED_BY_CALLER naming every caller that can reach it.\n"
              : "") +
            (removed.length
              ? "\nClassified sites that no longer exist (a rotted claim — the next " +
                "reader trusts this registry):\n" +
                removed.map((k) => `  ${k}`).join("\n")
              : "")
    ).toEqual({ added: [], removed: [] });
  });

  test("every GATED_IN_FUNCTION site really gates inside its own function", () => {
    const ungated = CLASSIFIED_WRITE_SITES.filter((s) => s.gate === "GATED_IN_FUNCTION").filter(
      (s) => {
        const source = functionSource(s.file, s.fn);
        // A function the extractor cannot find is a failure, not a pass.
        if (source === null) return true;
        return !LIFECYCLE_GATES.some((g) => source.includes(g));
      }
    );

    expect(
      ungated.map(siteKey),
      "These sites claim to gate lifecycle in their own function, and the " +
        "function's own body does not call a lifecycle gate. Either the gate was " +
        "removed, or the classification was wrong."
    ).toEqual([]);
  });

  test("every GATED_BY_CALLER site names callers that are themselves gated", () => {
    const failures: string[] = [];

    // A named caller may itself be a registered caller-gated helper — the
    // opening-balance draft is exactly that, gated by the public mutation above
    // it. So the resolution is TRANSITIVE, and it terminates: a chain must
    // reach a function that gates or authenticates in its own body, and a cycle
    // is reported rather than silently accepted.
    const callerGated = new Map<string, string[]>();
    for (const s of CLASSIFIED_WRITE_SITES) {
      if (s.gate === "GATED_BY_CALLER" && s.via) callerGated.set(`${s.file}#${s.fn}`, s.via);
    }

    const resolve = (ref: string, seen: string[]): string | null => {
      if (seen.includes(ref)) return `cycle in the caller chain: ${[...seen, ref].join(" -> ")}`;
      const [file, fn] = ref.split("#");
      const source = functionSource(file!, fn!);
      if (source === null) return `named caller ${ref} does not exist`;
      if (LIFECYCLE_GATES.some((g) => source.includes(g))) return null;
      if (source.includes("requireTenantAuth")) return null;

      const parents = callerGated.get(ref);
      if (!parents || parents.length === 0) return `named caller ${ref} carries no gate`;
      for (const parent of parents) {
        const failure = resolve(parent, [...seen, ref]);
        if (failure) return failure;
      }
      return null;
    };

    for (const site of CLASSIFIED_WRITE_SITES) {
      if (site.gate !== "GATED_BY_CALLER") continue;
      if (!site.via || site.via.length === 0) {
        failures.push(`${siteKey(site)} — GATED_BY_CALLER with no caller named`);
        continue;
      }
      for (const via of site.via) {
        const failure = resolve(via, []);
        if (failure) failures.push(`${siteKey(site)} — ${failure}`);
      }
    }

    expect(
      failures,
      "A helper is only safe if EVERY caller that reaches it is gated. These " +
        "named callers do not carry a lifecycle gate or requireTenantAuth."
    ).toEqual([]);
  });

  test("the enumeration is 19 sites across 7 files, and the count is measured not remembered", () => {
    const sites = findLedgerCoreWriteSites();
    const files = new Set(sites.map((s) => s.file));

    // ⚠️ THIS IS A TRIPWIRE, NOT THE AUTHORITY. The site-set equality test above
    // is the authority; this exists so that a change to the TOTAL is stated in
    // the failure output, because a graph index once reported 17 here and the
    // two it dropped were the fourth economic cron's path.
    expect({ sites: sites.length, files: files.size }).toEqual({ sites: 19, files: 7 });
  });
});
