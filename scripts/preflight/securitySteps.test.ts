// @vitest-environment node
// SCRUM-1011: the `picomatch-backport` preflight step, the required dependency-audit script CI runs after install.
import { describe, expect, it } from "vitest";
import { byId, run } from "./preflightHarness";

describe("SCRUM-1011 picomatch-backport step (CI dependency-audit: verifyPicomatchBackport.mjs)", () => {
  it("is NOT APPLICABLE when no dependency input changed", async () => {
    const h = await run({ changed: [["M", "lib/a.ts"]] });
    expect(byId(h, "picomatch-backport").status).toBe("NOT APPLICABLE");
    expect(h.calls.some((c) => c.id === "picomatch-backport")).toBe(false);
  });

  it.each(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vendor/picomatch/autoflow-picomatch-v4-4.0.7-autoflow.1.tgz", "dealer-worker/package-lock.json", "scripts/security/verifyPicomatchBackport.mjs"])(
    "runs the verifier when %s changed",
    async (file) => {
      const h = await run({ changed: [["M", file]] });
      const call = h.calls.find((c) => c.id === "picomatch-backport");
      expect(call?.args).toEqual(["scripts/security/verifyPicomatchBackport.mjs"]);
      expect(byId(h, "picomatch-backport").status).toBe("PASS");
    },
  );

  it("FAILS with the verifier's own message and the rule not to re-baseline blindly", async () => {
    const h = await run({
      changed: [["M", "pnpm-lock.yaml"]],
      outcomes: { "picomatch-backport": { status: 1, stderr: "Picomatch backport verification failed: Consumer compatibility baseline mismatch." } },
    });
    const r = byId(h, "picomatch-backport");
    expect(r.status).toBe("FAIL");
    expect(r.detail).toMatch(/Consumer compatibility baseline mismatch/);
    expect(r.fix.join("\n")).toMatch(/verifyPicomatchBackport\.mjs/);
    expect(r.fix.join("\n")).toMatch(/do not weaken/i);
    expect(h.code).toBe(1);
  });

  it("FAILS, never skips, when the verifier cannot be spawned or is missing", async () => {
    const spawn = await run({ changed: [["M", "package.json"]], outcomes: { "picomatch-backport": { status: null, error: new Error("spawn ENOENT") } } });
    expect(byId(spawn, "picomatch-backport").status).toBe("FAIL");
    const gone = await run({ changed: [["M", "package.json"]], existing: (p) => !/verifyPicomatchBackport/.test(p) });
    expect(byId(gone, "picomatch-backport").status).toBe("FAIL");
    expect(gone.calls.some((c) => c.id === "picomatch-backport")).toBe(false);
  });
});
