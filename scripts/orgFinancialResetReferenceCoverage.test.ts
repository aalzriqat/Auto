/**
 * SCRUM-546 — schema-driven reference coverage for the organization financial
 * reset.
 *
 * The reset deletes each table in `RESET_TABLES` in independently-batched
 * passes. Any `v.id(<target>)` field on a reset-scoped table whose target is
 * ALSO reset-scoped can therefore be left dangling by a partial pass, unless
 * (a) the child is listed before the target AND (b) `CHILD_TABLES` defers the
 * target while the child still has rows. Two defects of exactly this shape
 * (SCRUM-534 quotes/sales, SCRUM-546 payrollRuns) were found by reviewers, one
 * edge at a time. This test walks the schema so the next one fails here.
 *
 * Every (table, field path, target) must be exactly one of:
 *   1. COVERED       — CHILD_TABLES[target] lists the table, and the table is
 *                      ordered before the target in RESET_TABLES;
 *   2. ACCEPTED      — an OPTIONAL field listed in ACCEPTED_OPTIONAL_DANGLING;
 *   3. KNOWN SURVIVING — listed in KNOWN_SURVIVING_REFERENCES (OPEN DECISION).
 * Anything else, and any stale entry in the lists, fails.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import schema from "../convex/schema";
import { convexSourceFiles } from "./commitmentWriteGuard";
import { CHILD_TABLES_FOR_TEST, RESET_TABLES_FOR_TEST } from "../convex/orgFinancialReset";

interface ValidatorLike {
  kind: string;
  isOptional?: string;
  tableName?: string;
  fields?: Record<string, ValidatorLike>;
  element?: ValidatorLike;
  members?: ValidatorLike[];
  key?: ValidatorLike;
  value?: ValidatorLike;
}

interface Ref {
  table: string;
  path: string;
  target: string;
  /** False only when the reference is mandatory: no optional/nullable wrapper on the path. */
  optional: boolean;
}

const pairKey = (table: string, path: string, target: string) => `${table}.${path}->${target}`;

/** Collect every v.id() under a validator, tracking optional/nullable wrappers. */
function collect(
  table: string,
  validator: ValidatorLike,
  path: string,
  optional: boolean,
  out: Ref[]
): void {
  const opt = optional || validator.isOptional === "optional";
  switch (validator.kind) {
    case "id":
      out.push({ table, path, target: validator.tableName as string, optional: opt });
      return;
    case "object":
      for (const [name, child] of Object.entries(validator.fields ?? {})) {
        collect(table, child, path ? `${path}.${name}` : name, opt, out);
      }
      return;
    case "array":
      if (validator.element) collect(table, validator.element, `${path}[]`, opt, out);
      return;
    case "record":
      // Key and value are both visited; like array elements they inherit the parent's optionality.
      if (validator.key) collect(table, validator.key, `${path}{key}`, opt, out);
      if (validator.value) collect(table, validator.value, `${path}{}`, opt, out);
      return;
    case "union": {
      const members = validator.members ?? [];
      const nullable = members.some((m) => m.kind === "null");
      for (const m of members) collect(table, m, path, opt || nullable, out);
      return;
    }
    // Leaf kinds that cannot hold a table id.
    case "float64":
    case "int64":
    case "boolean":
    case "bytes":
    case "string":
    case "null":
    case "any":
    case "literal":
      return;
    default:
      throw new Error(
        `Unhandled validator kind "${validator.kind}" at ${table}.${path}: teach collect() about it so no id reference is skipped`
      );
  }
}

function allReferences(): Ref[] {
  const tables = schema.tables as unknown as Record<string, { validator: ValidatorLike }>;
  const out: Ref[] = [];
  for (const [name, def] of Object.entries(tables)) {
    collect(name, def.validator, "", false, out);
  }
  return out;
}

