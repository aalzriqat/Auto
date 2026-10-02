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
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import schema from "../convex/schema";
import { convexSourceFiles, parseModule, staticStringOf } from "./commitmentWriteGuard";
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
  /** Writer sites seen, including unparsed ones (definitions and type positions excluded). */
  sites: number;
  /** sourceType kinds resolved to a string literal. */
  literals: string[];
  /** Call sites whose sourceType could not be resolved, as `reason: snippet`. */
  unparsed: string[];
}

const snippet = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 100);

/**
 * Parsed with the TypeScript compiler API, like commitmentWriteGuard (SCRUM-208).
 * The previous text scanner was forged five ways (a table held in a const, a
 * space before the paren, an import alias, a `//` inside a string, an inner-scope
 * shadow of a const), then five more ways through indirect calls. What fails
 * closed, exactly: (1) a recognised call whose table, args object or `sourceType`
 * cannot be read statically; (2) any value-position occurrence of a watched name
 * (`insert`, the helpers, `createReceivable`) outside the recognised direct
 * positions listed on `indirectUse`: element access, `.call`/`.apply`,
 * destructuring, a stored reference, a parenthesised callee; (3) a helper
 * re-exported under another name. NOT covered: a table or function reached by a
 * computed (non-literal) element-access key, or any write that never names one of
 * the watched names. Identifier resolution is deliberately NOT
 * heuristic (the SCRUM-208 lesson, "a number cannot be shadowed"): a name resolves
 * only when the file declares it exactly once, anywhere, as a top-level
 * `const NAME = "literal"`.
 */
const RECEIVABLE_HELPERS: ReadonlySet<string> = new Set(["createReceivableDocument", "ensureReceivableDocument"]);
/** Names that, passed as a function reference, enqueue a receivableDocuments write. */
const RECEIVABLE_MUTATION_REFS: ReadonlySet<string> = new Set([...RECEIVABLE_HELPERS, "createReceivable"]);

/** Peel `( )`, `as T`, `<T>x`, `x satisfies T` and `x!`: none changes the value. */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

