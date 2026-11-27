/**
 * SCRUM-1023 Phase 1: the read budget of the purge dry run.
 *
 * Convex limits one query to 32,000 documents scanned, 16 MiB read and 4,096 index
 * ranges (every `db.get` and every `db.query` counts as one), within one second
 * of user code (https://docs.convex.dev/production/state/limits). The manifest
 * budgets documents and ranges (not bytes: the 16 MiB read limit is NOT budgeted, and
 * exceeding it fails closed with the generic error of `previewPurge`). It stops at the
 * FIRST exhausted budget: a reader asks `reserve` before a read and `room` before a
 * scan, and when either says no the dry run ends with a structured OVER_BOUND refusal
 * instead of an uncaught error that would swallow every other refusal reason.
 */

export interface PurgeLimits {
  /** Largest table the scan reads completely; a bigger table refuses (a partial scan would miss rows). */
  perTableCap: number;
  /** Documents read in total. */
  totalDocs: number;
  /** Index ranges (db.get + db.query calls) in total. */
  totalRanges: number;
}

export const DEFAULT_PURGE_LIMITS: PurgeLimits = {
  perTableCap: 6000,
  totalDocs: 24_000,
  totalRanges: 3500,
};

export class ReadBudget {
  docs = 0;
  ranges = 0;
  exhausted = false;

  constructor(readonly limits: PurgeLimits = DEFAULT_PURGE_LIMITS) {}

  /** Marks the budget spent (a reader found no room): every later reader stops instead of trying. */
  stop(): void {
    this.exhausted = true;
  }

  /** Documents still allowed. */
  room(): number {
    return Math.max(0, this.limits.totalDocs - this.docs);
  }

  /** Reserves index ranges BEFORE a read. False (and exhausted) when the read must not happen: no ranges or no documents left. */
  reserve(ranges = 1): boolean {
    if (this.exhausted || this.ranges + ranges > this.limits.totalRanges || this.room() === 0) {
      this.exhausted = true;
      return false;
    }
    this.ranges += ranges;
    return true;
  }

  /** Counts documents read. Clamped to the room, so the counter never claims more than the budget. */
  record(docs: number): boolean {
    const over = this.docs + docs > this.limits.totalDocs;
    this.docs = Math.min(this.limits.totalDocs, this.docs + docs);
    if (over) this.exhausted = true;
    return !over;
  }
}
