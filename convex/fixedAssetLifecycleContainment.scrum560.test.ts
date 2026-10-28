/**
 * SCRUM-560 / SCRUM-760 owner ruling c23812, ruling 4: the fixed-asset lifecycle is OFF for the
 * Bloom Cars pilot (convex/utils/fixedAssetLifecycleContainment.ts), "including backend mutations
 * and scheduled posting/derecognition".
 *
 * Each public write door has an EXPECTED-REFUSAL cell. A cell passes only when:
 *   - the call goes through the door's own public entry, by an authorized actor, with valid arguments;
 *   - it asserts the stable containment code and the "Nothing has been changed" message;
 *   - a full snapshot of EVERY schema table is identical before and after (no fixedAssets row
 *     change, no fixedAssetEvents row, no journal line, no idempotency record: not a spot check);
 *   - driving the same call with the switch OFF succeeds (the item 2 mutation attack, run in-suite:
 *     it proves the refusal came from the switch and not from some unrelated validation).
 *
 * The cron cell proves the monthly run is a logged no-op: it posts nothing and does not throw.
 *
 * Evidence boundary: convex-test only. It is repository behaviour, not the Convex runtime, and not
 * the real-backend replay that SCRUM-762 requires.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedBank } from "../test-utils/bankFixture";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import type { FixedAssetLifecycleSwitchState } from "../test-utils/fixedAssetLifecycleSwitch";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/** Live handle on the switch; the shipped state is ON. Only this file's mock reads it. */
const switches = vi.hoisted(
  (): FixedAssetLifecycleSwitchState => ({
    lifecycleDisabled: true,
  })
);
vi.mock("./utils/fixedAssetLifecycleContainment", async (importOriginal) =>
  (await import("../test-utils/fixedAssetLifecycleSwitch")).withFixedAssetLifecycleSwitch(
    await importOriginal(),
    switches
  )
);

const MODULES = import.meta.glob("./**/*.ts");
const ALL_TABLES = Object.keys(schema.tables);
const CODE = "FIXED_ASSET_LIFECYCLE_DISABLED";
const PAST_PURCHASE_DATE = Date.UTC(2025, 11, 1);

/** Runs `fn` with the lifecycle OPEN (switch off), then restores the shipped state. */
async function withLifecycleOpen<T>(fn: () => Promise<T>): Promise<T> {
  switches.lifecycleDisabled = false;
  try {
    return await fn();
  } finally {
    switches.lifecycleDisabled = true;
  }
}

async function seedDealer({ ledger = true }: { ledger?: boolean } = {}) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "S560 Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "s560_owner", email: "s560owner@example.com", name: "Owner" })
  );
  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner", permissions: ["view:finance", "manage:finance"], isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRoleId }));
  const viewerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "s560_viewer", email: "s560viewer@example.com", name: "Viewer" })
  );
  const viewerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Viewer", permissions: ["view:finance"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRoleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );

  const asOwner = t.withIdentity({ subject: "s560_owner", clerkId: "s560_owner" });
  const asViewer = t.withIdentity({ subject: "s560_viewer", clerkId: "s560_viewer" });
  // `ledger: false` is a dealer whose chart of accounts is not set up yet (for the chart-init wake cell).
  if (ledger) {
    await openCurrentYearLedger(t, asOwner, orgId);
  }
  return { t, orgId, userId, asOwner, asViewer };
}

/** Chart of accounts plus an OPEN period covering today, and a bank account. */
async function openCurrentYearLedger(
  t: ReturnType<typeof convexTestWithComponents>,
  asOwner: { mutation: Dealer["asOwner"]["mutation"]; query: Dealer["asOwner"]["query"] },
  orgId: Id<"organizations">
) {
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  await seedBank(t, orgId);
}
type Dealer = Awaited<ReturnType<typeof seedDealer>>;

/** A genuine capitalized, depreciable asset, created while the lifecycle is open (the pre-pilot path). */
async function capitalizedAsset(d: Dealer, key = crypto.randomUUID()): Promise<Id<"fixedAssets">> {
  return await withLifecycleOpen(() =>
    d.asOwner.mutation(api.fixedAssets.capitalize, {
      idempotencyKey: key,
      orgId: d.orgId,
      name: "Pre-pilot machine",
      // Today, inside the open period: the capitalization journal posts at once, so no pending-post
      // retry can change a row between a cell's two snapshots.
      purchaseDate: Date.now(),
      costMinor: 600_000,
      usefulLifeMonths: 12,
    })
  );
}