/**
 * Optional reference fields between two reset-scoped tables that are
 * deliberately NOT ordered/deferred. Optional only. Each reason was verified by
 * grepping the readers and writers of the field (SCRUM-559); a field that IS
 * hard-dereferenced must be an edge, or be safe only because the suspension
 * preflight blocks every non-internal caller, and the reason must say so.
 */
const ACCEPTED_OPTIONAL_DANGLING: Record<string, string> = {
  "accountingEvents.reversalOfEventId->accountingEvents":
    "Self-reference; read only as an id compare (utils/financeCompanyForward.ts:154) and passed to a null-guarded get (utils/prepaidRecognitionEvents.ts:179-182); never a hard dereference.",
  "accountingEvents.reversedByEventId->accountingEvents":
    "Self-reference; every read null-guards the get (accounting/reversals.ts:58-59, accountingReports.ts:1110-1111, utils/financeCompanyForward.ts:149-153 fails to NEEDS_REPAIR).",
  "canonicalPayments.accountingEventId->accountingEvents":
    "Written only (subledger.ts:123,201); no reader dereferences it.",
  "canonicalPayments.cashierSessionId->cashierReconciliations":
    "Written only (subledger.ts:200); no reader dereferences it.",
  "canonicalPayments.originalPaymentId->canonicalPayments":
    "Self-reference; no reader or writer exists in convex/ outside the schema.",
  "canonicalPayments.reversalPaymentId->canonicalPayments":
    "Self-reference; no reader or writer exists in convex/ outside the schema.",
  "chartOfAccounts.parentAccountId->chartOfAccounts":
    "Self-reference; read only to validate the parent when an account is created (chartOfAccounts.ts:817-818), a tenant mutation the suspension blocks.",
  "collectionPayments.chequeId->postDatedCheques":
    "Only compared through the by_cheque index (collections.ts:2263); never dereferenced from the payment row.",
  "collectionPayments.receivableId->receivables":
    "Read only through a null-guarded get (collections.ts:292, hydratePayment); no other reader dereferences it.",
  "collectionPayments.reconciliationId->cashierReconciliations":
    "Written (collections.ts:3026) and index-filtered (collections.ts:2928) only; no reader dereferences it.",
  "commitmentAuthorityWork.activeAttemptId->commitmentAuthorityAttempt":
    "Reverse edge would cycle (attempt.workId requires work); the reset refuses any org holding authority rows (orgFinancialReset.ts authority preflight), and the one reader null-guards (accountingOutbox.ts:895-904).",
  "financeApplications.approvedPurchaseAppraisalId->financeAppraisals":
    "Dereferenced by financingEconomics.recomputeEconomicsForApplication (financingEconomics.ts:188-190, null-tolerated but silently drops the LTV basis) via financeDealCosts.recordDealFee (financeDealCosts.ts:1828); a reverse edge would cycle because appraisals require their application. Safe mid-reset ONLY because the suspension preflight blocks that tenant-auth writer (financeDealCosts.ts has no internal or scheduled entry point).",
  "financeAppraisals.supersededByAppraisalId->financeAppraisals":
    "Self-reference; written only (financingEconomics.ts:2096); no reader dereferences it.",
  "financeDealCustodyEntries.reversesEntryId->financeDealCustodyEntries":
    "Self-reference; hard-dereferenced by financeDealCosts.ts:1326,1419,3235 and utils/custodySourceLedger.ts:1258,1750, all tenant-auth functions or pure ledger folds over a live custody, blocked by the suspension preflight.",
  "journalEntries.accountingEventId->accountingEvents":
    "Reverse of the E2 edge (accountingEvents.journalEntryId), which would cycle; the only reader null-guards (accountingLedger.ts:198).",
  "journalEntries.reversalOfJournalEntryId->journalEntries":
    "Self-reference; written only (accounting/reversals.ts:219); no reader dereferences it.",
  "journalEntries.reversedByJournalEntryId->journalEntries":
    "Self-reference; written only (accounting/reversals.ts:272); no reader dereferences it.",
  "paymentAllocations.reversalOfAllocationId->paymentAllocations":
    "Self-reference; used only as a Map key in accountingReports.ts:443-450, never dereferenced.",
  "paymentAllocations.reversedByAllocationId->paymentAllocations":
    "Self-reference; written only (subledger.ts:367); no reader dereferences it.",
  "postDatedCheques.replacementChequeId->postDatedCheques":
    "Self-reference; the only reader (chequeLineageAudit.ts:77-78) null-guards the get and answers UNRESOLVED; collections.ts:2171 writes it.",
  "receivableDocuments.accountingEventId->accountingEvents":
    "Written only (subledger.ts:123); no reader dereferences it.",
  "receivableDocuments.reversedDocumentId->receivableDocuments":
    "Self-reference; no reader or writer exists in convex/ outside the schema.",
  "receivables.applicationId->financeApplications":
    "Only ownership-checked when a receivable is created (collections.ts:239-241), a tenant mutation the suspension blocks; never dereferenced from a stored row.",
  "sales.applicationId->financeApplications":
    "Dereferenced by sales.cancel (sales.ts:1024-1025, fails closed), getBillOfSaleEconomics (sales.ts:353) and utils/financingProvenance.ts:86,98 (reports and dashboard). A reverse edge would cycle. Safe mid-reset ONLY because the suspension preflight blocks those tenant-auth callers.",
  "transactions.depositId->deposits":
    "Read through null-guarded gets (transactions.ts:40-45, depositRevenueImpact.ts:107) and an id compare (reports.ts:1050).",
  "transactions.expenseId->expenses":
    "Written at creation only (transactions.ts:273,297); no reader dereferences it.",
};

