/**
 * The commission outbox guard must fail CLOSED.
 *
 * `commissionPostingBlockedReason` decides whether a queued commission event may
 * post. Returning null means "not blocked" — it posts. Every path that cannot
 * PROVE its prerequisites are on the books must return a reason.
 *
 * These are unit tests against the guard itself rather than end-to-end drains,
 * deliberately. Driving these states through the product requires a specific
 * period layout, and a drain test can pass because the entry happened to be
 * held on its own period rather than by the rule under test — which is exactly
 * how an ordering bug survives a green suite.
 */
import { convexTestWithComponents } from "../../test-utils/convexTest";
import { expect, test, describe } from "vitest";
import schema from "../schema";
import { commissionPostingBlockedReason } from "./commissionSourceLedger";

async function seed(t: any, suffix: string) {
  return await t.run(async (ctx: any) => {
    const orgId = await ctx.db.insert("organizations", { name: `C ${suffix}`, createdAt: Date.now() });
    const otherOrgId = await ctx.db.insert("organizations", { name: `O ${suffix}`, createdAt: Date.now() });
    const userId = await ctx.db.insert("users", {
      clerkId: `csl_${suffix}`, email: `${suffix}@csl.example.com`, name: "Rep",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B" });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, make: "T", model: "M", year: 2024, mileage: 0, color: "Black",
      fuelType: "PETROL", transmission: "AUTOMATIC", sellingPrice: 30000, status: "SOLD",
    });
    const saleId = await ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId: userId, salePrice: 30000,
      saleDate: Date.now(), status: "COMPLETED", commissionAmount: 250,
    });
    const foreignSaleId = await ctx.db.insert("sales", {
      orgId: otherOrgId, vehicleId, customerId, salespersonId: userId, salePrice: 30000,
      saleDate: Date.now(), status: "COMPLETED", commissionAmount: 250,
    });
    return { orgId, otherOrgId, userId, saleId, foreignSaleId };
  });
}

/** Posts an event as the ledger would, so prerequisites can be satisfied selectively. */
async function postEvent(
  t: any,
  orgId: any,
  userId: any,
  eventType: string,
  idempotencyKey: string,
  sourceId: string,
  payload: Record<string, unknown>
) {
  await t.run(async (ctx: any) => {
    await ctx.db.insert("accountingEvents", {
      orgId, eventType, sourceType: "sales", sourceId, eventVersion: 1, idempotencyKey,
      occurredAt: Date.now(), accountingDate: Date.now(), currency: "USD",
      payload, status: "POSTED", createdBy: userId, createdAt: Date.now(),
    });
  });
}

const entry = (orgId: any, eventType: string, idempotencyKey: string, payload: Record<string, unknown>) => ({
  orgId, eventType, idempotencyKey, payload,
});

