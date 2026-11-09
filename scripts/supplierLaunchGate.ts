/** Counts-only P7 release phase. I/O stays in the existing credential-bound CLI adapter. */
import { z } from "zod";
import { SUPPLIER_LAUNCH_PAGE_SIZE } from "../convex/utils/supplierLaunchRegistry.ts";

const TABLES = ["vehicleSupplierPayables", "vehicleSupplierReceivables", "supplierCostRecoveries",
  "supplierCostRecoveryReceipts", "openingPayablePayments", "vehicles", "vehicleOwnershipConversions",
  "financeApplications", "expenses", "vehicleEdits", "openingBalanceDrafts"] as const;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const countsSchema = z.object({ MISSING_SUPPLIER_ID: count, MISSING_PAYEE_ID: count,
  MISSING_BEARER_ID: count, MISSING_SOURCE: count }).strict();
const pageSchema = z.object({ status: z.enum(["MORE", "READY"]), cursor: z.string().min(1).nullable(),
  examined: count.max(SUPPLIER_LAUNCH_PAGE_SIZE), counts: countsSchema }).strict();
type Counts = z.infer<typeof countsSchema>;
type Table = typeof TABLES[number];
type Input = {
  runPage: (args: { table: Table; cursor: string | null }) => { ok: boolean; value?: unknown };
  now: () => number; startedAt: number; timeoutMs: number; maxPages: number;
};
type Result = { ok: true; counts: Record<string, Counts> } |
  { ok: false; code: "SUPPLIER_EVIDENCE_UNAVAILABLE" } |
  { ok: false; code: "SUPPLIER_IDENTITY_UNRESOLVED"; counts: Record<string, Counts> };
const unavailable = { ok: false, code: "SUPPLIER_EVIDENCE_UNAVAILABLE" } as const;
const emptyCounts = (): Counts => ({ MISSING_SUPPLIER_ID: 0, MISSING_PAYEE_ID: 0, MISSING_BEARER_ID: 0, MISSING_SOURCE: 0 });

function readPage(input: Input, table: Table, cursor: string | null) {
  if (input.now() - input.startedAt >= input.timeoutMs) return null;
  const response = input.runPage({ table, cursor });
  if (!response.ok) return null;
  const parsed = pageSchema.safeParse(response.value);
  if (!parsed.success || input.now() - input.startedAt >= input.timeoutMs) return null;
  if (parsed.data.status === "READY" && parsed.data.cursor !== null) return null;
  return parsed.data;
}

function addCounts(total: Counts, page: z.infer<typeof pageSchema>): boolean {
  for (const reason of Object.keys(total) as (keyof Counts)[]) {
    if (page.counts[reason] > page.examined || !Number.isSafeInteger(total[reason] + page.counts[reason])) return false;
    total[reason] += page.counts[reason];
  }
  return true;
}

function readTable(input: Input, table: Table): Counts | null {
  const total = emptyCounts();
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < input.maxPages; pageNumber += 1) {
    const page = readPage(input, table, cursor);
    if (!page || !addCounts(total, page)) return null;
    if (page.status === "READY") return total;
    if (!page.cursor || seen.has(page.cursor)) return null;
    seen.add(page.cursor);
    cursor = page.cursor;
  }
  return null;
}

/** Partial results and CLI error text never leave this function. */
export function verifySupplierLaunchEvidence(input: Input): Result {
  const counts: Record<string, Counts> = {};
  if (!Number.isSafeInteger(input.maxPages) || input.maxPages < 1 || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) return unavailable;
  try {
    for (const table of TABLES) {
      const total = readTable(input, table);
      if (!total) return unavailable;
      counts[table] = total;
    }
    if (Object.values(counts).some(reasons => Object.values(reasons).some(value => value > 0))) {
      return { ok: false, code: "SUPPLIER_IDENTITY_UNRESOLVED", counts };
    }
    return { ok: true, counts };
  } catch {
    return unavailable;
  }
}

/** P7 uses the same phase interface as the other release phases. */
export function runSupplierLaunchEvidencePhase(input: {
  convex: (args: string[]) => { ok: boolean; value?: unknown };
  now: () => number; startedAt: number; timeoutMs: number;
  fail: (reason: string) => never;
}): string {
  const evidence = verifySupplierLaunchEvidence({ ...input, maxPages: 100_000,
    runPage: args => input.convex(["run", "supplierLaunchEvidence:scanPage", JSON.stringify(args)]),
  });
  if (!evidence.ok) input.fail(`Production is DEPLOYED, but INCOMPLETE: supplier launch evidence ${evidence.code}.`);
  return `P7 launch census: ${JSON.stringify(evidence.counts)}`;
}
