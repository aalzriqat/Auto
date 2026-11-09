import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { verifySupplierLaunchEvidence } from "./supplierLaunchGate";

// Execute the actual .mjs phase. CLI responses and process termination are I/O boundaries.
test.each(["unresolved", "unreadable"])("actual rollout phase stops on %s evidence without exposing values", kind => {
  const source = readFileSync("scripts/rolloutRelease.mjs", "utf8").replaceAll("\r\n", "\n");
  const start = source.indexOf("function requireSupplierLaunchEvidence()");
  const end = source.indexOf("\n}\n", start) + 2;
  expect(start).toBeGreaterThan(0);
  const scope = { verifySupplierLaunchEvidence, convex: () => kind === "unreadable" ? { ok: false, reason: "PRIVATE" } :
    { ok: true, value: { status: "READY", cursor: null, examined: 1,
      counts: { MISSING_SUPPLIER_ID: 1, MISSING_PAYEE_ID: 0, MISSING_BEARER_ID: 0, MISSING_SOURCE: 0 } } },
    rolloutStartedAt: Date.now(), TIMEOUT_MS: 10000, supplierIdentitySummary: null, lastOutcome: "verified",
    console: { log: () => undefined }, fail: (message: string) => { throw new Error(message); } };
  expect(() => vm.runInNewContext(`${source.slice(start, end)}\nrequireSupplierLaunchEvidence();`, scope))
    .toThrow(/DEPLOYED, but INCOMPLETE: supplier launch evidence/);
  expect(scope.lastOutcome).toBe("failed");
  expect(JSON.stringify(scope.supplierIdentitySummary)).not.toContain("PRIVATE");
});