/**
 * ⚠️ OPEN DECISION (SCRUM-546, owner ruling c21566: document only). Surviving
 * references that the reset leaves pointing at deleted reset-scoped rows, or
 * that a reset-scoped table holds to a table the reset does not clear. None of
 * these is endorsed; listing them stops the set growing silently.
 */
const KNOWN_SURVIVING_REFERENCES: Record<string, string> = {
  "applicationDocuments.applicationId->financeApplications":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "bankStatementLines.matchedJournalLineId->journalLines":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "cashMovements.accountingEventId->accountingEvents":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "claims.receivableDocumentId->receivableDocuments":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "claims.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "collectionReminders.chequeId->postDatedCheques":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "collectionReminders.receivableId->receivables":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "commitmentRoots.consumedBySaleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "commitmentRoots.headQuoteId->quotes":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "consignedSaleCorrections.correctionJournalEntryId->journalEntries":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "consignedSaleCorrections.originalJournalEntryIds[]->journalEntries":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "consignedSaleCorrections.recognizedRevenueTransactionId->transactions":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "consignedSaleCorrections.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "dealerProductDeferrals.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "depositApplications.depositId->deposits":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "depositApplications.quoteId->quotes":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "depositApplications.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "depositRequests.confirmedDepositId->deposits":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "depositRequests.quoteId->quotes":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "depositVehicleHolds.appliedSaleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "depositVehicleHolds.depositId->deposits":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "employeeAdvanceRecoveries.payrollItemId->payrollItems":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "financeCompanyForwards.applicationId->financeApplications":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "fixedAssetEvents.accountingEventId->accountingEvents":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "manualJournalDrafts.journalEntryId->journalEntries":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "manualJournalDrafts.lines[].accountId->chartOfAccounts":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "openingBalanceDrafts.journalEntryId->journalEntries":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "openingBalanceDrafts.lines[].accountId->chartOfAccounts":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "partnerEquityTransactions.accountingEventId->accountingEvents":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.canonicalPaymentId->canonicalPayments":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.collectionPaymentId->collectionPayments":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.paymentAllocationId->paymentAllocations":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.receivableDocumentId->receivableDocuments":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.receivableId->receivables":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "prepaidExpenseSchedules.expenseId->expenses":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "vehicleCommitmentClaims.applicationId->financeApplications":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleCommitmentClaims.consumedBySaleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleCommitmentClaims.depositId->deposits":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleCommitmentClaims.quoteId->quotes":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleReservations.depositId->deposits":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicles.soldBySaleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleSupplierPayables.paymentAccountId->chartOfAccounts":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleSupplierPayables.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleSupplierReceivables.receiptAccountId->chartOfAccounts":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleSupplierReceivables.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "workOrders.expenseId->expenses":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
};