/** Every binding of each name in the file, at any scope, including imports, parameters and patterns. */
function declarationsByName(sf: ts.SourceFile): Map<string, ts.Node[]> {
  const out = new Map<string, ts.Node[]>();
  const add = (name: ts.Node | undefined, decl: ts.Node) => {
    if (name && ts.isIdentifier(name)) out.set(name.text, [...(out.get(name.text) ?? []), decl]);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isImportSpecifier(node) ||
      ts.isImportClause(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node)
    ) {
      add(node.name, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The literal a name is bound to, or null. Resolves ONLY a sole, top-level `const NAME = "..."`. */
function resolveConstString(name: string, decls: Map<string, ts.Node[]>): string | null {
  const all = decls.get(name) ?? [];
  if (all.length !== 1) return null;
  const decl = all[0];
  if (!ts.isVariableDeclaration(decl) || !decl.initializer) return null;
  const list = decl.parent;
  if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return null;
  if (!ts.isVariableStatement(list.parent) || !ts.isSourceFile(list.parent.parent)) return null;
  return staticStringOf(unwrap(decl.initializer));
}

/** True when `node` sits inside a type annotation, where `typeof helper` is not a call. */
const inTypePosition = (node: ts.Node): boolean => {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (ts.isTypeNode(p)) return true;
  return false;
};

type SourceTypeVerdict = { kind: string } | { reason: string };

function sourceTypeOf(arg: ts.Expression | undefined, decls: Map<string, ts.Node[]>): SourceTypeVerdict {
  if (!arg) return { reason: "no inline object argument: (missing)" };
  const obj = unwrap(arg);
  if (!ts.isObjectLiteralExpression(obj)) {
    return { reason: `no inline object argument: ${snippet(arg.getText())}` };
  }
  if (obj.properties.some((p) => ts.isSpreadAssignment(p))) {
    return { reason: `spread args: ${snippet(obj.getText())}` };
  }
  // A computed key could spell sourceType at runtime; refuse rather than guess.
  if (obj.properties.some((p) => p.name && ts.isComputedPropertyName(p.name))) {
    return { reason: `computed key: ${snippet(obj.getText())}` };
  }
  const named = obj.properties.filter(
    (p) => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "sourceType"
  );
  if (named.length === 0) return { reason: `no sourceType key: ${snippet(obj.getText())}` };
  if (named.length > 1) return { reason: `duplicate sourceType: ${snippet(obj.getText())}` };
  const prop = named[0];
  if (!ts.isPropertyAssignment(prop)) return { reason: `shorthand or method sourceType: ${snippet(prop.getText())}` };
  const value = unwrap(prop.initializer);
  const literal = staticStringOf(value);
  if (literal !== null) return { kind: literal };
  if (ts.isIdentifier(value)) {
    const resolved = resolveConstString(value.text, decls);
    if (resolved !== null) return { kind: resolved };
  }
  return { reason: `unresolved sourceType: ${snippet(value.getText())}` };
}

/**
 * Inspects EVERY receivableDocuments write in one file. A call is a SITE when it
 * is: a `.insert(` (any receiver, so a `db = ctx.db` alias counts) whose table is
 * "receivableDocuments" OR is not a string literal (unresolved, so unparsed); a
 * call of `createReceivableDocument` / `ensureReceivableDocument` under any
 * import alias, or as a namespace member; or a call passing a function reference
 * named after a helper or `createReceivable` (the `runMutation` form). A helper
 * that escapes as a bare value, or is re-exported under another name, is reported
 * as unparsed. Definitions, imports, type positions and comments are not sites.
 * Each site's `sourceType` must resolve to a literal or it is reported.
 */
function scanReceivableDocumentWriters(rawText: string, file = "scanned.ts"): ReceivableWriterScan {
  const sf = parseModule(rawText, file);
  const decls = declarationsByName(sf);
  const aliases = new Set<string>(RECEIVABLE_HELPERS);
  sf.forEachChild(function findImports(node) {
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const el of bindings.elements) {
      if (RECEIVABLE_HELPERS.has((el.propertyName ?? el.name).text)) aliases.add(el.name.text);
    }
  });

  const literals = new Set<string>();
  const unparsed: string[] = [];
  let sites = 0;
  const record = (verdict: SourceTypeVerdict) => {
    sites++;
    if ("kind" in verdict) literals.add(verdict.kind);
    else unparsed.push(verdict.reason);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && !inTypePosition(node)) {
      const callee = node.expression;
      const args = node.arguments;
      const refAt = args.findIndex((a) => {
        const e = unwrap(a);
        return ts.isPropertyAccessExpression(e) && RECEIVABLE_MUTATION_REFS.has(e.name.text);
      });
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "insert") {
        const table = staticStringOf(args[0]);
        if (table === "receivableDocuments") record(sourceTypeOf(args[1], decls));
        else if (table === null) {
          sites++;
          unparsed.push(
            `insert with an unresolvable table: counted as a possible receivableDocuments writer: ${snippet(args[0] ? args[0].getText() : "(missing)")}`
          );
        }
      } else if (ts.isIdentifier(callee) && aliases.has(callee.text)) {
        record(sourceTypeOf(args[1], decls));
      } else if (ts.isPropertyAccessExpression(callee) && RECEIVABLE_HELPERS.has(callee.name.text)) {
        record(sourceTypeOf(args[1], decls));
      } else if (refAt >= 0) {
        record(sourceTypeOf(args[refAt + 1], decls));
      }
    } else if (ts.isExportSpecifier(node) && node.propertyName && RECEIVABLE_HELPERS.has(node.propertyName.text)) {
      sites++;
      unparsed.push(`re-export under a new name: ${snippet(node.getText())}`);
    }
    // Name-keyed escape check, independent of the call shape above: EVERY value-position
    // occurrence of a watched name must sit in a recognised direct position or it is a site.
    let escape: string | null = null;
    if (ts.isIdentifier(node)) escape = indirectUse(node, aliases);
    else if (ts.isElementAccessExpression(node) && !inTypePosition(node)) {
      const key = staticStringOf(node.argumentExpression);
      if (key !== null && WATCHED_NAMES.has(key)) escape = `indirect use of ${key}: ${snippet(node.getText())}`;
    }
    if (escape !== null) {
      sites++;
      unparsed.push(escape);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { sites, literals: [...literals].sort(), unparsed: unparsed.sort() };
}

/** `insert`, the helpers and the function-reference names: the only names that can write the table. */
const WATCHED_NAMES: ReadonlySet<string> = new Set(["insert", ...RECEIVABLE_MUTATION_REFS]);

/** Object/class member names are keys, not references. */
const isKeyPosition = (p: ts.Node, id: ts.Identifier): boolean =>
  (ts.isPropertyAssignment(p) ||
    ts.isPropertySignature(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isMethodSignature(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isEnumMember(p)) &&
  p.name === id;

/**
 * The reason string when this identifier is a watched name used in a value position
 * that is NOT one of the recognised direct positions, else null. Recognised:
 * (a) the member name of a property access that is directly the callee (insert and
 * the helpers); (b) an identifier callee that is a helper or import alias; (c) the
 * member name of a property access passed directly as an argument (the function-
 * reference form); (d) a function or variable declaration's own name; plus imports,
 * exports (renames are reported separately), object keys and type positions.
 * Destructuring, shorthand properties, element access and every other shape fail closed.
 */
function indirectUse(id: ts.Identifier, aliases: ReadonlySet<string>): string | null {
  const name = id.text;
  const base = WATCHED_NAMES.has(name);
  if (!base && !aliases.has(name)) return null;
  if (inTypePosition(id)) return null;
  const p = id.parent;
  const bad = (n: ts.Node) => `indirect use of ${name}: ${snippet(n.getText())}`;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return null;
  if (ts.isBindingElement(p)) {
    for (let a: ts.Node | undefined = p; a; a = a.parent) {
      if (ts.isVariableDeclaration(a) || ts.isParameter(a)) return bad(a);
    }
    return bad(p);
  }
  if (ts.isShorthandPropertyAssignment(p)) return bad(p);
  if (ts.isPropertyAccessExpression(p) && p.name === id) {
    if (!base) return null; // an alias-only name as someone else's member
    const g = p.parent;
    if (ts.isCallExpression(g) && g.expression === p && (name === "insert" || RECEIVABLE_HELPERS.has(name))) return null;
    if (ts.isCallExpression(g) && g.arguments.some((a) => a === p) && RECEIVABLE_MUTATION_REFS.has(name)) return null;
    return bad(p);
  }
  if (isKeyPosition(p, id)) return null;
  if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === id) return null;
  if (ts.isCallExpression(p) && p.expression === id && aliases.has(name)) return null;
  return bad(p);
}

interface CensusPin {
  /** Exact writer-site count per file. A new file, or a changed count, fails. */
  sites: Record<string, number>;
  /** Exact multiset of unparsed reasons per file (reason -> count). */
  unparsed: Record<string, Record<string, number>>;
}

/**
 * The receivableDocuments writer census, as an exact pin. Verified against
 * convex/ with the AST scanner (SCRUM-559 R1). subledger.ts is the generic
 * writer: its three unparsed sites forward a caller's args and are pinned by
 * reason AND count, so a second identical pass-through fails instead of being
 * swallowed by a Set.
 */
const WRITER_CENSUS: CensusPin = {
  sites: { "applications.ts": 1, "collections.ts": 1, "subledger.ts": 3, "utils/saleCompletion.ts": 1 },
  unparsed: {
    "subledger.ts": {
      "unresolved sourceType: args.sourceType": 1, // the insert inside createReceivableDocument
      "no inline object argument: args": 1, // ensureReceivableDocument -> createReceivableDocument(ctx, args)
      "spread args: { ...args, actorId: user._id }": 1, // the internal createReceivable mutation
    },
  },
};

const countBy = (xs: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
};

/** Every way the scan differs from the pin; empty when it equals it exactly. */
function censusProblems(scans: Record<string, ReceivableWriterScan>, pin: CensusPin): string[] {
  const problems: string[] = [];
  const files = new Set([
    ...Object.entries(scans).filter(([, s]) => s.sites > 0).map(([f]) => f),
    ...Object.keys(pin.sites),
  ]);
  for (const file of [...files].sort()) {
    const actual = scans[file]?.sites ?? 0;
    const expected = pin.sites[file] ?? 0;
    if (actual !== expected) {
      problems.push(
        `${file}: ${actual} receivableDocuments writer site(s), pinned ${expected}. Decide the new site's reset handling, then update WRITER_CENSUS.`
      );
    }
    const actualReasons = countBy(scans[file]?.unparsed ?? []);
    const expectedReasons = pin.unparsed[file] ?? {};
    if (JSON.stringify(Object.entries(actualReasons).sort()) !== JSON.stringify(Object.entries(expectedReasons).sort())) {
      problems.push(
        `${file}: unparsed sites ${JSON.stringify(actualReasons)} differ from the pin ${JSON.stringify(expectedReasons)}`
      );
    }
    for (const kind of scans[file]?.literals ?? []) {
      if (!(kind in RECEIVABLE_DOCUMENT_SOURCE_KINDS)) {
        problems.push(`${file}: sourceType kind "${kind}" has no pinned target table (decide its reset handling)`);
      }
    }
  }
  return problems;
}

function scanConvex(): Record<string, ReceivableWriterScan> {
  const out: Record<string, ReceivableWriterScan> = {};
  for (const file of convexSourceFiles(CONVEX_DIR)) {
    const rel = path.relative(CONVEX_DIR, file).replace(/\\/g, "/");
    out[rel] = scanReceivableDocumentWriters(fs.readFileSync(file, "utf8"), rel);
  }
  return out;
}

describe("receivableDocuments.sourceId opaque references stay pinned", () => {
  test("the writer census equals its pin and every kind is a pinned kind", () => {
    const scans = scanConvex();
    const literals = new Set(Object.values(scans).flatMap((s) => s.literals));
    // Sanity: the scan must actually see the known writers, or it proves nothing.
    for (const kind of Object.keys(RECEIVABLE_DOCUMENT_SOURCE_KINDS)) expect(literals).toContain(kind);
    const problems = censusProblems(scans, WRITER_CENSUS);
    expect(problems, render("receivableDocuments writer census differs from its pin:", problems)).toEqual([]);
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

  // ── SCRUM-559 R1: forgeries Codex proved against the regex scanner ──────────
  const NEW = 'await ctx.db.insert("receivableDocuments", { sourceType: "new_kind" });';

  test("MUTATION CONTROL (a): a table name held in a const is unparsed, not skipped", () => {
    const scan = scanReceivableDocumentWriters(
      'const TABLE = "receivableDocuments"; await ctx.db.insert(TABLE, { sourceType: "new_kind" });'
    );
    expect(scan.sites).toBe(1);
    expect(scan.unparsed).toHaveLength(1);
  });

  test("MUTATION CONTROL (b): whitespace before the call paren does not hide the site", () => {
    const scan = scanReceivableDocumentWriters(
      'await ctx.db.insert ("receivableDocuments", { sourceType: "new_kind" });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL (c): an import alias of a helper is still a site", () => {
    const scan = scanReceivableDocumentWriters(
      'import { ensureReceivableDocument as ensure } from "./subledger"; await ensure(ctx, { sourceType: "new_kind" });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL (d): a string containing // does not swallow the next call", () => {
    const scan = scanReceivableDocumentWriters(`const u = "a//b"; ${NEW}`);
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL (e): an inner-scope shadow of a const is unparsed, not resolved", () => {
    const scan = scanReceivableDocumentWriters(
      'const KIND = "sales"; { const KIND = args.sourceType; await ensureReceivableDocument(ctx, { sourceType: KIND }); }'
    );
    expect(scan.literals).toEqual([]);
    expect(scan.unparsed).toHaveLength(1);
  });

  test("MUTATION CONTROL: a namespace-import call is a site", () => {
    const scan = scanReceivableDocumentWriters(
      'import * as sl from "./subledger"; await sl.createReceivableDocument(ctx, { sourceType: "new_kind" });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL: the runMutation function-reference form is a site", () => {
    const scan = scanReceivableDocumentWriters(
      'await ctx.runMutation(internal.subledger.createReceivable, { sourceType: "new_kind" });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL: a re-export of a helper under a new name is unparsed", () => {
    const scan = scanReceivableDocumentWriters('export { ensureReceivableDocument as renamed } from "./subledger";');
    expect(scan.unparsed).toHaveLength(1);
  });

  test("MUTATION CONTROL: a db alias insert is a site", () => {
    const scan = scanReceivableDocumentWriters(
      'const db = ctx.db; await db.insert("receivableDocuments", { sourceType: "new_kind" });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL: a shorthand { sourceType } is unparsed", () => {
    const scan = scanReceivableDocumentWriters(
      'const sourceType = "sales"; await ensureReceivableDocument(ctx, { sourceType });'
    );
    expect(scan.literals).toEqual([]);
    expect(scan.unparsed).toHaveLength(1);
  });

  test("MUTATION CONTROL: an identifier with two declarations is unparsed; a single top-level const resolves", () => {
    const twice = scanReceivableDocumentWriters(
      'const K = "a"; function f(K: string) {} await ensureReceivableDocument(ctx, { sourceType: K });'
    );
    expect(twice.literals).toEqual([]);
    expect(twice.unparsed).toHaveLength(1);
    const once = scanReceivableDocumentWriters(
      'const K = "kind_a"; await ensureReceivableDocument(ctx, { sourceType: K });'
    );
    expect(once.literals).toEqual(["kind_a"]);
    expect(once.unparsed).toEqual([]);
  });

  // ── SCRUM-559 R1 round 2: indirect-call escapes, keyed by NAME not call shape ──
  test.each([
    ["an element-access callee", 'await ctx.db["insert"]("receivableDocuments", { sourceType: "new_kind" });'],
    ["insert.call", 'await ctx.db.insert.call(ctx.db, "receivableDocuments", { sourceType: "new_kind" });'],
    ["insert.apply", 'await ctx.db.insert.apply(ctx.db, ["receivableDocuments", { sourceType: "new_kind" }]);'],
    ["a destructured insert", 'const { insert } = ctx.db; await insert("receivableDocuments", { sourceType: "new_kind" });'],
    ["a parenthesised insert callee", 'await (ctx.db.insert)("receivableDocuments", { sourceType: "new_kind" });'],
    [
      "a namespace helper stored in a variable",
      'import * as sl from "./subledger"; const f = sl.ensureReceivableDocument; await f(ctx, { sourceType: "new_kind" });',
    ],
    [
      "a helper destructured out of a namespace",
      'import * as sl from "./subledger"; const { ensureReceivableDocument: f } = sl; await f(ctx, { sourceType: "new_kind" });',
    ],
    [
      "a function reference stored in a variable",
      'const ref = internal.subledger.createReceivable; await ctx.runMutation(ref, { sourceType: "new_kind" });',
    ],
    [
      "a function reference through an element access",
      'await ctx.runMutation(internal.subledger["createReceivable"], { sourceType: "new_kind" });',
    ],
  ])("MUTATION CONTROL: %s is reported, never skipped", (_name, source) => {
    const scan = scanReceivableDocumentWriters(source);
    expect(scan.unparsed.length).toBeGreaterThan(0);
    expect(scan.unparsed.some((u) => /^indirect use of /.test(u))).toBe(true);
  });

  test("MUTATION CONTROL: benign look-alikes are NOT sites (no false red)", () => {
    const scan = scanReceivableDocumentWriters(
      [
        'await ctx.db.insert("receivables", { a: 1 });',
        "const o = { insert: 1 };",
        "await aggregate.insertIfDoesNotExist(ctx, x);",
      ].join("\n")
    );
    expect(scan).toEqual({ sites: 0, literals: [], unparsed: [] });
  });

  test("MUTATION CONTROL (F2): an unresolvable insert table says it is counted as a possible writer", () => {
    const scan = scanReceivableDocumentWriters("await ctx.db.insert(table, { a: 1 });");
    expect(scan.unparsed).toHaveLength(1);
    expect(scan.unparsed[0]).toMatch(
      /^insert with an unresolvable table: counted as a possible receivableDocuments writer: table/
    );
  });

  test("MUTATION CONTROL (D2): a second identical pass-through site is not swallowed by the census", () => {
    const pass = { sites: 2, literals: [], unparsed: ["unresolved sourceType: args.sourceType", "unresolved sourceType: args.sourceType"] };
    const pin = { sites: { "subledger.ts": 2 }, unparsed: { "subledger.ts": { "unresolved sourceType: args.sourceType": 1 } } };
    expect(censusProblems({ "subledger.ts": pass }, pin)).not.toEqual([]);
    const one = { sites: 1, literals: [], unparsed: ["unresolved sourceType: args.sourceType"] };
    expect(censusProblems({ "subledger.ts": one }, { sites: { "subledger.ts": 1 }, unparsed: pin.unparsed })).toEqual([]);
  });

  test("MUTATION CONTROL: a new writer file and an unpinned kind each fail the census", () => {
    const pin = { sites: { "a.ts": 1 }, unparsed: {} };
    const ok = { sites: 1, literals: ["sales"], unparsed: [] };
    expect(censusProblems({ "a.ts": ok }, pin)).toEqual([]);
    expect(censusProblems({ "a.ts": ok, "b.ts": ok }, pin)).not.toEqual([]);
    expect(censusProblems({ "a.ts": { ...ok, literals: ["new_kind"] } }, pin)).not.toEqual([]);
    expect(censusProblems({ "a.ts": { ...ok, sites: 2 } }, pin)).not.toEqual([]);
  });

  test("every pinned kind targets a reset-scoped table", () => {
    const resetSet = new Set<string>(RESET_TABLES_FOR_TEST);
    for (const [kind, table] of Object.entries(RECEIVABLE_DOCUMENT_SOURCE_KINDS)) {
      expect(resetSet.has(table), `${kind} -> ${table}`).toBe(true);
    }
  });
});
