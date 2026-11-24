import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { allTables, apply, args, NOV_23, OCT_20, seedWorld as seedWorldWith, type World } from "../test-utils/scrum987Fixture";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { applyCorrection } from "./scrum987CancelledDealReversal";
import { SCRUM987_ORG_ID, SCRUM987_TARGETS } from "./utils/scrum987Targets";
/**
 * SCRUM-987 slice 1 (2 of 2) — fail-closed refusals, the actor proof and the hard-coded allow-list.
 * The fixture (seeded through the REAL handlers) is test-utils/scrum987Fixture.ts.
 */

const MODULES = {
  ...import.meta.glob("./**/*.*s"),
  // Test-only registration of an internalMutation built by the PRODUCTION builder (convex/functions.ts).
  "./__scrum987WrappedHarness.ts": () => import("../test-utils/scrum987WrappedHarness"),
};
const seedWorld = (suffix: string, opts: { legacyOccurredAt?: boolean } = {}) => seedWorldWith(MODULES, suffix, opts);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => {
  vi.useRealTimers();
});
describe("fail closed before any write", () => {
  const refused = async (w: World, pattern: RegExp, extra: Partial<Parameters<typeof applyCorrection>[1]> = {}) => {
    const snapshot = await dbSnapshot(w.t, allTables);
    await expect(apply(w, extra)).rejects.toThrow(pattern);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  };

  test("a typo'd id or a wrong amount touches nothing", async () => {
    const w = await seedWorld("typo");
    await refused(w, /not all in the expected original state/, {
      targets: [w.targets[0], w.targets[1], { ...w.targets[2], feeId: "rh7evqeycaesbde744d9tep0n18jdezx" }],
    });
    await refused(w, /not all in the expected original state/, {
      targets: [w.targets[0], { ...w.targets[1], amountMinor: w.targets[1].amountMinor + 1 }, w.targets[2]],
    });
  });

  test("a partially applied state is refused with a report", async () => {
    const w = await seedWorld("partial");
    await apply(w, { targets: [w.targets[0]] });
    const snapshot = await dbSnapshot(w.t, allTables);
    await expect(apply(w)).rejects.toThrow(/partially applied/);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });

  test("an original event that is already REVERSED or still PENDING refuses the whole run", async () => {
    for (const status of ["REVERSED", "PENDING"] as const) {
      const w = await seedWorld(`evt${status}`);
      await w.t.run(async (ctx) => {
        const ev = (await ctx.db.query("accountingEvents").withIndex("by_org_source", (q) =>
          q.eq("orgId", w.orgId).eq("sourceType", "financeDealFees").eq("sourceId", w.targets[1].feeId)).collect())[0];
        await ctx.db.patch(ev._id, { status });
      });
      await refused(w, /not all in the expected original state/);
    }
  });

  test("an outbox row that is not terminal refuses", async () => {
    const w = await seedWorld("outbox");
    await w.t.run((ctx) => ctx.db.insert("pendingAccountingEvents", {
      orgId: w.orgId, kind: "POST", status: "PENDING", idempotencyKey: "stray", accountingDate: NOV_23, actorId: w.actorId,
      attempts: 0, createdAt: NOV_23, sourceType: "financeDealFees", sourceId: w.targets[0].feeId,
    }));
    await refused(w, /not all in the expected original state/);
  });

  test("more than 20 terminal outbox rows on one source refuse instead of being read as a prefix", async () => {
    const w = await seedWorld("outbox21");
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 21; i += 1) {
        await ctx.db.insert("pendingAccountingEvents", {
          orgId: w.orgId, kind: "POST", status: "POSTED", idempotencyKey: `done-${i}`, accountingDate: NOV_23, actorId: w.actorId,
          attempts: 0, createdAt: NOV_23, sourceType: "financeDealFees", sourceId: w.targets[0].feeId,
        });
      }
    });
    await refused(w, /more than 20 pending accounting events/);
  });

  test("no open period for today refuses (a deferred reversal is not a correction)", async () => {
    const w = await seedWorld("noperiod");
    await w.t.run((ctx) => ctx.db.patch(w.novPeriodId, { status: "CLOSED" }));
    await refused(w, /no OPEN accounting period/);
  });

  test("running outside the expected month refuses", async () => {
    const w = await seedWorld("month");
    await refused(w, /not in 2026-12/, { expectedUtcMonth: "2026-12" });
  });

  test("actor: non-member, custodian, and a role without the confirm permission are refused", async () => {
    const w = await seedWorld("actor");
    await refused(w, /not a member/, { actorId: w.outsiderId });
    await refused(w, /not all in the expected original state/, { actorId: w.custodianId });
    await refused(w, /the actor lacks/, { actorId: w.limitedId });
  });

  test("L1: a disabled account is refused with zero writes", async () => {
    const w = await seedWorld("disabled");
    await w.t.run((ctx) => ctx.db.patch(w.actorId, { disabled: true }));
    await refused(w, /account is disabled/);
  });

  test("a soft-deleted role, or a role of another organization, is refused as the actor's role", async () => {
    const w = await seedWorld("role");
    const membershipRoleId = await w.t.run(async (ctx) =>
      (await ctx.db.query("memberships").withIndex("by_org_user", (q) => q.eq("orgId", w.orgId).eq("userId", w.actorId)).unique())!.roleId);
    await w.t.run((ctx) => ctx.db.patch(membershipRoleId, { isDeleted: true }));
    await refused(w, /role is deleted or belongs to another organization/);
    await w.t.run((ctx) => ctx.db.patch(membershipRoleId, { isDeleted: false }));
    const otherOrg = await w.t.run((ctx) => ctx.db.insert("organizations", { name: "other", createdAt: Date.now() }));
    await w.t.run((ctx) => ctx.db.patch(membershipRoleId, { orgId: otherOrg }));
    await refused(w, /role is deleted or belongs to another organization/);
  });

  test("L1: an impersonation membership is refused as the actor, with zero writes", async () => {
    const w = await seedWorld("impersonation");
    await w.t.run(async (ctx) => {
      const membership = (await ctx.db.query("memberships").withIndex("by_org_user", (q) => q.eq("orgId", w.orgId).eq("userId", w.actorId)).unique())!;
      const grantId = await ctx.db.insert("impersonationGrants", {
        actorUserId: w.actorId, targetUserId: w.custodianId, orgId: w.orgId, membershipId: membership._id,
        reason: "support", grantedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
      });
      await ctx.db.patch(membership._id, { impersonationGrantId: grantId });
    });
    await refused(w, /impersonation membership/);
  });

  test("a fee deducted from settlement, a direct payment, or a payable position is refused", async () => {
    const w = await seedWorld("shape");
    await w.t.run((ctx) => ctx.db.patch(w.targets[0].feeId as Id<"financeDealFees">, { deductedFromSettlement: true }));
    await refused(w, /not all in the expected original state/);
    const w2 = await seedWorld("shape2");
    await w2.t.run((ctx) => ctx.db.patch(w2.targets[1].custodyId as Id<"financeDealCustody">, { payableTargetMinor: 5 }));
    await refused(w2, /not all in the expected original state/);
  });

  test("an ACTIVE unwind on the finalized deal refuses", async () => {
    const w = await seedWorld("unwind");
    await w.t.run(async (ctx) => {
      const app = (await ctx.db.get(w.targets[2].applicationId as Id<"financeApplications">))!;
      await ctx.db.insert("dealUnwinds", {
        orgId: w.orgId, applicationId: app._id, saleId: app.finalizedSaleId!, status: "ACTIVE", reason: "x", startedBy: w.actorId,
        startedAt: NOV_23, createdAt: NOV_23, updatedAt: NOV_23, remittanceVersion: 1, remittanceMinor: 0, remittanceMethod: "CASH", forwardDueMinor: 0,
      } as never);
    });
    await refused(w, /not all in the expected original state/);
  });

  test("rehearsal performs every write, proves the result, then rolls everything back", async () => {
    const w = await seedWorld("rehearse");
    const snapshot = await dbSnapshot(w.t, allTables);
    const inside: { writes?: number } = {};
    await expect(
      w.t.run(async (ctx) => {
        const result = await applyCorrection(ctx, args(w));
        inside.writes = (await ctx.db.query("financeDealCustodyEntries").collect()).filter((e) => e.kind === "REVERSAL").length;
        throw new Error(`REHEARSAL ${JSON.stringify(result)}`);
      })
    ).rejects.toThrow(/REHEARSAL/);
    expect(inside.writes).toBe(3);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });
});

