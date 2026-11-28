import type { Doc, Id } from "../convex/_generated/dataModel";
import type { World } from "./scrum987Fixture";

/**
 * Shared world builders of the SCRUM-1023 phase 1c commitment tests (`commitments1c` and `commitments1c.evidence`): a
 * purged sale that consumed one root of the first deal's car, plus deposit and claim inserts. `seedWorld` is passed in
 * because the module glob it needs must be taken from the calling test file's own directory.
 */
export interface Base {
  w: World;
  sale: Id<"sales">;
  root: Id<"commitmentRoots">;
  vehicleId: Id<"vehicles">;
  customerId: Id<"customers">;
  app: Doc<"financeApplications">;
}

export function makeFixture(seedWorld: (suffix: string) => Promise<World>) {
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

  return { base, deposit, claim, okWorld };
}