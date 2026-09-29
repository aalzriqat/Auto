import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { documentBytes, isStoredVersion } from "./custodySourceLedger";
import { MAX_FEE_DOC_BYTES } from "./feeDocLimits";
import { handoverDirectPostKey, handoverPaymentState } from "./handoverCostPayment";

/**
 * The direct-payment family's closing proof (SCRUM-443), and the caps that make
 * it finishable.
 *
 * ## The rule it judges
 *
 * For every line of an application that has EVER carried a direct payment —
 * live, zeroed or voided — the only POSTED `HANDOVER_COST_PAID_DIRECT` version
 * is the live payment's own, and a live paid line's version MUST be POSTED.
 *
 * ## What it reads, and why that is bounded
 *
 * The family of one line is read by INDEX — `by_org_event_source_version`,
 * `eq(orgId).eq(eventType).eq(sourceType).eq(sourceId)` — so it is exactly the
 * line's forward events and nothing else. A reversal is a `JOURNAL_REVERSAL`
 * event under its own key (`accounting/reversals.ts`), so it is not in this
 * family, and no other event type shares the index range. One forward event per
 * version, at most `MAX_DIRECT_PAYMENT_VERSIONS` versions per line (the writer
 * refuses more), at most `MAX_DIRECT_PAID_LINES` lines (the writer refuses
 * more): the proof reads at most
 *
 *   documents = (N + 1) + N × (V + 1)         N = lines, V = versions
 *   bytes     = (N + 1) × MAX_FEE_DOC_BYTES + N × (V + 1) × MAX_DIRECT_EVENT_DOC_BYTES
 *
 * — the two expressions exported below, over caps the writers enforce, with the
 * fee document's own size capped at every writer (`feeDocLimits`). Anything a
 * writer could not have produced — a family with more rows than versions, a row
 * under a key that is not its version's canonical one, a version outside
 * `1..directPaymentVersion`, two rows for one version, a read past the budget —
 * fails CLOSED: the proof throws a `ConvexError`, which the closing check
 * reports as UNAVAILABLE, never READY.
 */

/** How many lines of one application may EVER carry a direct payment. A real handover has about 5-10 cost lines in all. */
export const MAX_DIRECT_PAID_LINES = 20;

/** How many payment versions one line may carry (a version is a payment reversed by an edit or void and re-recorded). */
export const MAX_DIRECT_PAYMENT_VERSIONS = 5;

/**
 * The largest stored `HANDOVER_COST_PAID_DIRECT` event document. Its payload
 * carries ids, two enums, an integer amount, the currency code and the payment
 * method — no free text — so the size is a property of the fixed fields; a test
 * measures the event at maximum field sizes against this.
 */
export const MAX_DIRECT_EVENT_DOC_BYTES = 2 * 1024;

/** The most documents one direct-payment proof reads: the ever-paid lines (+1 to detect overflow) and each line's family (+1 likewise). */
export const MAX_DIRECT_PROOF_DOCUMENTS =
  MAX_DIRECT_PAID_LINES + 1 + MAX_DIRECT_PAID_LINES * (MAX_DIRECT_PAYMENT_VERSIONS + 1);

/** The most bytes one direct-payment proof reads: those lines at `MAX_FEE_DOC_BYTES`, those events at `MAX_DIRECT_EVENT_DOC_BYTES`. */
export const MAX_DIRECT_PROOF_BYTES =
  (MAX_DIRECT_PAID_LINES + 1) * MAX_FEE_DOC_BYTES +
  MAX_DIRECT_PAID_LINES * (MAX_DIRECT_PAYMENT_VERSIONS + 1) * MAX_DIRECT_EVENT_DOC_BYTES;

const ACTION = "finalizing this deal";

/** The per-row caps the aggregate budget is derived from; each row the proof reads is held to its own. */
const FEE_ROW_CAP = { bytes: MAX_FEE_DOC_BYTES, what: "cost line" } as const;
const EVENT_ROW_CAP = { bytes: MAX_DIRECT_EVENT_DOC_BYTES, what: "direct-payment posting" } as const;

