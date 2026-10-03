/**
 * SCRUM-555 part 4 — `accountingCutover.ts` and `accountingMigration.ts` read
 * through indexes instead of query field predicates. Only the READ MECHANISM
 * changed: which journal / event is treated as "the" match must be exactly what
 * it was. Every case puts the non-matching rows BEFORE the matching one so the
 * index order is part of what is being pinned.
 *
 * Characterization tests: they pass on the pre-image and the post-image.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

type TestConvex = ReturnType<typeof convexTestWithComponents>;

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `OB Reads Dealer ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `owner_${tag}`, email: `${tag}@example.com`, name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: ["view:finance", "manage:finance", "view:vehicles", "edit:vehicles"],
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const asOwner = t.withIdentity({ subject: `owner_${tag}`, clerkId: `owner_${tag}` });
  return { t, orgId, userId, asOwner };
}

type Dealer = Awaited<ReturnType<typeof seedDealer>>;

type JournalStatus = "DRAFT" | "VALIDATED" | "POSTED" | "REVERSED";
type JournalCategory = "SYSTEM" | "MANUAL" | "REVERSAL" | "ADJUSTMENT" | "OPENING_BALANCE";

let journalSeq = 0;
async function insertJournal(
  t: TestConvex,
  args: {
    orgId: Id<"organizations">;
    postedBy: Id<"users">;
    category: JournalCategory;
    status: JournalStatus;
  }
) {
  journalSeq += 1;
  return await t.run((ctx) =>
    ctx.db.insert("journalEntries", {
      orgId: args.orgId,
      journalNumber: `OBR-${journalSeq}`,
      accountingDate: Date.UTC(2026, 0, 1),
      sourceType: "cutover",
      sourceId: `obr-${journalSeq}`,
      category: args.category,
      memo: "characterization row",
      status: args.status,
      currency: "JOD",
      postedBy: args.postedBy,
      postedAt: Date.now(),
      createdAt: Date.now(),
    })
  );
}

/** Journals that must never count as a posted opening balance, inserted first. */
async function insertNonMatchingJournals(d: Dealer, postedBy: Id<"users">) {
  const { t, orgId } = d;
  await insertJournal(t, { orgId, postedBy, category: "OPENING_BALANCE", status: "DRAFT" });
  await insertJournal(t, { orgId, postedBy, category: "OPENING_BALANCE", status: "VALIDATED" });
  await insertJournal(t, { orgId, postedBy, category: "OPENING_BALANCE", status: "REVERSED" });
  await insertJournal(t, { orgId, postedBy, category: "SYSTEM", status: "POSTED" });
  await insertJournal(t, { orgId, postedBy, category: "MANUAL", status: "POSTED" });
  // Another org's posted opening balance shares the table but not the index range.
  const otherOrgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Other OB org", createdAt: Date.now() })
  );
  await insertJournal(t, { orgId: otherOrgId, postedBy, category: "OPENING_BALANCE", status: "POSTED" });
}

async function setUpPostingPrerequisites(d: Dealer) {
  const { t, orgId, asOwner } = d;
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(2020, 0, 1),
    endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999),
    fiscalYear: 2026,
    periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const accounts = await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect()
  );
  const usable = accounts.filter((a) => a.active).slice(0, 2);
  expect(usable.length).toBe(2);
  return {
    lines: [
      { accountId: usable[0]._id, debitMinor: 1_000_000, creditMinor: 0 },
      { accountId: usable[1]._id, debitMinor: 0, creditMinor: 1_000_000 },
    ],
  };
}

describe("hasOpeningBalanceCommitment (via draftOpeningBalance) / hasOpeningBalance / openingBalanceStatus", () => {
  test("DRAFT, VALIDATED, REVERSED, non-OPENING_BALANCE and other-org journals do not count", async () => {
    const d = await seedDealer("c1");
    await insertNonMatchingJournals(d, d.userId);
    const { lines } = await setUpPostingPrerequisites(d);

    await expect(d.asOwner.query(api.accountingCutover.hasOpeningBalance, { orgId: d.orgId })).resolves.toBe(false);
    const status = await d.asOwner.query(api.accountingCutover.openingBalanceStatus, { orgId: d.orgId });
    expect(status.posted).toBe(false);

    // hasOpeningBalanceCommitment found nothing, so the draft is accepted.
    const draft = await d.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
      orgId: d.orgId,
      lines,
      asOfDate: Date.UTC(2026, 0, 1),
      expectedCurrency: "JOD",
    });
    expect(draft.draftId).toBeTruthy();
  });

  test("a POSTED OPENING_BALANCE journal after the non-matching ones counts everywhere", async () => {
    const d = await seedDealer("c2");
    await insertNonMatchingJournals(d, d.userId);
    const { lines } = await setUpPostingPrerequisites(d);
    await insertJournal(d.t, { orgId: d.orgId, postedBy: d.userId, category: "OPENING_BALANCE", status: "POSTED" });

    await expect(d.asOwner.query(api.accountingCutover.hasOpeningBalance, { orgId: d.orgId })).resolves.toBe(true);
    const status = await d.asOwner.query(api.accountingCutover.openingBalanceStatus, { orgId: d.orgId });
    expect(status.posted).toBe(true);

    await expect(
      d.asOwner.mutation(api.accountingCutover.draftOpeningBalance, {
        orgId: d.orgId,
        lines,
        asOfDate: Date.UTC(2026, 0, 1),
        expectedCurrency: "JOD",
      })
    ).rejects.toThrow(/already been posted or is awaiting approval/);
  });
});