/** A legacy pre-Phase-11 row: major-unit purchaseValue only, never capitalized. */
async function legacyAsset(d: Dealer): Promise<Id<"fixedAssets">> {
  return await d.t.run((ctx) =>
    ctx.db.insert("fixedAssets", {
      orgId: d.orgId, name: "Legacy furniture", purchaseDate: PAST_PURCHASE_DATE, purchaseValue: 1500,
    })
  );
}

const snapshot = (d: Dealer) => dbSnapshot(d.t, ALL_TABLES);

/** The expected-refusal cell: stable code, EN message, and not one row of any table changed. */
async function expectRefusedAndUnchanged(d: Dealer, call: () => Promise<unknown>) {
  const before = await snapshot(d);
  const refusal = await refusalDataOf(call());
  expect(refusal?.code).toBe(CODE);
  expect(refusal?.message).toMatch(/pilot/i);
  expect(refusal?.message).toMatch(/Nothing has been changed/);
  expect(await snapshot(d)).toEqual(before);
}

/** The mutation attack: the same call with the switch off must NOT be refused by the switch. */
async function expectOpenWhenSwitchOff(d: Dealer, call: () => Promise<unknown>) {
  const refusal = await withLifecycleOpen(() => refusalDataOf(call()));
  expect(refusal).toBeNull();
}

describe("the shipped switch is ON (unmocked pin)", () => {
  test("the lifecycle switch is the literal true and the guard follows it", async () => {
    const real = await vi.importActual<typeof import("./utils/fixedAssetLifecycleContainment")>(
      "./utils/fixedAssetLifecycleContainment"
    );
    expect(real.FIXED_ASSET_LIFECYCLE_PILOT_DISABLED).toBe(true);
    expect(() => real.assertFixedAssetLifecycleAllowed()).toThrow();
    // The pure guard passes when its switch is off, so a flipped switch is observable.
    expect(() => real.assertFixedAssetLifecycleAllowed(false)).not.toThrow();
    expect(real.isFixedAssetLifecycleDisabled()).toBe(true);
    expect(real.isFixedAssetLifecycleDisabled(false)).toBe(false);
  });

  test("the queued-posting classifier recognises the source and all four event types, and follows the switch", async () => {
    const real = await vi.importActual<typeof import("./utils/fixedAssetLifecycleContainment")>(
      "./utils/fixedAssetLifecycleContainment"
    );
    for (const eventType of ["ASSET_CAPITALIZED", "DEPRECIATION_POSTED", "ASSET_IMPAIRED", "ASSET_DISPOSED"]) {
      expect(real.fixedAssetPostingRefusal({ eventType, sourceType: "other" })).toMatch(/pilot/i);
      expect(real.fixedAssetPostingRefusal({ eventType, sourceType: "other" }, false)).toBeNull();
    }
    // By source alone, even with an event type this classifier does not list.
    expect(real.fixedAssetPostingRefusal({ eventType: "", sourceType: "fixedAssets" })).toMatch(/pilot/i);
    // Unrelated postings are untouched.
    expect(real.fixedAssetPostingRefusal({ eventType: "EXPENSE_POSTED", sourceType: "expenses" })).toBeNull();
  });

  test("the refusal code is an AppErrorCode (the EN/AR client text is pinned in lib/errors.test.ts)", async () => {
    const real = await vi.importActual<typeof import("./utils/fixedAssetLifecycleContainment")>(
      "./utils/fixedAssetLifecycleContainment"
    );
    const { AppErrorCode } = await import("./utils/errors");
    expect(Object.keys(real.FIXED_ASSET_LIFECYCLE_REFUSALS)).toEqual([CODE]);
    expect(Object.values(AppErrorCode)).toContain(CODE);
  });
});