interface Verdict {
  unaccounted: string[];
  acceptedButRequired: string[];
  staleEntries: string[];
}

/** Pure so the mutation control can run it against a doctored CHILD_TABLES. */
function evaluate(
  resetTables: readonly string[],
  childTables: Readonly<Record<string, readonly string[]>>,
  accepted: Readonly<Record<string, string>>,
  known: Readonly<Record<string, string>>,
  refs: Ref[]
): Verdict {
  const resetSet = new Set(resetTables);
  const order = new Map(resetTables.map((t, i) => [t, i]));
  const unaccounted: string[] = [];
  const acceptedButRequired: string[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (!resetSet.has(ref.target)) continue; // target survives the reset in any case
    const key = pairKey(ref.table, ref.path, ref.target);
    const fromReset = resetSet.has(ref.table);

    if (fromReset) {
      const deferred = (childTables[ref.target] ?? []).includes(ref.table);
      const ordered =
        ref.table !== ref.target && (order.get(ref.table) ?? Infinity) < (order.get(ref.target) ?? -1);
      if (deferred && ordered) continue;
      if (key in accepted) {
        seen.add(key);
        if (!ref.optional) acceptedButRequired.push(key);
        continue;
      }
    }
    if (key in known) {
      seen.add(key);
      continue;
    }
    unaccounted.push(key);
  }

  const staleEntries = [...Object.keys(accepted), ...Object.keys(known)].filter((k) => !seen.has(k));
  return { unaccounted: unaccounted.sort(), acceptedButRequired, staleEntries: staleEntries.sort() };
}

const render = (title: string, keys: string[]) =>
  `${title}\n${keys.map((k) => `  - ${k}`).join("\n")}`;