describe("signOffCutover opening-balance segregation of duties", () => {
  test("non-matching journals posted by the signer do not block the sign-off", async () => {
    const d = await seedDealer("s1");
    await insertNonMatchingJournals(d, d.userId);

    const result = await d.asOwner.mutation(api.accountingCutover.signOffCutover, { orgId: d.orgId });
    expect(result.signOffId).toBeTruthy();
  });

  test("a POSTED opening balance posted by the signer refuses the sign-off", async () => {
    const d = await seedDealer("s2");
    await insertNonMatchingJournals(d, d.userId);
    await insertJournal(d.t, { orgId: d.orgId, postedBy: d.userId, category: "OPENING_BALANCE", status: "POSTED" });

    await expect(
      d.asOwner.mutation(api.accountingCutover.signOffCutover, { orgId: d.orgId })
    ).rejects.toThrow(/signer must be different from whoever approved and posted the opening balance/);
  });

  test("a POSTED opening balance posted by someone else allows the sign-off", async () => {
    const d = await seedDealer("s3");
    const otherUserId = await d.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "other_poster_s3", email: "poster.s3@example.com", name: "Poster" })
    );
    await insertNonMatchingJournals(d, d.userId);
    await insertJournal(d.t, { orgId: d.orgId, postedBy: otherUserId, category: "OPENING_BALANCE", status: "POSTED" });

    const result = await d.asOwner.mutation(api.accountingCutover.signOffCutover, { orgId: d.orgId });
    expect(result.signOffId).toBeTruthy();
  });
});

