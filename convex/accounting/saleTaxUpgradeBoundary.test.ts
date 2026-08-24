import { describe, expect, test } from "vitest";
import {
  ruleSaleCompleted,
  ruleSaleCancelled,
  validateBalance,
  SaleCompletedPayload,
  SaleCancelledPayload,
} from "./postingRules";
import { SYSTEM_KEYS } from "../utils/defaultChart";

/**
 * The upgrade boundary of the SCRUM-22 tax-convention change.
 *
 * `ownedSaleTaxPosting.test.ts` pins what the NEW convention posts. It cannot
 * see the problem these tests exist for, because that one only ever evaluates a
 * payload built by the current emitter.
 *
 * Outbox entries outlive deploys. `postOrEnqueue` (accounting/workflowHooks.ts)
 * stores the RAW payload in `pendingAccountingEvents` whenever the chart is not
 * initialized or no period is open for the sale date, and the outbox later
 * replays it through whatever `ruleSaleCompleted` says AT DRAIN TIME. Meanwhile
 * `applySaleCompletionSideEffects` writes the canonical receivable
 * unconditionally, in the same mutation as the sale, sized by the
 * `customerBillableMinor` of the code that was deployed THEN.
 *
 * So a taxed sale completed before this release with a closed period leaves a
 * receivable sized WITHOUT tax and a queued payload that, after deploy, would
 * post an AR debit WITH tax. The GL and the subledger would then disagree about
 * one customer's bill by exactly the tax, permanently — allocation is capped by
 * the receivable, so paying the invoice in full cannot clear the GL. That is
 * the very invariant this ticket exists to protect, broken in the opposite
 * direction for in-flight rows.
 *
 * The fix is the same one `consignmentEvaluated` already established for this
 * exact class of problem on this exact payload: the emitter stamps a marker, so
 * the rule can tell an event written under the new convention from one that
 * predates it, and a legacy event posts on the basis it was WRITTEN for.
 */

const jod = (major: number): number => Math.round(major * 1000);

/** Net movement on an account across the whole entry: debits minus credits. */
function net(result: { lines: { accountSystemKey: string; debitMinor: number; creditMinor: number }[] }, key: string): number {
  return result.lines
    .filter((l) => l.accountSystemKey === key)
    .reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0);
}

/**
 * What `hookSaleCompleted` enqueued BEFORE this release: real tax, and no
 * `taxConventionExclusive` marker, because the field did not exist yet.
 */
const legacyQueued: SaleCompletedPayload = {
  saleId: "sale_legacy_queued",
  saleAmountMinor: jod(20_000),
  currency: "JOD",
  customerId: "cust_1",
  vehicleId: "veh_1",
  salespersonId: "user_1",
  taxMinor: jod(3_200),
  consignmentEvaluated: true,
};

/** The same sale as the current emitter writes it. */
const currentEmitter: SaleCompletedPayload = {
  ...legacyQueued,
  saleId: "sale_current",
  taxConventionExclusive: true,
};

