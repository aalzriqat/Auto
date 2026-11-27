import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { seedWorld as seedWorldWith, OCT_20 } from "../test-utils/scrum987Fixture";
import type { World } from "../test-utils/scrum987Fixture";
import { codes, preview, reverseDeal } from "../test-utils/purgePreview";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * SCRUM-1023 Phase 1c (owner ruling 2026-11-27, Jira SCRUM-1023 comments 26166-26168): consumed commitment roots and
 * stale claims leave with their deals. Every refusal test changes ONE fact of an otherwise ok manifest, so its code can
 * only come from that fact. Read-only: the dry run never writes.
 */

const MODULES = import.meta.glob("./**/*.*s");
const seedWorld = (suffix: string) => seedWorldWith(MODULES, suffix, {});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => { vi.useRealTimers(); });

interface Base {
  w: World;
  sale: Id<"sales">;
  root: Id<"commitmentRoots">;
  vehicleId: Id<"vehicles">;
  customerId: Id<"customers">;
  app: Doc<"financeApplications">;
}

/** A purged (deleted, cancelled) sale that consumed ONE root of the first deal's car. No claim yet. */
async function base(suffix: string, rootExtra: Partial<Doc<"commitmentRoots">> = {}): Promise<Base> {
  const w = await seedWorld(suffix);
  const made = await w.t.run(async (ctx) => {
    const app = (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!;
    const sale = await ctx.db.insert("sales", {
      orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, salespersonId: w.actorId, salePrice: 1, saleDate: 1, status: "CANCELLED", isDeleted: true,
    } as never);
    const root = await ctx.db.insert("commitmentRoots", {
      orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, status: "CONSUMED", openedAt: 1, openedBy: w.actorId, closedAt: 2, consumedBySaleId: sale, ...rootExtra,
    });
    return { sale, root, vehicleId: app.vehicleId, customerId: app.customerId, app };
  });
  return { w, ...made };
}

const deposit = (b: Base, status: Doc<"deposits">["status"] = "REFUNDED", extra: Partial<Doc<"deposits">> = {}): Promise<Id<"deposits">> =>
  b.w.t.run((ctx) => ctx.db.insert("deposits", {
    orgId: b.w.orgId, customerId: b.customerId, vehicleId: b.vehicleId, amount: 1, amountMinor: 1000, currency: "JOD", status, holdActive: false,
    createdBy: b.w.actorId, createdAt: 1, ...extra,
  }));

const claim = (b: Base, depositId: Id<"deposits">, extra: Record<string, unknown> = {}): Promise<Id<"vehicleCommitmentClaims">> =>
  b.w.t.run((ctx) => ctx.db.insert("vehicleCommitmentClaims", {
    orgId: b.w.orgId, rootId: b.root, vehicleId: b.vehicleId, evidenceKind: "DEPOSIT", status: "ACTIVE", depositId, createdAt: 1, createdBy: b.w.actorId, ...extra,
  } as never));

/** The ok baseline: root consumed by the purged sale, one ACTIVE claim whose evidence is a kept REFUNDED deposit. */
async function okWorld(suffix: string) {
  const b = await base(suffix);
  const depositId = await deposit(b);
  const claimId = await claim(b, depositId);
  return { ...b, depositId, claimId };
}

describe("positives - the root and the stale claim leave with their deal", () => {
  test("a CONSUMED root consumed by the purged sale and its ACTIVE claim on a REFUNDED deposit: ok, both listed, nothing else leaves", async () => {
    const o = await okWorld("pos-root-claim");
    const m = await preview(o.w, { saleIds: [o.sale] });
    expect(m.refusals).toEqual([]);
    expect(m.ok).toBe(true);
    expect(m.idsByTable.commitmentRoots).toEqual([o.root]);
    expect(m.idsByTable.vehicleCommitmentClaims).toEqual([o.claimId]);
    expect(m.idsByTable.deposits).toBeUndefined();
    expect(m.commitmentItems.map((i) => [i.kind, i.id, i.status])).toEqual([["claim", o.claimId, "ACTIVE"], ["root", o.root, "CONSUMED"]]);
  });

  test("a CONSUMED root alone (no claim) leaves with its sale", async () => {
    const b = await base("pos-root-only");
    const m = await preview(b.w, { saleIds: [b.sale] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.commitmentRoots).toEqual([b.root]);
  });

  test("a claim whose evidence IS in the purge (the purged application) leaves with its CONSUMED root and sale", async () => {
    const w = await seedWorld("pos-evidence-in-purge");
    await reverseDeal(w, 0);
    const app = w.targets[0].applicationId as Id<"financeApplications">;
    const [sale, claimId, rootId] = await w.t.run(async (ctx) => {
      const a = (await ctx.db.get(app))!;
      const s = await ctx.db.insert("sales", {
        orgId: w.orgId, vehicleId: a.vehicleId, customerId: a.customerId, salespersonId: w.actorId, salePrice: 1, saleDate: 1, status: "CANCELLED", isDeleted: true,
      } as never);
      const root = await ctx.db.insert("commitmentRoots", {
        orgId: w.orgId, vehicleId: a.vehicleId, customerId: a.customerId, status: "CONSUMED", openedAt: 1, openedBy: w.actorId, consumedBySaleId: s,
      });
      const c = await ctx.db.insert("vehicleCommitmentClaims", {
        orgId: w.orgId, rootId: root, vehicleId: a.vehicleId, evidenceKind: "FINANCE", status: "ACTIVE", applicationId: app, createdAt: 1, createdBy: w.actorId,
      } as never);
      return [s, c, root] as const;
    });
    const m = await preview(w, { saleIds: [sale], applicationIds: [app] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.vehicleCommitmentClaims).toEqual([claimId]);
    expect(m.idsByTable.commitmentRoots).toEqual([rootId]);
  });

  test("a claim on a kept CANCELLED finance application (production application 16) leaves with its consumed root", async () => {
    const b = await base("pos-cancelled-app");
    const claimId = await b.w.t.run((ctx) => ctx.db.insert("vehicleCommitmentClaims", {
      orgId: b.w.orgId, rootId: b.root, vehicleId: b.vehicleId, evidenceKind: "FINANCE", status: "ACTIVE", applicationId: b.app._id, createdAt: 1, createdBy: b.w.actorId,
    } as never));
    const m = await preview(b.w, { saleIds: [b.sale] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.vehicleCommitmentClaims).toEqual([claimId]);
    expect(m.idsByTable.financeApplications).toBeUndefined();
  });
});
describe("refusals - one condition each (distinct codes, fail closed)", () => {
  test("COMMITMENT_ROOT_NOT_CONSUMED: a root that names the purged sale but is not CONSUMED never leaves", async () => {
    const b = await base("neg-not-consumed", { status: "OPEN", closedAt: undefined });
    const m = await preview(b.w, { saleIds: [b.sale] });
    expect(codes(m)).toEqual(["COMMITMENT_ROOT_NOT_CONSUMED"]);
    expect(m.idsByTable.commitmentRoots).toBeUndefined();
  });

  test("COMMITMENT_EVIDENCE_LIVE: the claim's evidence deposit is HELD (live) and kept", async () => {
    const b = await base("neg-evidence-live");
    await claim(b, await deposit(b, "HELD", { holdActive: true }));
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
  });

  test("COMMITMENT_EVIDENCE_LIVE: an approval of the claim's id does not lift it", async () => {
    const b = await base("neg-evidence-approved");
    const id = await claim(b, await deposit(b, "HELD", { holdActive: true }));
    expect(codes(await preview(b.w, { saleIds: [b.sale] }, [], [id]))).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
  });

  test("COMMITMENT_ACTIVE_HOLD: an ACTIVE deposit hold still points at the claim", async () => {
    const o = await okWorld("neg-active-hold");
    await o.w.t.run((ctx) => ctx.db.insert("depositVehicleHolds", {
      orgId: o.w.orgId, depositId: o.depositId, vehicleId: o.vehicleId, active: true, createdAt: 1, sourceCommitmentClaimId: o.claimId,
    }));
    expect(codes(await preview(o.w, { saleIds: [o.sale] }))).toEqual(["COMMITMENT_ACTIVE_HOLD"]);
  });

  test("the passing twin of the hold test: the same hold INACTIVE and still pointing at the claim is a kept referrer (SHARED_LINEAGE), not an active hold", async () => {
    const o = await okWorld("neg-inactive-hold");
    await o.w.t.run((ctx) => ctx.db.insert("depositVehicleHolds", {
      orgId: o.w.orgId, depositId: o.depositId, vehicleId: o.vehicleId, active: false, createdAt: 1, sourceCommitmentClaimId: o.claimId,
    }));
    expect(codes(await preview(o.w, { saleIds: [o.sale] }))).toEqual(["COMMITMENT_SHARED_LINEAGE"]);
  });

  test("COMMITMENT_SHARED_LINEAGE: a kept deposit still points at the claim (singleVehicleCommitmentClaimId)", async () => {
    const b = await base("neg-kept-deposit");
    const depositId = await deposit(b);
    const claimId = await claim(b, depositId);
    await b.w.t.run((ctx) => ctx.db.patch(depositId, { singleVehicleCommitmentClaimId: claimId }));
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toEqual(["COMMITMENT_SHARED_LINEAGE"]);
  });

  test("COMMITMENT_SHARED_LINEAGE: a kept finance application still names the claim as its current commitment", async () => {
    const o = await okWorld("neg-kept-application");
    await o.w.t.run((ctx) => ctx.db.patch(o.w.targets[1].applicationId as Id<"financeApplications">, { currentCommitmentClaims: [{ vehicleId: o.vehicleId, claimId: o.claimId }] }));
    expect(codes(await preview(o.w, { saleIds: [o.sale] }))).toEqual(["COMMITMENT_SHARED_LINEAGE"]);
  });

  test("COMMITMENT_SHARED_LINEAGE: another root of the same lineage is kept (a successor that is not consumed by this purge)", async () => {
    const b = await base("neg-kept-successor");
    await b.w.t.run((ctx) => ctx.db.insert("commitmentRoots", {
      orgId: b.w.orgId, vehicleId: b.vehicleId, customerId: b.customerId, status: "OPEN", openedAt: 3, openedBy: b.w.actorId, restoredFromRootId: b.root,
    }));
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toEqual(["COMMITMENT_SHARED_LINEAGE"]);
  });

  test("COMMITMENT_SHARED_LINEAGE: the claim's root is a KEPT root that is already finished (history of another lineage)", async () => {
    const w = await seedWorld("neg-claim-kept-root");
    await reverseDeal(w, 0);
    const app = w.targets[0].applicationId as Id<"financeApplications">;
    await w.t.run(async (ctx) => {
      const a = (await ctx.db.get(app))!;
      const root = await ctx.db.insert("commitmentRoots", {
        orgId: w.orgId, vehicleId: a.vehicleId, customerId: a.customerId, status: "RELEASED", openedAt: 1, openedBy: w.actorId,
      });
      await ctx.db.insert("vehicleCommitmentClaims", {
        orgId: w.orgId, rootId: root, vehicleId: a.vehicleId, evidenceKind: "FINANCE", status: "RELEASED", applicationId: app, createdAt: 1, createdBy: w.actorId,
      } as never);
    });
    expect(codes(await preview(w, { applicationIds: [app] }))).toEqual(["COMMITMENT_SHARED_LINEAGE"]);
  });

  test("COMMITMENT_CURRENT_FOR_VEHICLE: an ACTIVE claim of a kept OPEN root is the car's live commitment", async () => {
    const w = await seedWorld("neg-current");
    await reverseDeal(w, 0);
    const app = w.targets[0].applicationId as Id<"financeApplications">;
    await w.t.run(async (ctx) => {
      const a = (await ctx.db.get(app))!;
      const root = await ctx.db.insert("commitmentRoots", {
        orgId: w.orgId, vehicleId: a.vehicleId, customerId: a.customerId, status: "OPEN", openedAt: 1, openedBy: w.actorId,
      });
      await ctx.db.insert("vehicleCommitmentClaims", {
        orgId: w.orgId, rootId: root, vehicleId: a.vehicleId, evidenceKind: "FINANCE", status: "ACTIVE", applicationId: app, createdAt: 1, createdBy: w.actorId,
      } as never);
    });
    expect(codes(await preview(w, { applicationIds: [app] }))).toEqual(["COMMITMENT_CURRENT_FOR_VEHICLE"]);
  });

  test("a claim whose root a KEPT sale consumed stays SHARED_WITH_LIVE (the existing join guard still holds)", async () => {
    const b = await base("neg-kept-sale");
    const keptSale = await b.w.t.run((ctx) => ctx.db.insert("sales", {
      orgId: b.w.orgId, vehicleId: b.vehicleId, customerId: b.customerId, salespersonId: b.w.actorId, salePrice: 1, saleDate: 1, status: "COMPLETED",
    } as never));
    await claim(b, await deposit(b), { status: "CONSUMED", consumedBySaleId: keptSale });
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toContain("SHARED_WITH_LIVE");
  });

  test("COMMITMENT_ACTIVE_HOLD: a legacy ACTIVE hold (no claim pointer) of the same deposit and vehicle still backs the claim", async () => {
    const o = await okWorld("neg-legacy-hold");
    await o.w.t.run((ctx) => ctx.db.insert("depositVehicleHolds", {
      orgId: o.w.orgId, depositId: o.depositId, vehicleId: o.vehicleId, active: true, createdAt: 1,
    }));
    expect(codes(await preview(o.w, { saleIds: [o.sale] }))).toEqual(["COMMITMENT_ACTIVE_HOLD"]);
  });

  test("COMMITMENT_SHARED_LINEAGE: the purged root was restored from a KEPT root (its predecessor lives on)", async () => {
    const b = await base("neg-kept-predecessor");
    const before = await b.w.t.run((ctx) => ctx.db.insert("commitmentRoots", {
      orgId: b.w.orgId, vehicleId: b.vehicleId, customerId: b.customerId, status: "RELEASED", openedAt: 0, openedBy: b.w.actorId,
    }));
    await b.w.t.run((ctx) => ctx.db.patch(b.root, { restoredFromRootId: before }));
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toEqual(["COMMITMENT_SHARED_LINEAGE"]);
  });

  test("a CONSUMED root consumed by a KEPT sale never joins the purge of another sale (and is no refusal)", async () => {
    const b = await base("kept-consumer");
    const keptSale = await b.w.t.run((ctx) => ctx.db.insert("sales", {
      orgId: b.w.orgId, vehicleId: b.vehicleId, customerId: b.customerId, salespersonId: b.w.actorId, salePrice: 1, saleDate: 1, status: "COMPLETED",
    } as never));
    const other = await b.w.t.run((ctx) => ctx.db.insert("commitmentRoots", {
      orgId: b.w.orgId, vehicleId: b.vehicleId, customerId: b.customerId, status: "CONSUMED", openedAt: 1, openedBy: b.w.actorId, consumedBySaleId: keptSale,
    }));
    const m = await preview(b.w, { saleIds: [b.sale] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.commitmentRoots).toEqual([b.root]);
    expect(m.idsByTable.commitmentRoots).not.toContain(other);
  });});

describe("the dry run stays read-only", () => {
  test("no commitment, claim, hold or deposit row changes", async () => {
    const o = await okWorld("readonly");
    const read = () => o.w.t.run(async (ctx) => JSON.stringify([
      await ctx.db.get(o.root), await ctx.db.get(o.claimId), await ctx.db.get(o.depositId),
    ]));
    const before = await read();
    await preview(o.w, { saleIds: [o.sale] });
    expect(await read()).toBe(before);
  });
});