describe("backfillVehicleInventoryOpeningBalances (dry run)", () => {
  async function seedVehicle(d: Dealer, vin: string, purchasePrice: number, landedCostTotal?: number) {
    return await d.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: d.orgId,
        vin,
        make: "Toyota",
        model: "RAV4",
        year: 2025,
        mileage: 100,
        color: "Silver",
        fuelType: "Gasoline",
        transmission: "Automatic",
        purchasePrice,
        sellingPrice: purchasePrice * 2,
        status: "AVAILABLE",
        ...(landedCostTotal !== undefined ? { landedCostTotal } : {}),
      })
    );
  }

  async function insertEvent(
    d: Dealer,
    args: {
      eventType: string;
      sourceType: string;
      sourceId: string;
      status: "PENDING" | "POSTED" | "FAILED" | "REVERSED";
      payload?: unknown;
    }
  ) {
    const key = `${args.eventType}-${args.sourceId}-${args.status}-${Math.random()}`;
    await d.t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId: d.orgId,
        eventType: args.eventType,
        sourceType: args.sourceType,
        sourceId: args.sourceId,
        eventVersion: 1,
        idempotencyKey: key,
        occurredAt: Date.now(),
        accountingDate: Date.now(),
        currency: "JOD",
        payload: args.payload ?? {},
        status: args.status,
        createdBy: d.userId,
        createdAt: Date.now(),
      })
    );
  }

  async function dryRun(d: Dealer) {
    const res = await d.asOwner.mutation(api.accountingMigration.backfillVehicleInventoryOpeningBalances, {
      orgId: d.orgId,
      dryRun: true,
    });
    return new Map(res.results.map((r) => [r.vehicleId, r]));
  }

  test("only POSTED landed-cost events reduce the uncapitalized base", async () => {
    const d = await seedDealer("m1");
    const vehicleId = await seedVehicle(d, "OBRM1VEH000001", 10000, 500);
    const payload = (deltaMinor: number) => ({ vehicleId: vehicleId.toString(), deltaMinor });
    // The non-POSTED events come first in index order; counting them would
    // change the base from 10_000_000 to 9_700_000.
    await insertEvent(d, {
      eventType: "VEHICLE_LANDED_COST_CAPITALIZED",
      sourceType: "vehicles",
      sourceId: "landed-pending",
      status: "PENDING",
      payload: payload(200_000),
    });
    await insertEvent(d, {
      eventType: "VEHICLE_LANDED_COST_CAPITALIZED",
      sourceType: "vehicles",
      sourceId: "landed-failed",
      status: "FAILED",
      payload: payload(100_000),
    });
    await insertEvent(d, {
      eventType: "VEHICLE_LANDED_COST_CAPITALIZED",
      sourceType: "vehicles",
      sourceId: "landed-posted",
      status: "POSTED",
      payload: payload(500_000),
    });

    const row = (await dryRun(d)).get(vehicleId.toString());
    expect(row?.action).toBe("WOULD_POST");
    // purchase 10000 + landed 500 - posted delta 500 = 10000 JOD = 10_000_000 fils.
    expect(row?.amountMinor).toBe(10_000_000);
  });

  test("VEHICLE_ACQUIRED or VEHICLE_INVENTORY_OPENING_BALANCE marks a vehicle already_posted; other events do not", async () => {
    const d = await seedDealer("m2");
    const acquired = await seedVehicle(d, "OBRM2VEHA00001", 5000);
    const opening = await seedVehicle(d, "OBRM2VEHB00001", 5000);
    const otherOnly = await seedVehicle(d, "OBRM2VEHC00001", 5000);
    const otherOrgSource = await seedVehicle(d, "OBRM2VEHD00001", 5000);

    // Non-matching event types first, then the matching one, per vehicle.
    for (const id of [acquired, opening, otherOnly]) {
      await insertEvent(d, {
        eventType: "SOMETHING_ELSE",
        sourceType: "vehicles",
        sourceId: id.toString(),
        status: "POSTED",
      });
    }
    await insertEvent(d, {
      eventType: "VEHICLE_ACQUIRED",
      sourceType: "vehicles",
      sourceId: acquired.toString(),
      status: "POSTED",
    });
    await insertEvent(d, {
      eventType: "VEHICLE_INVENTORY_OPENING_BALANCE",
      sourceType: "vehicles",
      sourceId: opening.toString(),
      status: "POSTED",
    });
    // Right event type, wrong source family: not this vehicle's acquisition.
    await insertEvent(d, {
      eventType: "VEHICLE_ACQUIRED",
      sourceType: "transactions",
      sourceId: otherOrgSource.toString(),
      status: "POSTED",
    });

    const rows = await dryRun(d);
    expect(rows.get(acquired.toString())).toMatchObject({ action: "SKIP", reason: "already_posted" });
    expect(rows.get(opening.toString())).toMatchObject({ action: "SKIP", reason: "already_posted" });
    expect(rows.get(otherOnly.toString())?.action).toBe("WOULD_POST");
    expect(rows.get(otherOrgSource.toString())?.action).toBe("WOULD_POST");
  });

  test("an expense counts as posted only with a POSTED EXPENSE_POSTED event", async () => {
    const d = await seedDealer("m3");
    // Zero-cost vehicles, so the only thing that can move is the expense handling.
    const postedVehicle = await seedVehicle(d, "OBRM3VEHA00001", 0);
    const unpostedVehicle = await seedVehicle(d, "OBRM3VEHB00001", 0);
    const insertExpense = (vehicleId: Id<"vehicles">) =>
      d.t.run((ctx) =>
        ctx.db.insert("expenses", {
          orgId: d.orgId,
          vehicleId,
          title: "Brake job",
          amount: 100,
          date: Date.UTC(2026, 0, 15),
          category: "REPAIR",
          status: "PAID",
        })
      );
    const postedExpense = await insertExpense(postedVehicle);
    const unpostedExpense = await insertExpense(unpostedVehicle);

    // Posted expense: non-matching events first, then the matching POSTED one.
    await insertEvent(d, {
      eventType: "EXPENSE_POSTED",
      sourceType: "expenses",
      sourceId: postedExpense.toString(),
      status: "PENDING",
    });
    await insertEvent(d, {
      eventType: "SOMETHING_ELSE",
      sourceType: "expenses",
      sourceId: postedExpense.toString(),
      status: "POSTED",
    });
    await insertEvent(d, {
      eventType: "EXPENSE_POSTED",
      sourceType: "expenses",
      sourceId: postedExpense.toString(),
      status: "POSTED",
    });
    // Unposted expense: only a FAILED EXPENSE_POSTED and a POSTED other event.
    await insertEvent(d, {
      eventType: "EXPENSE_POSTED",
      sourceType: "expenses",
      sourceId: unpostedExpense.toString(),
      status: "FAILED",
    });
    await insertEvent(d, {
      eventType: "SOMETHING_ELSE",
      sourceType: "expenses",
      sourceId: unpostedExpense.toString(),
      status: "POSTED",
    });

    const rows = await dryRun(d);
    // Posted with no open period to reclassify in: flagged for manual review.
    expect(rows.get(postedVehicle.toString())).toMatchObject({
      action: "NEEDS_REVIEW",
      manualReviewExpenseIds: [postedExpense.toString()],
    });
    // Never posted: folded into the opening balance (100 JOD = 100_000 fils).
    expect(rows.get(unpostedVehicle.toString())).toMatchObject({
      action: "WOULD_POST",
      amountMinor: 100_000,
      manualReviewExpenseIds: [],
    });
  });
});
