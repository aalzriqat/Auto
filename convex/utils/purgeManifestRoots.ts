/**
 * SCRUM-1023: loads the explicit roots of the purge dry run (moved out of `purgeManifest.ts` for the size guardrail).
 * READ-ONLY. A root is refused when missing or not in a purgeable state, never "approximately" purged.
 */
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { ReadBudget } from "./purgeBudget";
import type { ManifestRefusal, ManifestRefusalCode, PurgeSet } from "./purgeSurvivors";

export interface PurgeRoots {
  saleIds: string[];
  applicationIds: string[];
  expenseIds: string[];
  /** TREASURY_TRANSFER accountingEvents: a transfer has no table of its own. */
  transferEventIds: string[];
  /** Phase 1b: CANCELLED payroll runs that never posted or paid anything. */
  payrollRunIds?: string[];
  /** Phase 1b: fully REFUNDED deposits whose receipt and refund net to zero. */
  depositIds?: string[];
}

type RootTable = "sales" | "financeApplications" | "expenses" | "accountingEvents" | "payrollRuns" | "deposits";

export interface Run {
  ctx: QueryCtx;
  orgId: Id<"organizations">;
  budget: ReadBudget;
  refusals: ManifestRefusal[];
  set: PurgeSet;
}

export const refuseIn = (run: Run, code: ManifestRefusalCode, table: string, detail: string, count = 1): void => {
  run.refusals.push({ code, table, detail, count });
};

export const overBound = (run: Run, table: string, detail: string): void => refuseIn(run, "OVER_BOUND", table, detail);

/** Loads one root, refuses it when missing or not in a purgeable state, otherwise adds it. */
async function loadRoot<T extends RootTable>(
  run: Run, table: T, raw: string, label: string, notEligible: (row: Doc<T>) => string | null,
): Promise<void> {
  const id = run.ctx.db.normalizeId(table, raw);
  let row: Doc<T> | null = null;
  if (id) {
    if (!run.budget.reserve(1)) { overBound(run, table, "the read budget was exhausted"); return; }
    row = await run.ctx.db.get(id);
    if (row) run.budget.record(1);
  }
  if (!row || row.orgId !== run.orgId) { refuseIn(run, "ROOT_NOT_FOUND", table, `${label} does not exist in this organization`); return; }
  const why = notEligible(row as Doc<T>);
  if (why) { refuseIn(run, "ROOT_NOT_ELIGIBLE", table, why); return; }
  run.set.addRoot(table, row._id);
}

/** One table's roots, strictly in order: each load reserves read budget first, so which root exhausts it must stay deterministic (Promise.all would interleave the refusals). */
function loadInOrder<T extends RootTable>(
  run: Run, table: T, raws: ReadonlyArray<string>, label: string, notEligible: (row: Doc<T>) => string | null,
): Promise<void> {
  return raws.reduce<Promise<void>>(async (previous, raw) => {
    await previous;
    await loadRoot(run, table, raw, label, notEligible);
  }, Promise.resolve());
}

export async function loadRoots(run: Run, roots: PurgeRoots): Promise<void> {
  const named = roots.saleIds.length + roots.applicationIds.length + roots.expenseIds.length + roots.transferEventIds.length
    + (roots.payrollRunIds?.length ?? 0) + (roots.depositIds?.length ?? 0);
  if (named === 0) refuseIn(run, "NO_ROOTS", "roots", "no root was named");
  await loadInOrder(run, "sales", roots.saleIds, "a sale root", (r) => (r.isDeleted === true && r.status === "CANCELLED" ? null : "a sale root is not deleted and cancelled"));
  await loadInOrder(run, "financeApplications", roots.applicationIds, "an application root", (r) => (r.status === "CANCELLED" ? null : "an application root is not CANCELLED"));
  await loadInOrder(run, "expenses", roots.expenseIds, "an expense root", (r) => (r.isDeleted === true ? null : "an expense root is not deleted"));
  await loadInOrder(run, "accountingEvents", roots.transferEventIds, "a transfer root", (r) =>
    (r.eventType === "TREASURY_TRANSFER" && r.status === "REVERSED" ? null : "a transfer root is not a REVERSED treasury transfer"));
  await loadInOrder(run, "payrollRuns", roots.payrollRunIds ?? [], "a payroll run root", (r) => (r.status === "CANCELLED" ? null : "a payroll run root is not CANCELLED"));
  await loadInOrder(run, "deposits", roots.depositIds ?? [], "a deposit root", () => null); // eligibility is proveExplicitRoots' job
}