describe("SCRUM-560 expected-refusal cells: every public fixed-asset write door", () => {
  test("capitalize is refused and writes nothing (no asset, no event, no journal, no idempotency record)", async () => {
    const d = await seedDealer();
    const call = () =>
      d.asOwner.mutation(api.fixedAssets.capitalize, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, name: "Forklift",
        purchaseDate: PAST_PURCHASE_DATE, costMinor: 250_000, usefulLifeMonths: 24,
      });
    await expectRefusedAndUnchanged(d, call);
    expect(await d.t.run((ctx) => ctx.db.query("fixedAssets").collect())).toHaveLength(0);
    expect(await d.t.run((ctx) => ctx.db.query("fixedAssetEvents").collect())).toHaveLength(0);
    await expectOpenWhenSwitchOff(d, call);
    expect(await d.t.run((ctx) => ctx.db.query("fixedAssets").collect())).toHaveLength(1);
  });

  test("capitalize refuses a stored idempotent replay too (the guard runs before the idempotency wrapper)", async () => {
    const d = await seedDealer();
    const key = crypto.randomUUID();
    const args = {
      idempotencyKey: key, orgId: d.orgId, name: "Forklift",
      purchaseDate: PAST_PURCHASE_DATE, costMinor: 250_000, usefulLifeMonths: 24,
    };
    await withLifecycleOpen(() => d.asOwner.mutation(api.fixedAssets.capitalize, args));
    await expectRefusedAndUnchanged(d, () => d.asOwner.mutation(api.fixedAssets.capitalize, args));
  });

  test("capitalize still answers an unauthorized caller with the permission error, not the switch", async () => {
    const d = await seedDealer();
    const refusal = await refusalDataOf(
      d.asViewer.mutation(api.fixedAssets.capitalize, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, name: "Forklift",
        purchaseDate: PAST_PURCHASE_DATE, costMinor: 250_000, usefulLifeMonths: 24,
      })
    );
    expect(refusal).not.toBeNull();
    expect(refusal?.code).not.toBe(CODE);
  });

  test("update is refused and the asset row is unchanged", async () => {
    const d = await seedDealer();
    const assetId = await capitalizedAsset(d);
    const call = () => d.asOwner.mutation(api.fixedAssets.update, { orgId: d.orgId, assetId, name: "Renamed", notes: "x" });
    await expectRefusedAndUnchanged(d, call);
    await expectOpenWhenSwitchOff(d, call);
    expect((await d.t.run((ctx) => ctx.db.get(assetId)))?.name).toBe("Renamed");
  });

  test("remove is refused and the asset is not soft-deleted", async () => {
    const d = await seedDealer();
    // A legacy row is the only kind `remove` accepts, so the switch is the sole reason for the refusal.
    const assetId = await legacyAsset(d);
    const call = () => d.asOwner.mutation(api.fixedAssets.remove, { orgId: d.orgId, assetId });
    await expectRefusedAndUnchanged(d, call);
    await expectOpenWhenSwitchOff(d, call);
    expect((await d.t.run((ctx) => ctx.db.get(assetId)))?.isDeleted).toBe(true);
  });

  test("impair is refused: no impairment event, no accumulated-depreciation change, no journal line", async () => {
    const d = await seedDealer();
    const assetId = await capitalizedAsset(d);
    const call = () => d.asOwner.mutation(api.fixedAssets.impair, { orgId: d.orgId, assetId, amountMinor: 10_000 });
    await expectRefusedAndUnchanged(d, call);
    await expectOpenWhenSwitchOff(d, call);
    expect((await d.t.run((ctx) => ctx.db.get(assetId)))?.status).toBe("IMPAIRED");
  });

  test("dispose is refused: the asset stays on the books and no derecognition journal posts", async () => {
    const d = await seedDealer();
    const assetId = await capitalizedAsset(d);
    const call = () => d.asOwner.mutation(api.fixedAssets.dispose, { orgId: d.orgId, assetId, proceedsMinor: 0 });
    await expectRefusedAndUnchanged(d, call);
    await expectOpenWhenSwitchOff(d, call);
    expect((await d.t.run((ctx) => ctx.db.get(assetId)))?.status).toBe("DISPOSED");
  });

  test("accountingMigration.backfillFixedAssetMinorUnits is refused and the legacy row stays unmigrated", async () => {
    const d = await seedDealer();
    const assetId = await legacyAsset(d);
    const call = () => d.asOwner.mutation(api.accountingMigration.backfillFixedAssetMinorUnits, { orgId: d.orgId });
    await expectRefusedAndUnchanged(d, call);
    expect((await d.t.run((ctx) => ctx.db.get(assetId)))?.costMinor).toBeUndefined();
    await expectOpenWhenSwitchOff(d, call);
    expect((await d.t.run((ctx) => ctx.db.get(assetId)))?.costMinor).toBe(1_500_000);
  });
});