describe("a payload queued before the convention changed posts on the basis it was written for", () => {
  test("a legacy queued taxed sale debits AR the tax-INCLUSIVE price, matching the receivable it was raised with", () => {
    const result = ruleSaleCompleted(legacyQueued);

    // The receivable that accompanies this payload was sized by the OLD
    // `customerBillableMinor`, which excluded the tax. 20,000 is what that
    // document says the customer owes, so 20,000 is what AR must carry — or the
    // subledger can never clear the GL.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(20_000));
    // Old convention: the price was read as tax-inclusive, so revenue is the
    // price less the tax. Deliberately NOT the new arithmetic — restating a
    // legacy event is `migrateConsignedSaleBasis`'s job, not this rule's.
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(16_800));
    expect(net(result, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(-jod(3_200));
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("the marker is what distinguishes them: the same sale from the current emitter bills the tax on top", () => {
    // Anti-vacuity. Without this, the assertion above would pass just as well
    // if the rule had simply reverted to the old convention for everything,
    // which is the opposite of what SCRUM-22 does.
    const result = ruleSaleCompleted(currentEmitter);

    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(23_200));
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
    expect(net(result, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(-jod(3_200));
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("a legacy payload whose tax equals its price still posts, instead of dead-lettering", () => {
    // The legacy branch recomputes `price - tax` as revenue, which is zero when
    // the two are equal. The revenue line was emitted unconditionally, and
    // `validateBalance` refuses a line with neither a debit nor a credit — so
    // the drain threw, the outbox retried, and after MAX_ATTEMPTS the event went
    // FAILED. A real sale never reached the general ledger at all.
    //
    // Reachable precisely because the pre-deploy code had no tax ceiling: a
    // sale could be completed with tax equal to (or above) its price and queued
    // against a closed period. The entry is perfectly good without the empty
    // line — AR carries the price, the tax payable carries the same amount, and
    // they balance.
    const result = ruleSaleCompleted({ ...legacyQueued, taxMinor: jod(20_000) });

    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(20_000));
    expect(net(result, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(-jod(20_000));
    // Not "zero net on revenue" — the LINE must be absent. A 0/0 line nets to
    // zero too, and that is exactly the shape validateBalance rejects.
    expect(result.lines.some((l) => l.accountSystemKey === SYSTEM_KEYS.SALES_REVENUE)).toBe(false);
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("an ordinary legacy payload still carries its revenue line", () => {
    // ANTI-VACUITY for the assertion above: dropping the revenue line whenever
    // it was inconvenient would pass that test while silently deleting revenue
    // from every legacy sale.
    const result = ruleSaleCompleted(legacyQueued);
    expect(result.lines.some((l) => l.accountSystemKey === SYSTEM_KEYS.SALES_REVENUE)).toBe(true);
  });

  test("a negative tax is refused, not silently clamped to nothing", () => {
    // `main` refused this by accident — `saleAmount - (-100)` inflated revenue
    // with no matching tax line, so credits exceeded debits and validateBalance
    // threw. Clamping to 0 would balance the entry and discard the number, so a
    // payload asserting something impossible would post as if it had asserted
    // nothing. Unreachable today through `validations/sales.ts`, which is
    // exactly why keeping it closed is cheap.
    expect(() => ruleSaleCompleted({ ...legacyQueued, taxMinor: -100 })).toThrow(/negative/i);
    expect(() => ruleSaleCompleted({ ...currentEmitter, taxMinor: -100 })).toThrow(/negative/i);
  });

  test("a zero-tax legacy payload is unaffected — the two conventions only differ when tax exists", () => {
    const { taxMinor: _dropped, ...untaxed } = legacyQueued;
    const result = ruleSaleCompleted(untaxed);

    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(20_000));
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
  });
});

/**
 * `ruleSaleCancelled` stays on the OLD convention on purpose: it is reachable
 * only by an event queued before `hookSaleCancelled` became a reversal hook,
 * and such an event must reverse what the old convention actually posted.
 *
 * `saleTaxConventionGuard.test.ts` scans the source for an emitter, which is
 * good but structurally cannot see a DYNAMIC one — `accountingMigration.ts`
 * already dispatches `postAccountingEvent` with a variable `eventType`, so a
 * future caller passing `SALE_CANCELLED` through a variable would slip past a
 * literal source scan while the suite stayed green.
 *
 * So the boundary is enforced at RUNTIME as well, where it cannot be evaded:
 * a cancellation payload carrying the new-convention marker was produced under
 * an arithmetic this rule does not implement, and posting it would strand the
 * tax in AR and revenue forever. Refuse it instead.
 */
describe("the divergent cancellation convention refuses a new-convention payload at runtime", () => {
  const cancelled: SaleCancelledPayload = {
    saleId: "sale_cancel_1",
    saleAmountMinor: jod(20_000),
    currency: "JOD",
    customerId: "cust_1",
    vehicleId: "veh_1",
    salespersonId: "user_1",
    taxMinor: jod(3_200),
  };

  test("a cancellation marked as new-convention is refused rather than mis-reversed", () => {
    expect(() =>
      ruleSaleCancelled({ ...cancelled, taxConventionExclusive: true })
    ).toThrow(/convention/i);
  });

  test("a legacy cancellation still reverses on the old convention", () => {
    // Positive control: the refusal above must be caused by the MARKER, not by
    // the presence of tax. Without this, making the rule throw on any taxed
    // cancellation would pass the test above while breaking the only path this
    // rule exists to serve.
    const result = ruleSaleCancelled(cancelled);

    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(-jod(20_000));
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(jod(16_800));
    expect(net(result, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(jod(3_200));
    expect(() => validateBalance(result.lines)).not.toThrow();
  });
});