/** Counts every document the proof reads, in number and in exact platform bytes; refuses by name past either limit. */
export class DirectProofBudget {
  private docs = 0;
  private bytes = 0;

  constructor(
    private readonly documentLimit: number = MAX_DIRECT_PROOF_DOCUMENTS,
    private readonly byteLimit: number = MAX_DIRECT_PROOF_BYTES
  ) {}

  /**
   * Charges `rows`; when `perRowCap` is given, ALSO refuses (fail closed) any one
   * row past it. The aggregate budget is derived from the per-row caps, so a
   * single oversized row with aggregate headroom left is not a state the writers
   * can produce — it is a row nobody proved safe to read (SCRUM-443 v6, Sol F4).
   */
  charge(rows: ReadonlyArray<unknown>, perRowCap?: { bytes: number; what: string }): void {
    this.docs += rows.length;
    for (const row of rows) {
      const size = documentBytes(row);
      if (perRowCap !== undefined && size > perRowCap.bytes) {
        throw new ConvexError(
          `A ${perRowCap.what} on this deal is ${size.toLocaleString("en-US")} bytes, past the ${perRowCap.bytes.toLocaleString("en-US")} bytes no writer produces, so ${ACTION} cannot verify it completely; nothing has been changed. Have the record reviewed.`
        );
      }
      this.bytes += size;
    }
    if (this.docs > this.documentLimit || this.bytes > this.byteLimit) {
      throw new ConvexError(
        `This deal's direct handover payments carry more ledger history than ${ACTION} can verify completely (${this.docs} documents, ${this.bytes.toLocaleString("en-US")} bytes read); nothing has been changed. Have the deal's accounting reviewed.`
      );
    }
  }

  get documentsRead(): number {
    return this.docs;
  }
  get bytesRead(): number {
    return this.bytes;
  }
}

/**
 * Every line of an application that has ever carried a direct payment — from
 * ONE indexed query, `take(N + 1)`. `directPaymentVersion` is set by the one
 * writer that posts a payment and never unset, so `> 0` is exactly the
 * population; a voided or zeroed line stays in it.
 */
export async function loadDirectPaidLines(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">,
  budget: DirectProofBudget
): Promise<Array<Doc<"financeDealFees">>> {
  const rows = await ctx.db
    .query("financeDealFees")
    .withIndex("by_application_directPaymentVersion", (q) => q.eq("applicationId", applicationId).gt("directPaymentVersion", 0))
    .take(MAX_DIRECT_PAID_LINES + 1);
  budget.charge(rows, FEE_ROW_CAP);
  if (rows.length > MAX_DIRECT_PAID_LINES) {
    throw new ConvexError(
      `This deal has more than ${MAX_DIRECT_PAID_LINES} cost lines that have carried a direct payment, which is past what ${ACTION} can verify completely; nothing has been changed. Have the deal's accounting reviewed.`
    );
  }
  return rows;
}

/**
 * One line's forward `HANDOVER_COST_PAID_DIRECT` events, validated as a
 * canonical family or refused: at most `MAX_DIRECT_PAYMENT_VERSIONS` rows; each
 * under its version's own key; each version a whole number in
 * `1..highestVersion`; no version twice. `highestVersion` is the line's own
 * `directPaymentVersion` (what its writer says it ever used).
 */