describe("SCRUM-560 scheduled posting is a no-op", () => {
  const currentYearMonth = () => new Date().toISOString().slice(0, 7);

  test("depreciateAssetForMonth returns lifecycle_disabled and posts nothing (no throw)", async () => {
    const d = await seedDealer();
    const assetId = await capitalizedAsset(d);
    const call = () =>
      d.t.mutation(internal.fixedAssets.depreciateAssetForMonth, {
        orgId: d.orgId, assetId, yearMonth: currentYearMonth(), occurredAt: Date.now(), systemActorId: d.userId,
      });
    const before = await snapshot(d);
    expect(await call()).toEqual({ posted: false, reason: "lifecycle_disabled" });
    expect(await snapshot(d)).toEqual(before);

    // The mutation attack: with the switch off the same call really posts a month.
    const open = await withLifecycleOpen(call);
    expect(open).toMatchObject({ posted: true });
  });

  test("the monthly cron logs a skip, posts nothing, and does not throw", async () => {
    const d = await seedDealer();
    const assetId = await capitalizedAsset(d);
    // The cron writes one admin log row; everything else must be untouched.
    const { webhookLogs: logsBefore, ...before } = await snapshot(d);

    const summary: string = await d.t.action(internal.crons.triggerFixedAssetDepreciation, {});
    expect(summary).toMatch(/off during the pilot/i);
    expect(summary).toMatch(/Nothing was posted/);
    const { webhookLogs, ...after } = await snapshot(d);
    expect(after).toEqual(before);

    type LogRow = { _id: string; source?: string; status?: string; summary?: string };
    const knownIds = new Set((logsBefore as LogRow[]).map((row) => row._id));
    const added = (webhookLogs as LogRow[]).filter((row) => !knownIds.has(row._id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ source: "fixed-asset-depreciation", status: "success" });
    expect(added[0].summary).toBe(summary);
    const asset = await d.t.run((ctx) => ctx.db.get(assetId));
    expect(asset?.accumulatedDepreciationMinor).toBe(0);

    // The mutation attack: with the switch off the cron posts the month.
    const open: string = await withLifecycleOpen(() => d.t.action(internal.crons.triggerFixedAssetDepreciation, {}));
    expect(open).toMatch(/posted 1\/1/i);
  });
});