describe("organization financial reset covers every reset-to-reset reference", () => {
  test("the analyzer sees the references it is supposed to guard", () => {
    const keys = new Set(allReferences().map((r) => pairKey(r.table, r.path, r.target)));
    // Required references that motivated this test, incl. an array-of-ids one.
    expect(keys).toContain("payrollItems.runId->payrollRuns");
    expect(keys).toContain("payrollItems.commissionSaleIds[]->sales");
    expect(keys).toContain("financeApplications.quoteId->quotes");
    expect(allReferences().find((r) => r.table === "payrollItems" && r.path === "runId")?.optional).toBe(
      false
    );
  });

  test("every reference is covered, accepted, or a pinned open decision", () => {
    const verdict = evaluate(
      RESET_TABLES_FOR_TEST,
      CHILD_TABLES_FOR_TEST,
      ACCEPTED_OPTIONAL_DANGLING,
      KNOWN_SURVIVING_REFERENCES,
      allReferences()
    );
    expect(
      verdict.unaccounted,
      render(
        "Reset-scoped references with no CHILD_TABLES edge + RESET_TABLES order, and no pinned decision. " +
          "Add the edge (child before parent), or pin the pair with a reason:",
        verdict.unaccounted
      )
    ).toEqual([]);
    expect(
      verdict.acceptedButRequired,
      render("ACCEPTED_OPTIONAL_DANGLING is only for OPTIONAL fields:", verdict.acceptedButRequired)
    ).toEqual([]);
    expect(
      verdict.staleEntries,
      render("Pinned entries that no longer match a schema reference:", verdict.staleEntries)
    ).toEqual([]);
  });

  test("MUTATION CONTROL: removing the payrollRuns edge is detected", () => {
    const mutated: Record<string, readonly string[]> = { ...CHILD_TABLES_FOR_TEST };
    delete mutated.payrollRuns;
    const verdict = evaluate(
      RESET_TABLES_FOR_TEST,
      mutated,
      ACCEPTED_OPTIONAL_DANGLING,
      KNOWN_SURVIVING_REFERENCES,
      allReferences()
    );
    expect(verdict.unaccounted).toContain("payrollItems.runId->payrollRuns");
  });

  test("MUTATION CONTROL: listing payrollRuns before payrollItems is detected", () => {
    const reordered = RESET_TABLES_FOR_TEST.filter((t) => t !== "payrollRuns");
    reordered.splice(reordered.indexOf("payrollItems"), 0, "payrollRuns");
    const verdict = evaluate(
      reordered,
      CHILD_TABLES_FOR_TEST,
      ACCEPTED_OPTIONAL_DANGLING,
      KNOWN_SURVIVING_REFERENCES,
      allReferences()
    );
    expect(verdict.unaccounted).toContain("payrollItems.runId->payrollRuns");
  });

  test("MUTATION CONTROL: a v.record key id is collected", () => {
    const out: Ref[] = [];
    collect("t", v.record(v.id("payrollRuns"), v.string()) as unknown as ValidatorLike, "f", false, out);
    expect(out).toEqual([{ table: "t", path: "f{key}", target: "payrollRuns", optional: false }]);
  });

  test("MUTATION CONTROL: a v.record value id inherits the parent optionality", () => {
    const required: Ref[] = [];
    collect("t", v.record(v.string(), v.id("payrollRuns")) as unknown as ValidatorLike, "f", false, required);
    expect(required).toEqual([{ table: "t", path: "f{}", target: "payrollRuns", optional: false }]);
    const optionalOut: Ref[] = [];
    collect("t", v.record(v.string(), v.id("payrollRuns")) as unknown as ValidatorLike, "f", true, optionalOut);
    expect(optionalOut[0]?.optional).toBe(true);
  });

  test("MUTATION CONTROL: an unknown validator kind throws instead of being skipped", () => {
    expect(() => collect("t", { kind: "futureKind" }, "f", false, [])).toThrow(/futureKind.*t\.f|t\.f.*futureKind/);
  });
});

/**
 * `receivableDocuments.sourceId` is an opaque string, so the v.id walk above
 * cannot see it, yet each known `sourceType` makes it a reference to a row in a
 * reset-scoped table. Pinned here so a new kind cannot appear unnoticed.
 *
 * `sourceId` is only compared through the by_org source index and written; no
 * reader turns it back into a row id today (SCRUM-559 recon). `subledger
 * .createReceivable` (internal) accepts arbitrary strings, so the scan below
 * covers the in-repo writers only; the open-ended input is tracked in SCRUM-563.
 */
const RECEIVABLE_DOCUMENT_SOURCE_KINDS: Record<string, string> = {
  finance_application: "financeApplications",
  legacy_receivable: "receivables",
  sales: "sales",
};

const CONVEX_DIR = path.join(__dirname, "..", "convex");

interface ReceivableWriterScan {
  /** Call sites seen (helper calls and direct inserts; definitions excluded). */
  sites: number;
  /** sourceType kinds resolved to a string literal. */
  literals: string[];
  /** Call sites whose sourceType could not be resolved, as `reason: snippet`. */
  unparsed: string[];
}

/** Blank out comments so a call mentioned in prose is not a site. Strings are left alone. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Index just past the matching close of the bracket at `open`; quote-aware. -1 when unbalanced. */
function matchingClose(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas that sit outside any bracket or string. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
    } else if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

