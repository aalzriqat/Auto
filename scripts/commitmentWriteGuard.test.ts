import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  auditCommitmentWrites,
  convexSourceFiles,
  findUnchokedWrites,
  summarize,
} from "./commitmentWriteGuard";

const CONVEX_ROOT = path.resolve(__dirname, "..", "convex");

/**
 * SCRUM-208 — THE RATCHET.
 *
 * Every write to a commitment liveness field that currently happens outside
 * the writer choke. New entries fail CI; removing one without updating this
 * map ALSO fails, so the debt cannot be quietly re-hidden after being paid.
 *
 * ⚠️ THIS IS A BURN-DOWN LIST, NOT AN ALLOWLIST. Each entry is a site Phase 3
 * routes through `utils/commitmentWriters.ts`. The three `vehicles.ts` sites
 * that motivated the guard are already gone from it — that absence is the
 * assertion, which is why the map is compared exactly rather than as a
 * ceiling.
 */
const BASELINE: Record<string, number> = {
  // The deposit module's own writers. In-module, so they are the least
  // dangerous of the set, but still not routed through one function.
  "deposits.ts::holdActive": 1,
  "deposits.ts::insert:depositVehicleHolds": 3,
  "utils/depositHelpers.ts::holdActive": 6,
  "utils/depositRecording.ts::holdActive": 1,
  "utils/saleCancellation.ts::holdActive": 2,
  // vehicles.ts is deliberately ABSENT. Its three raw
  // `ctx.db.patch(reservation.depositId, { holdActive: false })` calls were
  // the round-4 finding and are now routed through
  // `releaseReservationDepositHold`. This map is compared exactly, so their
  // return would fail CI.
};

describe("commitment liveness writes go through the choke", () => {
  it("matches the recorded burn-down list exactly", () => {
    expect(summarize(auditCommitmentWrites(CONVEX_ROOT))).toEqual(BASELINE);
  });

  it("no longer sees a raw holdActive write in vehicles.ts", () => {
    const offenders = auditCommitmentWrites(CONVEX_ROOT).filter(
      (w) => w.file === "vehicles.ts" && w.field === "holdActive"
    );
    expect(offenders).toEqual([]);
  });

  it("analyses a surface large enough for the result to mean something", () => {
    // A green result from an analyzer that examined nothing is
    // indistinguishable from a green result from a clean backend.
    expect(convexSourceFiles(CONVEX_ROOT).length).toBeGreaterThan(100);
  });

  describe("what the analyzer actually detects", () => {
    it("catches a raw patch of a guarded field outside the choke", () => {
      const source = `await ctx.db.patch(reservation.depositId, { holdActive: false });`;
      expect(findUnchokedWrites(source, "vehicles.ts")).toEqual([
        { file: "vehicles.ts", method: "patch", field: "holdActive" },
      ]);
    });

    it("catches an insert into a guarded table — liveness is born at insert", () => {
      const source = `await ctx.db.insert("depositVehicleHolds", { vehicleId, active: true });`;
      expect(findUnchokedWrites(source, "deposits.ts")).toEqual([
        { file: "deposits.ts", method: "insert", field: "insert:depositVehicleHolds" },
      ]);
    });

    it("catches a replace that carries a guarded field", () => {
      const source = `await ctx.db.replace(id, { usesVehicleHoldRows: true });`;
      expect(findUnchokedWrites(source, "migrations.ts")).toHaveLength(1);
    });

    it("allows the choke modules themselves to write", () => {
      const source = `await ctx.db.patch(deposit._id, { holdActive: false });`;
      expect(findUnchokedWrites(source, "utils/commitmentWriters.ts")).toEqual([]);
    });

    it("does not flag an unrelated table that happens to have a status", () => {
      const source = `await ctx.db.patch(leadId, { status: "WON", active: true });`;
      expect(findUnchokedWrites(source, "leads.ts")).toEqual([]);
    });

    it("does not mistake a later object literal for this call's argument", () => {
      const source = `await ctx.db.patch(id, someVar);\nconst other = { holdActive: true };`;
      expect(findUnchokedWrites(source, "leads.ts")).toEqual([]);
    });
  });
});