describe("SCRUM-560 reads and cutover are deliberately NOT gated", () => {
  test("list, listEvents and listBankOptions still show an org its own assets while the lifecycle is off", async () => {
    const d = await seedDealer();
    const assetId = await capitalizedAsset(d);
    const page = await d.asOwner.query(api.fixedAssets.list, {
      orgId: d.orgId, paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page.map((row) => row._id)).toEqual([assetId]);
    const events = await d.asOwner.query(api.fixedAssets.listEvents, { orgId: d.orgId, assetId });
    expect(events.map((e) => e.type)).toEqual(["CAPITALIZE"]);
    await expect(d.asOwner.query(api.fixedAssets.listBankOptions, { orgId: d.orgId })).resolves.toBeDefined();
  });
});

describe("SCRUM-560 H1: a fixed-asset posting already queued in the outbox must not post while the lifecycle is off", () => {
  const FAKE = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const;
  const HOUR = 3_600_000;
  const LEDGER_TABLES = ["accountingEvents", "journalEntries", "journalLines"];
  const PRIOR_YEAR = 2025;
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let every scheduled function settle (convex-test needs the timers drained explicitly). */
  async function pump(d: Dealer) {
    for (let pass = 0; pass < 10; pass += 1) {
      await d.t.finishAllScheduledFunctions(vi.runAllTimers);
      const live = (await d.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
        (f) => f.state.kind === "pending" || f.state.kind === "inProgress"
      );
      if (live.length === 0) break;
    }
  }

  /** What `dispatch-outbox-work` does every minute. */
  async function cronTick(d: Dealer) {
    await d.t.mutation(internal.accountingOutbox.dispatchDueOutboxWork, {});
    await pump(d);
  }

  /** Time passes (backoff windows elapse), then the cron ticks. */
  async function laterCronTick(d: Dealer) {
    vi.setSystemTime(Date.now() + 2 * HOUR);
    await cronTick(d);
  }

  /** A genuine fixed-asset posting waiting in the outbox: capitalized (pre-pilot) into a date with no period. */
  async function queueFixedAssetRow(d: Dealer): Promise<Id<"pendingAccountingEvents">> {
    await withLifecycleOpen(() =>
      d.asOwner.mutation(api.fixedAssets.capitalize, {
        idempotencyKey: crypto.randomUUID(), orgId: d.orgId, name: "Queued forklift",
        purchaseDate: PAST_PURCHASE_DATE, costMinor: 250_000, usefulLifeMonths: 24,
      })
    );
    const rows = (await d.t.run((ctx) => ctx.db.query("pendingAccountingEvents").collect())).filter(
      (row) => row.sourceType === "fixedAssets"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "POST", status: "PENDING", eventType: "ASSET_CAPITALIZED" });
    vi.useFakeTimers({ toFake: [...FAKE] });
    return rows[0]._id;
  }

  const openPriorYearPeriod = (d: Dealer) =>
    d.asOwner.mutation(api.accountingPeriods.create, {
      orgId: d.orgId,
      startDate: Date.UTC(PRIOR_YEAR, 0, 1),
      endDate: Date.UTC(PRIOR_YEAR, 11, 31, 23, 59, 59, 999),
      fiscalYear: PRIOR_YEAR, periodNumber: 1, openImmediately: true,
    });

  const ledger = (d: Dealer) => dbSnapshot(d.t, LEDGER_TABLES);
  const getRow = (d: Dealer, id: Id<"pendingAccountingEvents">) => d.t.run((ctx) => ctx.db.get(id));

  /** The row never posted: still not POSTED, carries the pilot reason, and the ledger is untouched. */
  async function expectNeverPosted(d: Dealer, id: Id<"pendingAccountingEvents">, ledgerBefore: unknown) {
    const row = await getRow(d, id);
    expect(row?.status === "PENDING" || row?.status === "FAILED").toBe(true);
    expect(row?.lastError ?? "").toMatch(/pilot/i);
    expect(await ledger(d)).toEqual(ledgerBefore);
  }

  test("the cron dispatcher refuses the row BEFORE the period hold, so it is not parked behind a missing period", async () => {
    const d = await seedDealer();
    const id = await queueFixedAssetRow(d);
    const before = await ledger(d);
    await cronTick(d);
    const row = await getRow(d, id);
    // Refused (an attempt burned, a pilot reason), not held waiting for a period: a hold would
    // leave it PENDING for ever, blocking close with a row no operator can resolve (SCRUM-234).
    expect(row?.dispatchState).not.toBe("PERIOD_HELD");
    expect(row?.attempts).toBeGreaterThanOrEqual(1);
    await expectNeverPosted(d, id, before);
  });

  test("opening the period it was waiting for does not post it (period-open wake path)", async () => {
    const d = await seedDealer();
    const id = await queueFixedAssetRow(d);
    const before = await ledger(d);
    await openPriorYearPeriod(d);
    await pump(d);
    await laterCronTick(d);
    await expectNeverPosted(d, id, before);
  });

  test("control: with the lifecycle open the same row DOES post once its period opens", async () => {
    const d = await seedDealer();
    const id = await queueFixedAssetRow(d);
    const before = (await ledger(d)) as { accountingEvents: unknown[] };
    await withLifecycleOpen(async () => {
      await openPriorYearPeriod(d);
      await pump(d);
      await laterCronTick(d);
    });
    expect((await getRow(d, id))?.status).toBe("POSTED");
    const after = (await ledger(d)) as { accountingEvents: unknown[] };
    expect(after.accountingEvents.length).toBe(before.accountingEvents.length + 1);
  });

  test("setting up the chart of accounts it was waiting for does not post it (chart-init wake path), and the control does", async () => {
    for (const lifecycleOpen of [false, true]) {
      const d = await seedDealer({ ledger: false });
      // No chart yet, so a pre-pilot capitalization today is queued rather than posted.
      await withLifecycleOpen(() =>
        d.asOwner.mutation(api.fixedAssets.capitalize, {
          idempotencyKey: crypto.randomUUID(), orgId: d.orgId, name: "Queued forklift",
          purchaseDate: Date.now(), costMinor: 250_000, usefulLifeMonths: 24,
        })
      );
      const queued = (await d.t.run((ctx) => ctx.db.query("pendingAccountingEvents").collect())).filter(
        (row) => row.sourceType === "fixedAssets"
      );
      expect(queued).toHaveLength(1);
      expect(queued[0].status).toBe("PENDING");
      vi.useFakeTimers({ toFake: [...FAKE] });
      const bring = async () => {
        await openCurrentYearLedger(d.t, d.asOwner, d.orgId);
        await pump(d);
        await laterCronTick(d);
      };
      const before = (await ledger(d)) as { accountingEvents: unknown[] };
      if (lifecycleOpen) {
        await withLifecycleOpen(bring);
        expect((await getRow(d, queued[0]._id))?.status).toBe("POSTED");
        expect(((await ledger(d)) as typeof before).accountingEvents.length).toBe(before.accountingEvents.length + 1);
      } else {
        await bring();
        await expectNeverPosted(d, queued[0]._id, before);
      }
      vi.useRealTimers();
    }
  });

  test("an operator redrive cannot post it", async () => {
    const d = await seedDealer();
    const id = await queueFixedAssetRow(d);
    const before = await ledger(d);
    await openPriorYearPeriod(d);
    await pump(d);
    vi.setSystemTime(Date.now() + 2 * HOUR);
    await d.asOwner.mutation(api.accountingOutbox.redrive, { orgId: d.orgId });
    await pump(d);
    await laterCronTick(d);
    await expectNeverPosted(d, id, before);
  });

  test("retryFailed cannot revive a dead-lettered fixed-asset posting, and the failed list does not offer Retry", async () => {
    const d = await seedDealer();
    const id = await queueFixedAssetRow(d);
    // What ten refusals leave behind: dead-lettered with the pilot reason.
    await d.t.run((ctx) =>
      ctx.db.patch(id, { status: "FAILED", attempts: 10, lastError: "Fixed-asset postings are off during the pilot." })
    );
    await openPriorYearPeriod(d);
    await pump(d);
    const before = await ledger(d);
    const failed = await d.asOwner.query(api.accountingSetup.listFailedEvents, {
      orgId: d.orgId, paginationOpts: { numItems: 20, cursor: null },
    });
    expect(failed.page.find((row) => row._id === id)?.retryable).toBe(false);

    await expect(
      d.asOwner.mutation(api.accountingOutbox.retryFailed, { orgId: d.orgId, pendingEventId: id })
    ).rejects.toThrow(/could not be revived/);
    await pump(d);
    await laterCronTick(d);
    expect((await getRow(d, id))?.status).toBe("FAILED");
    expect(await ledger(d)).toEqual(before);
  });

  test("control: with the lifecycle open the same dead-lettered row is revivable and posts", async () => {
    const d = await seedDealer();
    const id = await queueFixedAssetRow(d);
    await d.t.run((ctx) => ctx.db.patch(id, { status: "FAILED", attempts: 10, lastError: "dead-lettered" }));
    await withLifecycleOpen(async () => {
      await openPriorYearPeriod(d);
      await pump(d);
      await expect(
        d.asOwner.mutation(api.accountingOutbox.retryFailed, { orgId: d.orgId, pendingEventId: id })
      ).resolves.toEqual({ retryQueued: true });
      await pump(d);
      await laterCronTick(d);
    });
    expect((await getRow(d, id))?.status).toBe("POSTED");
  });

  describe("REVERSE rows (round 3, Seat 2 finding 2): the reversal of a fixed-asset entry is refused too", () => {
    const eventOf = async (d: Dealer, id: Id<"accountingEvents">) => d.t.run((ctx) => ctx.db.get(id));

    /** A fixed-asset REVERSE row, enqueued the way `enqueuePendingReverse` writes it. */
    function queueReverseRow(
      d: Dealer, originalEventId: Id<"accountingEvents">, sourceType: string
    ): Promise<Id<"pendingAccountingEvents">> {
      return d.t.run((ctx) =>
        ctx.db.insert("pendingAccountingEvents", {
          orgId: d.orgId, kind: "REVERSE", status: "PENDING", idempotencyKey: `s560_rev_${crypto.randomUUID()}`,
          accountingDate: Date.now(), actorId: d.userId, reason: "S560 reversal", attempts: 0, createdAt: Date.now(),
          sourceType, sourceId: "s560", originalEventId,
        })
      );
    }

    /** A POSTED pre-pilot capitalization to reverse (asset created while the lifecycle was open). */
    async function postedCapitalization(d: Dealer): Promise<Id<"accountingEvents">> {
      await capitalizedAsset(d);
      const event = (await d.t.run((ctx) => ctx.db.query("accountingEvents").collect())).find(
        (e) => e.eventType === "ASSET_CAPITALIZED" && e.status === "POSTED"
      );
      expect(event).toBeDefined();
      vi.useFakeTimers({ toFake: [...FAKE] });
      return event!._id;
    }

    test("a REVERSE row for a fixed-asset entry is refused by the cron: not POSTED, no lines, entry still POSTED", async () => {
      const d = await seedDealer();
      const originalId = await postedCapitalization(d);
      const id = await queueReverseRow(d, originalId, "fixedAssets");
      const before = await ledger(d);
      await cronTick(d);
      const row = await getRow(d, id);
      expect(row?.status).not.toBe("POSTED");
      expect(row?.attempts).toBeGreaterThanOrEqual(1);
      expect(row?.lastError ?? "").toMatch(/pilot/i);
      expect(await ledger(d)).toEqual(before);
      expect((await eventOf(d, originalId))?.status).toBe("POSTED");
    });

    test("the ORIGINAL event decides, not the row's own source label (a mislabeled row is still refused)", async () => {
      const d = await seedDealer();
      const originalId = await postedCapitalization(d);
      const id = await queueReverseRow(d, originalId, "expenses");
      const before = await ledger(d);
      await cronTick(d);
      expect((await getRow(d, id))?.status).not.toBe("POSTED");
      expect(await ledger(d)).toEqual(before);
    });

    test("control: with the lifecycle open the same REVERSE row posts and reverses the entry", async () => {
      const d = await seedDealer();
      const originalId = await postedCapitalization(d);
      const id = await queueReverseRow(d, originalId, "fixedAssets");
      await withLifecycleOpen(() => cronTick(d));
      expect((await getRow(d, id))?.status).toBe("POSTED");
      expect((await eventOf(d, originalId))?.status).toBe("REVERSED");
    });

    test("control: an UNRELATED REVERSE row still posts while the lifecycle is off", async () => {
      const d = await seedDealer();
      const posted = await d.asOwner.mutation(internal.accountingLedger.post, expensePost(d));
      const postedEventId = requireEventId(posted.eventId);
      vi.useFakeTimers({ toFake: [...FAKE] });
      const id = await queueReverseRow(d, postedEventId, "expenses");
      await cronTick(d);
      expect((await getRow(d, id))?.status).toBe("POSTED");
      expect((await eventOf(d, postedEventId))?.status).toBe("REVERSED");
    });

    test("retryFailed cannot revive a dead-lettered fixed-asset REVERSE row, and the list does not offer Retry", async () => {
      const d = await seedDealer();
      const originalId = await postedCapitalization(d);
      const id = await queueReverseRow(d, originalId, "fixedAssets");
      await d.t.run((ctx) => ctx.db.patch(id, { status: "FAILED", attempts: 10, lastError: "dead-lettered" }));
      const before = await ledger(d);
      const failed = await d.asOwner.query(api.accountingSetup.listFailedEvents, {
        orgId: d.orgId, paginationOpts: { numItems: 20, cursor: null },
      });
      expect(failed.page.find((row) => row._id === id)?.retryable).toBe(false);
      await expect(
        d.asOwner.mutation(api.accountingOutbox.retryFailed, { orgId: d.orgId, pendingEventId: id })
      ).rejects.toThrow(/could not be revived/);
      await pump(d);
      await laterCronTick(d);
      expect((await getRow(d, id))?.status).toBe("FAILED");
      expect(await ledger(d)).toEqual(before);
    });

    test("control: a dead-lettered UNRELATED REVERSE row is still revivable", async () => {
      const d = await seedDealer();
      const posted = await d.asOwner.mutation(internal.accountingLedger.post, expensePost(d));
      const id = await queueReverseRow(d, requireEventId(posted.eventId), "expenses");
      await d.t.run((ctx) => ctx.db.patch(id, { status: "FAILED", attempts: 10, lastError: "dead-lettered" }));
      await expect(
        d.asOwner.mutation(api.accountingOutbox.retryFailed, { orgId: d.orgId, pendingEventId: id })
      ).resolves.toEqual({ retryQueued: true });
    });
  });
});

