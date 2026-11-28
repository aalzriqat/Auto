import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { seedWorld as seedWorldWith, OCT_20 } from "../test-utils/scrum987Fixture";
import { makeFixture } from "../test-utils/purgeCommitments1cFixture";
import type { Base } from "../test-utils/purgeCommitments1cFixture";
import { codes, preview, reverseDeal } from "../test-utils/purgePreview";
import type { Id } from "./_generated/dataModel";

/**
 * SCRUM-1023 Phase 1c, evidence rules (review rounds 1 and 2 of PR #913): a claim that joins with its root is still judged by
 * the kept evidence row it names (invariant I10), the own-sale shortcut never finishes a claim over kept live evidence and
 * only for the root's own sale, and the shapes the packet discloses as not proven are pinned. Read-only: the dry run never writes.
 */

const MODULES = import.meta.glob("./**/*.*s");
const seedWorld = (suffix: string) => seedWorldWith(MODULES, suffix, {});
const { base, deposit, claim } = makeFixture(seedWorld);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => { vi.useRealTimers(); });
describe("round 1 F1 - a claim that joins with its root is still judged by the live evidence it names (invariant I10)", () => {
  const statuses = ["ACTIVE", "RELEASED", "CONSUMED"] as const;
  const statusExtra = (b: Base, status: (typeof statuses)[number]) => ({ status, ...(status === "CONSUMED" ? { consumedBySaleId: b.sale } : {}) });

  test.each(statuses)("a %s FINANCE claim naming a kept APPROVED application (which names neither the sale nor the claim) refuses COMMITMENT_EVIDENCE_LIVE", async (status) => {
    const b = await base(`f1-app-${status}`);
    await b.w.t.run((ctx) => ctx.db.patch(b.app._id, { status: "APPROVED" }));
    await claim(b, "" as Id<"deposits">, { evidenceKind: "FINANCE", applicationId: b.app._id, depositId: undefined, ...statusExtra(b, status) });
    const m = await preview(b.w, { saleIds: [b.sale] });
    expect(codes(m)).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
  });

  test.each(statuses)("twin: the same %s claim on the same application once it is CANCELLED and bound leaves with its root", async (status) => {
    const b = await base(`f1-app-twin-${status}`);
    await b.w.t.run((ctx) => ctx.db.patch(b.app._id, { status: "CANCELLED" }));
    const id = await claim(b, "" as Id<"deposits">, { evidenceKind: "FINANCE", applicationId: b.app._id, depositId: undefined, ...statusExtra(b, status) });
    const m = await preview(b.w, { saleIds: [b.sale] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.vehicleCommitmentClaims).toEqual([id]);
  });

  test.each(statuses)("a %s DEPOSIT claim naming a kept HELD deposit refuses COMMITMENT_EVIDENCE_LIVE", async (status) => {
    const b = await base(`f1-deposit-${status}`);
    await claim(b, await deposit(b, "HELD", { holdActive: false }), statusExtra(b, status));
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
  });

  test.each(statuses)("a %s RESERVATION claim naming a kept reservation refuses COMMITMENT_EVIDENCE_LIVE (a reservation has no terminal state)", async (status) => {
    const b = await base(`f1-reservation-${status}`);
    const reservationId = await b.w.t.run((ctx) => ctx.db.insert("vehicleReservations", {
      orgId: b.w.orgId, vehicleId: b.vehicleId, customerId: b.customerId, status: "RELEASED", reservedBy: b.w.actorId, reservedAt: 1,
    }));
    await claim(b, "" as Id<"deposits">, { evidenceKind: "RESERVATION", reservationId, depositId: undefined, ...statusExtra(b, status) });
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
  });

  test("reverse direction: a RELEASED claim on a kept CANCELLED application that names ANOTHER kept claim as its current commitment is not bound, so it refuses", async () => {
    const b = await base("f1-reverse-pointer");
    await b.w.t.run(async (ctx) => {
      const root = await ctx.db.insert("commitmentRoots", { orgId: b.w.orgId, vehicleId: b.vehicleId, customerId: b.customerId, status: "OPEN", openedAt: 3, openedBy: b.w.actorId });
      const keptClaim = await ctx.db.insert("vehicleCommitmentClaims", {
        orgId: b.w.orgId, rootId: root, vehicleId: b.vehicleId, evidenceKind: "FINANCE", status: "ACTIVE", applicationId: b.app._id, createdAt: 3, createdBy: b.w.actorId,
      } as never);
      await ctx.db.patch(b.app._id, { status: "CANCELLED", currentCommitmentClaims: [{ vehicleId: b.vehicleId, claimId: keptClaim }] });
    });
    await claim(b, "" as Id<"deposits">, { evidenceKind: "FINANCE", applicationId: b.app._id, depositId: undefined, status: "RELEASED" });
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toContain("COMMITMENT_EVIDENCE_LIVE");
  });
  test("twin: a RELEASED claim whose kept evidence deposit is REFUNDED but belongs to another customer is not bound, so it refuses too", async () => {
    const b = await base("f1-unbound-kept");
    const other = await b.w.t.run(async (ctx) => (await ctx.db.get(b.w.targets[1].applicationId as Id<"financeApplications">))!.customerId);
    await claim(b, await deposit(b, "REFUNDED", { customerId: other }), { status: "RELEASED" });
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
  });
});

describe("round 1 F3 - 'consumed by a purged sale' finishes a claim only when that sale is the root's own sale", () => {
  async function otherPurgedSale(b: Base): Promise<Id<"sales">> {
    return await b.w.t.run((ctx) => ctx.db.insert("sales", {
      orgId: b.w.orgId, vehicleId: b.vehicleId, customerId: b.customerId, salespersonId: b.w.actorId, salePrice: 1, saleDate: 2, status: "CANCELLED", isDeleted: true,
    } as never));
  }
  const reservation = (b: Base) => b.w.t.run((ctx) => ctx.db.insert("vehicleReservations", {
    orgId: b.w.orgId, vehicleId: b.vehicleId, customerId: b.customerId, status: "ACTIVE", reservedBy: b.w.actorId, reservedAt: 1,
  }));

  test("twin of the own-sale control: the SAME claim (reservation row not read) consumed by ANOTHER purged sale refuses COMMITMENT_EVIDENCE_LIVE", async () => {
    const b = await base("f3-other-sale");
    const other = await otherPurgedSale(b);
    const reservationId = await reservation(b);
    await claim(b, "" as Id<"deposits">, { evidenceKind: "RESERVATION", reservationId, depositId: undefined, consumedBySaleId: other });
    await b.w.t.run((ctx) => ctx.db.delete(reservationId));
    const m = await preview(b.w, { saleIds: [b.sale, other] });
    expect(codes(m)).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
    expect(m.ok).toBe(false);
  });

  test("twin, evidence PURGED but not bound: an ACTIVE claim consumed by ANOTHER purged sale whose purged application belongs to another customer refuses", async () => {
    const w = await seedWorld("f3-other-sale-unbound-purged");
    await reverseDeal(w, 0);
    const app = w.targets[0].applicationId as Id<"financeApplications">;
    const ids = await w.t.run(async (ctx) => {
      const mine = (await ctx.db.get(app))!;
      const other = (await ctx.db.get(w.targets[1].applicationId as Id<"financeApplications">))!;
      const sale = await ctx.db.insert("sales", {
        orgId: w.orgId, vehicleId: other.vehicleId, customerId: other.customerId, salespersonId: w.actorId, salePrice: 1, saleDate: 1, status: "CANCELLED", isDeleted: true,
      } as never);
      const second = await ctx.db.insert("sales", {
        orgId: w.orgId, vehicleId: other.vehicleId, customerId: other.customerId, salespersonId: w.actorId, salePrice: 1, saleDate: 2, status: "CANCELLED", isDeleted: true,
      } as never);
      const root = await ctx.db.insert("commitmentRoots", {
        orgId: w.orgId, vehicleId: other.vehicleId, customerId: other.customerId, status: "CONSUMED", openedAt: 1, openedBy: w.actorId, consumedBySaleId: sale,
      });
      await ctx.db.insert("vehicleCommitmentClaims", {
        orgId: w.orgId, rootId: root, vehicleId: other.vehicleId, evidenceKind: "FINANCE", status: "ACTIVE", applicationId: mine._id, consumedBySaleId: second, createdAt: 1, createdBy: w.actorId,
      } as never);
      return { sale, second };
    });
    expect(codes(await preview(w, { saleIds: [ids.sale, ids.second], applicationIds: [app] }))).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
  });

  test("an ACTIVE RESERVATION claim consumed by the root's own purged sale whose reservation row is KEPT refuses (a reservation has no terminal state)", async () => {
    const b = await base("f3-own-sale-kept-reservation");
    await claim(b, "" as Id<"deposits">, { evidenceKind: "RESERVATION", reservationId: await reservation(b), depositId: undefined, consumedBySaleId: b.sale });
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
  });

  test("control: the same claim consumed by the root's own purged sale leaves when its reservation row was not read (deleted): nothing live is shown", async () => {
    const b = await base("f3-own-sale");
    const reservationId = await reservation(b);
    const id = await claim(b, "" as Id<"deposits">, { evidenceKind: "RESERVATION", reservationId, depositId: undefined, consumedBySaleId: b.sale });
    await b.w.t.run((ctx) => ctx.db.delete(reservationId));
    const m = await preview(b.w, { saleIds: [b.sale] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.vehicleCommitmentClaims).toEqual([id]);
  });

  test("an ACTIVE FINANCE claim consumed by the root's own purged sale that names a kept APPROVED application refuses COMMITMENT_EVIDENCE_LIVE", async () => {
    const b = await base("f3-own-sale-approved-app");
    await b.w.t.run((ctx) => ctx.db.patch(b.app._id, { status: "APPROVED" }));
    await claim(b, "" as Id<"deposits">, { evidenceKind: "FINANCE", applicationId: b.app._id, depositId: undefined, consumedBySaleId: b.sale });
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
  });

  test("twin: the same ACTIVE claim on the CANCELLED bound application leaves", async () => {
    const b = await base("f3-own-sale-cancelled-app");
    await b.w.t.run((ctx) => ctx.db.patch(b.app._id, { status: "CANCELLED" }));
    const id = await claim(b, "" as Id<"deposits">, { evidenceKind: "FINANCE", applicationId: b.app._id, depositId: undefined, consumedBySaleId: b.sale });
    const m = await preview(b.w, { saleIds: [b.sale] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.vehicleCommitmentClaims).toEqual([id]);
  });

  test("an ACTIVE DEPOSIT claim consumed by the root's own purged sale that names a kept HELD deposit refuses COMMITMENT_EVIDENCE_LIVE", async () => {
    const b = await base("f3-own-sale-held-deposit");
    await claim(b, await deposit(b, "HELD", { holdActive: false }), { consumedBySaleId: b.sale });
    expect(codes(await preview(b.w, { saleIds: [b.sale] }))).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
  });
});

describe("characterizations disclosed in the packet (not proven safe, pinned so a change is noticed)", () => {
  test("a RELEASED claim whose evidence id names a row that is not read (deleted) is NOT refused, while the same ACTIVE claim is", async () => {
    const released = await base("char-released-not-read");
    const d1 = await deposit(released);
    await claim(released, d1, { status: "RELEASED" });
    await released.w.t.run((ctx) => ctx.db.delete(d1));
    expect((await preview(released.w, { saleIds: [released.sale] })).refusals).toEqual([]);
    const active = await base("char-active-not-read");
    const d2 = await deposit(active);
    await claim(active, d2, { status: "ACTIVE" });
    await active.w.t.run((ctx) => ctx.db.delete(d2));
    expect(codes(await preview(active.w, { saleIds: [active.sale] }))).toEqual(["COMMITMENT_EVIDENCE_LIVE"]);
  });

  test("a secondary reference is not judged: a RELEASED RESERVATION claim (reservation row deleted) whose depositId names a kept HELD deposit leaves", async () => {
    const b = await base("char-secondary-ref");
    const held = await deposit(b, "HELD", { holdActive: false });
    const reservationId = await b.w.t.run((ctx) => ctx.db.insert("vehicleReservations", {
      orgId: b.w.orgId, vehicleId: b.vehicleId, customerId: b.customerId, status: "ACTIVE", reservedBy: b.w.actorId, reservedAt: 1,
    }));
    const id = await claim(b, held, { evidenceKind: "RESERVATION", reservationId, status: "RELEASED" });
    await b.w.t.run((ctx) => ctx.db.delete(reservationId));
    const m = await preview(b.w, { saleIds: [b.sale] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.vehicleCommitmentClaims).toEqual([id]);
  });
});