const snippet = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 100);
const STRING_LITERAL = /^(["'`])([^"'`\\$]*)\1$/;

/**
 * Inspects EVERY receivableDocuments write in one file's text: calls to
 * `createReceivableDocument(` / `ensureReceivableDocument(` and direct
 * `.insert("receivableDocuments"`. Function definitions, imports, type
 * positions and comments are not sites. Each site's `sourceType` must resolve
 * to a string literal (inline, or through a same-file `const X = "..."`);
 * anything else is reported as unparsed rather than silently skipped.
 */
function scanReceivableDocumentWriters(rawText: string): ReceivableWriterScan {
  const text = stripComments(rawText);
  const literals = new Set<string>();
  const unparsed: string[] = [];
  let sites = 0;
  const siteRe = /\b(?:createReceivableDocument|ensureReceivableDocument)\s*\(|\.insert\(\s*["'`]receivableDocuments["'`]/g;
  for (const m of text.matchAll(siteRe)) {
    const index = m.index ?? 0;
    if (/function\s*\*?\s*$/.test(text.slice(0, index))) continue; // a definition, not a call
    sites++;
    const open = index + m[0].indexOf("("); // the helper's or insert's own opening paren
    const close = matchingClose(text, open);
    if (close < 0) {
      unparsed.push(`unbalanced call: ${snippet(text.slice(index, index + 80))}`);
      continue;
    }
    const args = splitTopLevel(text.slice(open + 1, close));
    const objectArg = args[1] ?? "";
    if (!objectArg.startsWith("{")) {
      unparsed.push(`no inline object argument: ${snippet(objectArg || args.join(", "))}`);
      continue;
    }
    const props = splitTopLevel(objectArg.slice(1, objectArg.lastIndexOf("}")));
    if (props.some((p) => p.startsWith("..."))) {
      unparsed.push(`spread args: ${snippet(objectArg)}`);
      continue;
    }
    const prop = props.map((p) => /^sourceType\s*(?::\s*([\s\S]*))?$/.exec(p)).find((r) => r !== null);
    if (!prop) {
      unparsed.push(`no sourceType key: ${snippet(objectArg)}`);
      continue;
    }
    const expr = (prop[1] ?? "sourceType").trim();
    const literal = STRING_LITERAL.exec(expr);
    if (literal) {
      literals.add(literal[2]);
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
      const constant = new RegExp(`\\bconst\\s+${expr.replace(/\$/g, "\\$")}\\s*=\\s*(["'])([^"'\\\\]*)\\1`).exec(text);
      if (constant) {
        literals.add(constant[2]);
        continue;
      }
    }
    unparsed.push(`unresolved sourceType: ${snippet(expr)}`);
  }
  return { sites, literals: [...literals], unparsed };
}

/**
 * subledger.ts is the generic writer: its sourceType comes from its caller's
 * args, so these (and only these) pass-through sites are tolerated there. Any
 * other unparsed site in that file still fails the pin.
 */
const SUBLEDGER_PASSTHROUGH = new Set<string>([
  "unresolved sourceType: args.sourceType",
  "no inline object argument: args",
  "spread args: { ...args, actorId: user._id }",
]);

function receivableDocumentWriterScan(): { writers: string[]; literals: Set<string>; unparsed: string[] } {
  const writers: string[] = [];
  const literals = new Set<string>();
  const unparsed: string[] = [];
  for (const file of convexSourceFiles(CONVEX_DIR)) {
    const rel = path.relative(CONVEX_DIR, file).replace(/\\/g, "/");
    const scan = scanReceivableDocumentWriters(fs.readFileSync(file, "utf8"));
    if (scan.sites === 0) continue;
    writers.push(rel);
    for (const kind of scan.literals) literals.add(kind);
    for (const u of scan.unparsed) {
      if (rel === "subledger.ts" && SUBLEDGER_PASSTHROUGH.has(u)) continue;
      unparsed.push(`${rel} -> ${u}`);
    }
  }
  return { writers, literals, unparsed };
}

describe("receivableDocuments.sourceId opaque references stay pinned", () => {
  test("every in-repo writer uses a pinned sourceType kind", () => {
    const { writers, literals, unparsed } = receivableDocumentWriterScan();
    // Sanity: the scan must actually see the known writers, or it proves nothing.
    expect(writers).toEqual(expect.arrayContaining(["applications.ts", "collections.ts", "utils/saleCompletion.ts"]));
    for (const kind of Object.keys(RECEIVABLE_DOCUMENT_SOURCE_KINDS)) expect(literals).toContain(kind);
    expect(
      unparsed,
      render("receivableDocuments writers whose sourceType cannot be resolved to a literal (pin them or decide their reset handling):", unparsed)
    ).toEqual([]);
    const unknown = [...literals].filter((k) => !(k in RECEIVABLE_DOCUMENT_SOURCE_KINDS)).sort();
    expect(
      unknown,
      render("receivableDocuments.sourceType kinds with no pinned target table (decide its reset handling):", unknown)
    ).toEqual([]);
  });

  test("MUTATION CONTROL: a direct insert with a new literal kind is detected", () => {
    const scan = scanReceivableDocumentWriters(
      'await ctx.db.insert("receivableDocuments", { orgId, sourceType: "new_kind", sourceId: x });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
    expect(scan.unparsed).toEqual([]);
  });

  test("MUTATION CONTROL: a direct insert with an unresolved identifier is unparsed", () => {
    const scan = scanReceivableDocumentWriters(
      'await ctx.db.insert("receivableDocuments", { orgId, sourceType: someVar, sourceId: x });'
    );
    expect(scan.literals).toEqual([]);
    expect(scan.unparsed).toEqual(["unresolved sourceType: someVar"]);
  });

  test("MUTATION CONTROL: a helper call without an inline object argument is unparsed", () => {
    const scan = scanReceivableDocumentWriters("await createReceivableDocument(ctx, args);");
    expect(scan.literals).toEqual([]);
    expect(scan.unparsed).toEqual(["no inline object argument: args"]);
  });

  test("MUTATION CONTROL: spread args, a missing key, and a computed value are unparsed", () => {
    expect(scanReceivableDocumentWriters("await ensureReceivableDocument(ctx, { ...base, sourceType: 'x' });").unparsed).toHaveLength(1);
    expect(scanReceivableDocumentWriters("await ensureReceivableDocument(ctx, { orgId, sourceId: x });").unparsed).toEqual([
      "no sourceType key: { orgId, sourceId: x }",
    ]);
    expect(
      scanReceivableDocumentWriters('await ensureReceivableDocument(ctx, { sourceType: a ? "x" : "y" });').unparsed
    ).toEqual(['unresolved sourceType: a ? "x" : "y"']);
  });

  test("MUTATION CONTROL: a helper call resolving through a _SOURCE const yields the kind", () => {
    const scan = scanReceivableDocumentWriters(
      'const FOO_SOURCE = "foo_kind";\nawait ensureReceivableDocument(ctx, { sourceType: FOO_SOURCE, sourceId: x });'
    );
    expect(scan.literals).toEqual(["foo_kind"]);
    expect(scan.unparsed).toEqual([]);
  });

  test("MUTATION CONTROL: a known literal resolves, and definitions, imports and type positions are not sites", () => {
    const scan = scanReceivableDocumentWriters(
      [
        "import { ensureReceivableDocument } from './subledger';",
        "export async function createReceivableDocument(ctx, args) { return 1; }",
        "type T = Parameters<typeof ensureReceivableDocument>[1];",
        "// createReceivableDocument(ctx, args) in a comment",
        'await ensureReceivableDocument(ctx, { sourceType: "sales", sourceId: x });',
      ].join("\n")
    );
    expect(scan).toEqual({ sites: 1, literals: ["sales"], unparsed: [] });
  });

  test("every pinned kind targets a reset-scoped table", () => {
    const resetSet = new Set<string>(RESET_TABLES_FOR_TEST);
    for (const [kind, table] of Object.entries(RECEIVABLE_DOCUMENT_SOURCE_KINDS)) {
      expect(resetSet.has(table), `${kind} -> ${table}`).toBe(true);
    }
  });
});