/**
 * `internal.accountingLedger.post` returns `eventId: Id<"accountingEvents"> | null` (null when the engine
 * writes nothing). A control that goes on to reverse or read that id must fail loudly on null rather
 * than pass a nullable value on, so the narrowing is an explicit assertion, not a cast.
 */
function requireEventId(eventId: Id<"accountingEvents"> | null): Id<"accountingEvents"> {
  expect(eventId).not.toBeNull();
  if (eventId === null) throw new Error("expected the posting to return an accountingEvents id");
  return eventId;
}

/** An unrelated, certified-shape posting (a paid expense) that the reversal controls reverse. */
function expensePost(d: Dealer) {
  return {
    orgId: d.orgId, eventType: "EXPENSE_POSTED", sourceType: "expenses", sourceId: "s560_expense",
    eventVersion: 1, accountingDate: Date.now(), occurredAt: Date.now(), currency: "JOD",
    idempotencyKey: `s560_expense_${crypto.randomUUID()}`,
    payload: { expenseId: "s560_expense", amountMinor: 5_000, currency: "JOD", paymentMethod: "CASH", category: "OTHER" },
  };
}

describe("SCRUM-560 round 3: the posting engine itself refuses fixed-asset events (Seat 2 finding 1)", () => {
  const ledgerTables = ["accountingEvents", "journalEntries", "journalLines"];
  const fixedAssetPost = (d: Dealer, eventType = "ASSET_CAPITALIZED") => ({
    orgId: d.orgId, eventType, sourceType: "fixedAssets", sourceId: "s560_asset", eventVersion: 1,
    accountingDate: Date.now(), occurredAt: Date.now(), currency: "JOD",
    idempotencyKey: `s560_engine_${crypto.randomUUID()}`,
    payload: { assetId: "s560_asset", costMinor: 100_000, amountMinor: 100_000, currency: "JOD", paymentMethod: "CASH" },
  });

  test("internal.accountingLedger.post refuses every fixed-asset event type and writes nothing", async () => {
    const d = await seedDealer();
    for (const eventType of ["ASSET_CAPITALIZED", "DEPRECIATION_POSTED", "ASSET_IMPAIRED", "ASSET_DISPOSED"]) {
      await expectRefusedAndUnchanged(d, () =>
        d.asOwner.mutation(internal.accountingLedger.post, fixedAssetPost(d, eventType))
      );
    }
    const ledgerRows = await dbSnapshot(d.t, ledgerTables);
    expect((ledgerRows as { journalLines: unknown[] }).journalLines).toHaveLength(0);
  });

  test("a fixed-asset SOURCE is refused even under another event type's name", async () => {
    const d = await seedDealer();
    await expectRefusedAndUnchanged(d, () =>
      d.asOwner.mutation(internal.accountingLedger.post, { ...expensePost(d), sourceType: "fixedAssets" })
    );
  });

  test("control: with the lifecycle open the same call posts the capitalization journal", async () => {
    const d = await seedDealer();
    const lines = async () =>
      ((await dbSnapshot(d.t, ledgerTables)) as { journalLines: unknown[] }).journalLines.length;
    const before = await lines();
    await withLifecycleOpen(() => d.asOwner.mutation(internal.accountingLedger.post, fixedAssetPost(d)));
    expect(await lines()).toBe(before + 2);
  });

  test("control: an unrelated posting still posts while the lifecycle is off", async () => {
    const d = await seedDealer();
    const posted = await d.asOwner.mutation(internal.accountingLedger.post, expensePost(d));
    requireEventId(posted.eventId);
  });

  test("internal.accountingLedger.reverse refuses the reversal of a fixed-asset entry and writes nothing", async () => {
    const d = await seedDealer();
    await capitalizedAsset(d);
    const original = (await d.t.run((ctx) => ctx.db.query("accountingEvents").collect())).find(
      (e) => e.eventType === "ASSET_CAPITALIZED"
    )!;
    const args = {
      orgId: d.orgId, originalEventId: original._id, reversalDate: Date.now(), reason: "S560",
      idempotencyKey: `s560_rev_${crypto.randomUUID()}`,
    };
    await expectRefusedAndUnchanged(d, () => d.asOwner.mutation(internal.accountingLedger.reverse, args));
    expect((await d.t.run((ctx) => ctx.db.get(original._id)))?.status).toBe("POSTED");
    // The mutation attack: with the switch off the very same reversal succeeds.
    await withLifecycleOpen(() => d.asOwner.mutation(internal.accountingLedger.reverse, args));
    expect((await d.t.run((ctx) => ctx.db.get(original._id)))?.status).toBe("REVERSED");
  });

  test("control: internal.accountingLedger.reverse of an UNRELATED entry still posts while the lifecycle is off", async () => {
    const d = await seedDealer();
    const posted = await d.asOwner.mutation(internal.accountingLedger.post, expensePost(d));
    const postedEventId = requireEventId(posted.eventId);
    await d.asOwner.mutation(internal.accountingLedger.reverse, {
      orgId: d.orgId, originalEventId: postedEventId, reversalDate: Date.now(), reason: "S560",
      idempotencyKey: `s560_rev_${crypto.randomUUID()}`,
    });
    expect((await d.t.run((ctx) => ctx.db.get(postedEventId)))?.status).toBe("REVERSED");
  });
});