export async function readDirectPaymentFamily(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  feeId: Id<"financeDealFees">,
  highestVersion: number,
  budget?: DirectProofBudget
): Promise<Map<number, Doc<"accountingEvents">>> {
  const rows = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_event_source_version", (q) =>
      q.eq("orgId", orgId).eq("eventType", "HANDOVER_COST_PAID_DIRECT").eq("sourceType", "financeDealFees").eq("sourceId", feeId.toString())
    )
    .take(MAX_DIRECT_PAYMENT_VERSIONS + 1);
  budget?.charge(rows, EVENT_ROW_CAP);
  if (rows.length > MAX_DIRECT_PAYMENT_VERSIONS) {
    throw new ConvexError(
      `A cost line on this deal has more than ${MAX_DIRECT_PAYMENT_VERSIONS} direct-payment postings on the ledger, which no writer produces and is past what ${ACTION} can verify completely; nothing has been changed. Have the record reviewed.`
    );
  }
  const family = new Map<number, Doc<"accountingEvents">>();
  for (const row of rows) {
    const version = row.eventVersion;
    if (!isStoredVersion(version) || version > highestVersion) {
      throw new ConvexError(
        `A direct-payment posting on this deal carries version ${String(version)}, which is not one of this cost line's payment versions (1 to ${highestVersion}), so ${ACTION} cannot tell what is on the books; nothing has been changed. Have the record reviewed.`
      );
    }
    if (row.idempotencyKey !== handoverDirectPostKey(feeId, version)) {
      throw new ConvexError(
        `A direct-payment posting on this deal is keyed ${row.idempotencyKey}, which is not the key its version promises, so ${ACTION} cannot tell what is on the books; nothing has been changed. Have the record reviewed.`
      );
    }
    if (family.has(version)) {
      throw new ConvexError(
        `A cost line on this deal has two direct-payment postings at version ${version}, which no writer produces, so ${ACTION} cannot tell what is on the books; nothing has been changed. Have the record reviewed.`
      );
    }
    family.set(version, row);
  }
  return family;
}

/**
 * The direct-payment proof of one application: the ids of the lines whose live
 * payment is not POSTED (`notOnLedger`) and of every line that still has a
 * version POSTED which is not its live one (`reversalPending`).
 */
export async function directPaymentLedgerProof(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">,
  liveFees: ReadonlyArray<Doc<"financeDealFees">>,
  budget: DirectProofBudget = new DirectProofBudget()
): Promise<{ notOnLedger: string[]; reversalPending: string[] }> {
  const everPaid = await loadDirectPaidLines(ctx, applicationId, budget);
  // A live line that carries a payment but was not enumerated (its version
  // counter absent) is still judged: the row's own claim is never skipped.
  const seen = new Set(everPaid.map((line) => line._id));
  const unenumerated = liveFees.filter((fee) => fee.directPayment !== undefined && !seen.has(fee._id));
  // Read by the caller, not charged here, but each is still held to the row cap.
  new DirectProofBudget(unenumerated.length, unenumerated.length * MAX_FEE_DOC_BYTES).charge(unenumerated, FEE_ROW_CAP);
  const lines = [...everPaid, ...unenumerated];

  const notOnLedger: string[] = [];
  const reversalPending: string[] = [];
  for (const line of lines) {
    const live = handoverPaymentState(line) === "PAID_DIRECT" ? line.directPayment : undefined;
    const highest = Math.max(line.directPaymentVersion ?? 0, live?.version ?? 0);
    if (!isStoredVersion(highest)) {
      throw new ConvexError(
        `A cost line's direct payment carries a version that is not a positive whole number (${String(highest)}), so ${ACTION} cannot tell which posting is live; nothing has been changed. Have the deal's accounting reviewed.`
      );
    }
    if (live !== undefined && live.version !== highest) {
      throw new ConvexError(
        `A cost line's direct payment names version ${live.version} while ${highest} is the latest ever used, so ${ACTION} cannot tell which posting is live; nothing has been changed. Have the deal's accounting reviewed.`
      );
    }
    const family = await readDirectPaymentFamily(ctx, orgId, line._id, highest, budget);
    if (live !== undefined && family.get(live.version)?.status !== "POSTED") notOnLedger.push(line._id as string);
    for (const [version, row] of family) {
      if (version !== live?.version && row.status === "POSTED") {
        reversalPending.push(line._id as string);
        break;
      }
    }
  }
  return { notOnLedger, reversalPending };
}