describe("commissionPostingBlockedReason", () => {
  test("blocks a correction whose accrual has not posted", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, saleId } = await seed(t, "adj_no_accrual");

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_ADJUSTED", `commission_adjusted_${saleId}_1`, {
          saleId, deltaMinor: -15000, currency: "USD",
        })
      )
    );
    expect(reason).toMatch(/accrual behind it has not posted/i);
  });

  test("blocks correction 2 while correction 1 is still unposted", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, userId, saleId } = await seed(t, "adj_gap");
    await postEvent(t, orgId, userId, "COMMISSION_ACCRUED", `commission_accrued_${saleId}`, `commission_${saleId}`, { saleId, amountMinor: 25000 });

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_ADJUSTED", `commission_adjusted_${saleId}_2`, {
          saleId, deltaMinor: 5000, currency: "USD",
        })
      )
    );
    expect(reason).toMatch(/correction behind it has not posted/i);
  });

  test("allows correction 1 once the accrual is posted — it must not wait for itself", async () => {
    // The sale's commissionAdjustmentSeq has already advanced past this entry,
    // so checking against that counter instead of the entry's own sequence
    // would make it a prerequisite of itself and hold it forever.
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, userId, saleId } = await seed(t, "adj_self");
    await t.run((ctx: any) => ctx.db.patch(saleId, { commissionAdjustmentSeq: 3 }));
    await postEvent(t, orgId, userId, "COMMISSION_ACCRUED", `commission_accrued_${saleId}`, `commission_${saleId}`, { saleId, amountMinor: 25000 });

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_ADJUSTED", `commission_adjusted_${saleId}_1`, {
          saleId, deltaMinor: 5000, currency: "USD",
        })
      )
    );
    expect(reason).toBeNull();
  });

  test("blocks a payment that clears more than was recognized", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, userId, saleId } = await seed(t, "pay_divergent");
    await postEvent(t, orgId, userId, "COMMISSION_ACCRUED", `commission_accrued_${saleId}`, `commission_${saleId}`, { saleId, amountMinor: 25000 });

    // Frozen at 90,000 by a raw sale edit before the payment was queued.
    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_PAID", `commission_paid_${saleId}`, {
          saleId, amountMinor: 90000, currency: "USD",
        })
      )
    );
    expect(reason).toMatch(/does not match what the ledger recognized/i);
  });

  test("allows a payment that matches accrual plus corrections", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, userId, saleId } = await seed(t, "pay_ok");
    await t.run((ctx: any) => ctx.db.patch(saleId, { commissionAdjustmentSeq: 1 }));
    await postEvent(t, orgId, userId, "COMMISSION_ACCRUED", `commission_accrued_${saleId}`, `commission_${saleId}`, { saleId, amountMinor: 25000 });
    await postEvent(t, orgId, userId, "COMMISSION_ADJUSTED", `commission_adjusted_${saleId}_1`, `commission_adj_${saleId}_1`, { saleId, deltaMinor: 15000 });

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_PAID", `commission_paid_${saleId}`, {
          saleId, amountMinor: 40000, currency: "USD",
        })
      )
    );
    expect(reason).toBeNull();
  });

  test("blocks any commission entry while the sale's own posting is still queued", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, userId, saleId } = await seed(t, "sale_queued");
    await t.run(async (ctx: any) => {
      await ctx.db.insert("pendingAccountingEvents", {
        orgId, kind: "POST", status: "PENDING",
        idempotencyKey: `sale_completed_${saleId}`, accountingDate: Date.now(),
        actorId: userId, attempts: 0, createdAt: Date.now(),
        eventType: "SALE_COMPLETED", sourceType: "sales", sourceId: saleId,
        eventVersion: 1, occurredAt: Date.now(), currency: "USD", payload: {},
      });
    });

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_ACCRUED", `commission_accrued_${saleId}`, {
          saleId, amountMinor: 25000, currency: "USD",
        })
      )
    );
    expect(reason).toMatch(/sale behind it has not posted/i);
  });

  test("does NOT block a legacy sale that never had a SALE_COMPLETED event", async () => {
    // Pre-hooks sales, and sales migrated by the accounting cutover (which posts
    // under migrate_<txId>), have no such event and never will. Blocking would
    // hold their accrual permanently — held entries never dead-letter, so
    // nothing in the product could ever clear them.
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, saleId } = await seed(t, "legacy");

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_ACCRUED", `commission_accrued_${saleId}`, {
          saleId, amountMinor: 25000, currency: "USD",
        })
      )
    );
    expect(reason).toBeNull();
  });

  test("blocks when the sale belongs to another organization", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, foreignSaleId } = await seed(t, "crossorg");

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_PAID", `commission_paid_${foreignSaleId}`, {
          saleId: foreignSaleId, amountMinor: 25000, currency: "USD",
        })
      )
    );
    expect(reason).toMatch(/could not be resolved/i);
  });

  test("blocks a payment carrying no amount", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, userId, saleId } = await seed(t, "pay_no_amount");
    await postEvent(t, orgId, userId, "COMMISSION_ACCRUED", `commission_accrued_${saleId}`, `commission_${saleId}`, { saleId, amountMinor: 25000 });

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_PAID", `commission_paid_${saleId}`, { saleId, currency: "USD" })
      )
    );
    expect(reason).toMatch(/carries no amount/i);
  });

  test("blocks rather than iterating when the correction count is implausible", async () => {
    // commissionAdjustmentSeq is a plain number on a row the admin raw-JSON
    // editor can write, and this guard runs on the outbox's hot path. Walking
    // it unbounded turns one queued entry into a multi-million-read loop that
    // blows the transaction — taking every unrelated entry in the org with it.
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, userId, saleId } = await seed(t, "huge_seq");
    await t.run((ctx: any) => ctx.db.patch(saleId, { commissionAdjustmentSeq: 5_000_000 }));
    await postEvent(t, orgId, userId, "COMMISSION_ACCRUED", `commission_accrued_${saleId}`, `commission_${saleId}`, { saleId, amountMinor: 25000 });

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_PAID", `commission_paid_${saleId}`, {
          saleId, amountMinor: 25000, currency: "USD",
        })
      )
    );
    expect(reason).toMatch(/not a usable number/i);
  });

  test("blocks a payment recognized in a different currency instead of calling it a mismatch", async () => {
    // Defence in depth, not a reachable workflow: orgSettings.upsert hard-locks
    // the currency once any accountingEvents / pendingAccountingEvents /
    // transactions / compensation / advance / expense row exists, and a
    // commission accrual creates one. Only a direct database edit produces this
    // state. Minor units mean nothing without their scale, so a JOD accrual of
    // 100000 against a USD amount of 10000 is not a wrong number — it is a
    // different unit, and it needs a different message and a human.
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, userId, saleId } = await seed(t, "currency_switch");
    await t.run(async (ctx: any) => {
      await ctx.db.insert("accountingEvents", {
        orgId, eventType: "COMMISSION_ACCRUED", sourceType: "sales",
        sourceId: `commission_${saleId}`, eventVersion: 1,
        idempotencyKey: `commission_accrued_${saleId}`,
        occurredAt: Date.now(), accountingDate: Date.now(), currency: "JOD",
        payload: { saleId, amountMinor: 100000, currency: "JOD" },
        status: "POSTED", createdBy: userId, createdAt: Date.now(),
      });
    });

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_PAID", `commission_paid_${saleId}`, {
          saleId, amountMinor: 10000, currency: "USD",
        })
      )
    );
    expect(reason).toMatch(/different currency/i);
  });

  test("blocks a correction whose sequence cannot be read from its key", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, userId, saleId } = await seed(t, "bad_key");
    await postEvent(t, orgId, userId, "COMMISSION_ACCRUED", `commission_accrued_${saleId}`, `commission_${saleId}`, { saleId, amountMinor: 25000 });

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_ADJUSTED", "commission_adjusted_malformed", {
          saleId, deltaMinor: 5000, currency: "USD",
        })
      )
    );
    expect(reason).toMatch(/sequence could not be read/i);
  });

  test("blocks an entry carrying no sale reference", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId } = await seed(t, "no_sale_ref");

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "COMMISSION_PAID", "commission_paid_x", { amountMinor: 1, currency: "USD" })
      )
    );
    expect(reason).toMatch(/carries no sale reference/i);
  });

  test("ignores events that are not commission events", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
    const { orgId, saleId } = await seed(t, "other");

    const reason = await t.run((ctx: any) =>
      commissionPostingBlockedReason(
        ctx,
        entry(orgId, "SALE_COMPLETED", `sale_completed_${saleId}`, { saleId })
      )
    );
    expect(reason).toBeNull();
  });
});