describe("the hard-coded allow-list", () => {
  test("ids are well-formed for their tables and match the invariant packet", async () => {
    const w = await seedWorld("ids");
    await w.t.run(async () => {
      for (const target of SCRUM987_TARGETS) {
        // A production id has the shape of its table's ids: 32 lowercase chars. The test deployment
        // mints ids of the same width; normalizeId proves the id/table pairing when a row exists.
        for (const id of [target.applicationId, target.feeId, target.custodyId, target.entryId]) expect(id).toMatch(/^[a-z0-9]{32}$/);
      }
    });
    expect(SCRUM987_TARGETS.map((t) => [t.label, t.amountMinor, t.finalized])).toEqual([
      ["D-000012", 582_150, false], ["D-000015", 870_000, false], ["D-000016", 870_000, true],
    ]);
    expect(SCRUM987_TARGETS.map((t) => t.feeId)).toEqual([
      "rh716g08tzs0kjq8xh1kcprvfs8jdgfp", "rh71aasc38t34x4g22gmpvxhws8jcyy5", "rh7evqeycaesbde744d9tep0n18jdezs",
    ]);
    expect(SCRUM987_TARGETS.map((t) => t.entryId)).toEqual([
      "rd73sbrcqf3qfecr4v6m0rxx3h8jce2s", "rd725v20e792s89e4n0b5vah3n8jd1ph", "rd7eqpry1j41gw6ch7z3tn4k9s8jckf7",
    ]);
    expect(SCRUM987_TARGETS.map((t) => t.custodyId)).toEqual([
      "r976ejw9pca01ckx442f48pk6s8jdynn", "r97cy2f8t6gqex3zn5hgm2kz1x8jdmct", "r97f74vwqhfd2v7kspzep6pmvn8jc536",
    ]);
    expect(SCRUM987_TARGETS.map((t) => t.applicationId)).toEqual([
      "qs7en3pgh408khqsagjphgqhrx8jdxzf", "qs7dq0emdxtb7m65kbfgca41398jc811", "qs70da2paqr67nvawywa4tnxfn8jcnds",
    ]);
    expect(SCRUM987_ORG_ID).toBe("pd7pw6zrrz9q9ke4sdv6xtw6tn8g8v5n");
  });

  test("the internal doors against a deployment that lacks these ids fail closed and write nothing", async () => {
    const w = await seedWorld("doors");
    const snapshot = await dbSnapshot(w.t, allTables);
    await expect(
      w.t.mutation(internal.scrum987CancelledDealReversal.applyScrum987, { actorId: w.actorId, confirm: "SCRUM-987", mode: "apply" })
    ).rejects.toThrow();
    await expect(
      w.t.query(internal.scrum987CancelledDealReversal.planScrum987, { actorId: w.actorId })
    ).rejects.toThrow();
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });
});
