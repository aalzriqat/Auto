import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { runSupplierLaunchEvidencePhase } from "./releaseGuard";

const source = readFileSync("scripts/rolloutRelease.mjs", "utf8").replaceAll("\r\n", "\n");

// Execute both actual success branches and their shared helper; only CLI/exit are replaced.
function assertRolloutSuccess(mode: "empty" | "verified") {
  const helperStart = source.indexOf("function finishSuccessfulRollout(");
  expect(helperStart).toBeGreaterThan(0);
  const helper = source.slice(helperStart, source.indexOf("\n}\n", helperStart) + 2);
  const start = mode === "empty" ? source.indexOf("if (before.verdict.orgCount === 0)") :
    source.lastIndexOf('if (lastOutcome === "verified")');
  const branch = source.slice(start, source.indexOf("\n}\n", start) + 2);
  for (const kind of ["zero", "unresolved", "unreadable"]) {
    const calls: string[][] = [];
    const scope = {
      runSupplierLaunchEvidencePhase,

      convex: (args: string[]) => {
        calls.push(args);
        return kind === "unreadable" ? { ok: false, reason: "PRIVATE" } : { ok: true, value: {
          status: "READY", cursor: null, examined: 1,
          counts: { MISSING_SUPPLIER_ID: kind === "zero" ? 0 : 1, MISSING_PAYEE_ID: 0, MISSING_BEARER_ID: 0, MISSING_SOURCE: 0 },
        } };
      },
      before: { verdict: { orgCount: 0 } }, collectReport: () => ({ ok: true, verdict: { orgCount: 0 } }),
      decideEmptyRollout: () => ({ ok: true, outcome: "empty" }), lastVerdict: null,
      rolloutStartedAt: Date.now(), TIMEOUT_MS: 10000, supplierIdentitySummary: null, lastOutcome: "verified",
      EXPECTED_DEPLOYMENT: "fixture", console: { log: () => undefined },
      summaries: 0, exits: 0,
      writeSummary: () => { scope.summaries += 1; },
      process: { exit: () => { scope.exits += 1; } },
      fail: (message: string) => { throw new Error(message); },
    };
    const execute = () => vm.runInNewContext(`${helper}\n${branch}`, scope);
    if (kind === "zero") {
      execute();
      expect(scope.summaries).toBe(1);
      expect(scope.exits).toBe(1);
      expect(calls.map(args => JSON.parse(args[2]).table)).toEqual([
        "vehicleSupplierPayables", "vehicleSupplierReceivables", "supplierCostRecoveries", "supplierCostRecoveryReceipts",
        "openingPayablePayments", "vehicles", "vehicleOwnershipConversions", "financeApplications", "expenses", "vehicleEdits", "openingBalanceDrafts",
      ]);
    } else {
      expect(execute).toThrow(/DEPLOYED, but INCOMPLETE: supplier launch evidence/);
      expect(scope.lastOutcome).toBe("failed");
      expect(scope.summaries).toBe(0);
      expect(scope.exits).toBe(0);
    }
  }
}
test("empty rollout success requires complete supplier evidence", () => { assertRolloutSuccess("empty"); });
test("verified rollout success requires complete supplier evidence", () => { assertRolloutSuccess("verified"); });
