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
import { describe, expect, test, vi } from "vitest";
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

async function seedDealer() {
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
  return { t, orgId, userId, asOwner, asViewer };
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
