import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBrowserSwarmCoverageGate } from "./browserSwarmCoverageGate.mjs";
import { FORGED_MISSION_REFUSAL } from "./browserSwarmForgedMissionFixture";

// Test seam: the gate only calls assertMandatoryBrowserSwarmCoverage, which plans internally. When `forge` is
// set, the REAL function runs first (real plan, real assertion), then the REAL assertBrowserSwarmMissionsExecutable
// judges that plan plus one mission no handler judges. Nothing about the refusal is stubbed; only the extra mission is added.
const seam = vi.hoisted(() => ({ forge: false }));
vi.mock("./browserAttackSwarm.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./browserAttackSwarm")>();
  const { FORGED_UNEXECUTABLE_MONEY_MISSION } = await import("./browserSwarmForgedMissionFixture");
  return {
    ...original,
    assertMandatoryBrowserSwarmCoverage: (...args: Parameters<typeof original.assertMandatoryBrowserSwarmCoverage>) => {
      const plan = original.assertMandatoryBrowserSwarmCoverage(...args);
      if (seam.forge) original.assertBrowserSwarmMissionsExecutable([...plan.missions, FORGED_UNEXECUTABLE_MONEY_MISSION]);
      return plan;
    },
  };
});
afterEach(() => {
  seam.forge = false;
});

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

function impact(
  impactedInvariants: Array<{ id: string; severity: "CRITICAL" | "HIGH" }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    authority: "TRUSTED_MAIN_CANONICAL_GIT_IMPACT",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    changedFiles: ["playwright/tests/example.spec.ts"],
    impactedInvariants,
    shouldRun: impactedInvariants.length > 0,
    ...overrides,
  };
}

async function withImpact<T>(
  value: unknown,
  body: (repoRoot: string) => Promise<T>,
): Promise<T> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "autoflow-swarm-coverage-"));
  try {
    await mkdir(path.join(repoRoot, "artifacts"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "artifacts/browser-swarm-trusted-impact.json"),
      JSON.stringify(value),
      "utf8",
    );
    return await body(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

const env = { BASE_SHA, HEAD_SHA };

describe("SCRUM-826 trusted coverage gate before preview provisioning", () => {
  it("passes ECON-2 and writes the executable mandatory mission evidence", async () => {
    await withImpact(impact([{ id: "ECON-2", severity: "CRITICAL" }]), async (repoRoot) => {
      const result = await runBrowserSwarmCoverageGate({ repoRoot, env });
      expect(result.status).toBe("EXECUTABLE");

      const written = JSON.parse(
        await readFile(
          path.join(repoRoot, "artifacts/browser-swarm-coverage.json"),
          "utf8",
        ),
      );
      expect(written).toMatchObject({
        version: 1,
        authority: "TRUSTED_MAIN_BROWSER_SWARM_COVERAGE",
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        status: "EXECUTABLE",
      });
      expect(
        written.mandatoryMissions.map((mission: { family: string }) => mission.family),
      ).toEqual(["DUPLICATE_SUBMIT", "MULTI_TAB_RACE"]);
    });
  });

  // Every active mandatory mapping has a handler now, so no real impact set reaches the refusal; the seam
  // above adds a MONEY_BOUNDARY / UI_BACKEND_AUTHORITY mission so the gate's refusal branch stays tested.
  it("refuses unexecutable mandatory missions before anything is provisioned, and records the refusal as evidence", async () => {
    seam.forge = true;
    await withImpact(
      impact([
        { id: "ECON-2", severity: "CRITICAL" },
        { id: "ACC-1", severity: "CRITICAL" },
      ]),
      async (repoRoot) => {
        await expect(runBrowserSwarmCoverageGate({ repoRoot, env })).rejects.toThrow(FORGED_MISSION_REFUSAL);
        const written = JSON.parse(await readFile(path.join(repoRoot, "artifacts/browser-swarm-coverage.json"), "utf8"));
        expect(written).toMatchObject({
          version: 1,
          authority: "TRUSTED_MAIN_BROWSER_SWARM_COVERAGE",
          baseSha: BASE_SHA,
          headSha: HEAD_SHA,
          status: "REFUSED_UNEXECUTABLE_MANDATORY_MISSIONS",
          mandatoryMissions: [],
        });
        expect(written.reason).toMatch(FORGED_MISSION_REFUSAL);
      },
    );
  });

  it("plans LIFE-1's MONEY_BOUNDARY / STATE_TRANSITION fee-void mission as executable", async () => {
    await withImpact(
      impact([
        { id: "ECON-2", severity: "CRITICAL" },
        { id: "LIFE-1", severity: "CRITICAL" },
      ]),
      async (repoRoot) => {
        const result = await runBrowserSwarmCoverageGate({ repoRoot, env });
        expect(result.status).toBe("EXECUTABLE");
        expect(
          result.mandatoryMissions.map((mission: { family: string; oracle: string }) => `${mission.family}/${mission.oracle}`),
        ).toContain("MONEY_BOUNDARY/STATE_TRANSITION");
      },
    );
  });

  it("plans ACC-3's ACCOUNTING_DATE_BOUNDARY / STATE_TRANSITION mission as executable", async () => {
    await withImpact(impact([{ id: "ACC-3", severity: "CRITICAL" }]), async (repoRoot) => {
      const result = await runBrowserSwarmCoverageGate({ repoRoot, env });
      expect(result.status).toBe("EXECUTABLE");
      expect(
        result.mandatoryMissions.map((mission: { family: string; oracle: string }) => `${mission.family}/${mission.oracle}`),
      ).toEqual(["ACCOUNTING_DATE_BOUNDARY/STATE_TRANSITION"]);
    });
  });

  it("refuses an absent or unparseable impact artifact for an ACC-3 change, and writes no coverage as if it had passed", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "autoflow-swarm-coverage-"));
    try {
      const artifacts = path.join(repoRoot, "artifacts");
      await mkdir(artifacts, { recursive: true });
      await expect(runBrowserSwarmCoverageGate({ repoRoot, env })).rejects.toThrow(/missing or is not valid JSON/);
      await writeFile(path.join(artifacts, "browser-swarm-trusted-impact.json"), '{"impactedInvariants": [{"id": "ACC-3"', "utf8");
      await expect(runBrowserSwarmCoverageGate({ repoRoot, env })).rejects.toThrow(/missing or is not valid JSON/);
      await expect(readFile(path.join(artifacts, "browser-swarm-coverage.json"), "utf8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("records an explicit no-impact result instead of planning missions", async () => {
    await withImpact(impact([]), async (repoRoot) => {
      const result = await runBrowserSwarmCoverageGate({ repoRoot, env });
      expect(result.status).toBe("NO_MANDATORY_IMPACT");
      expect(result.mandatoryMissions).toEqual([]);
    });
  });

  it("refuses an impact artifact from another base/head pair", async () => {
    await withImpact(
      impact([{ id: "ECON-2", severity: "CRITICAL" }], { headSha: "c".repeat(40) }),
      async (repoRoot) => {
        await expect(runBrowserSwarmCoverageGate({ repoRoot, env })).rejects.toThrow(
          /exact base\/head/,
        );
      },
    );
  });

  it("refuses a forged shouldRun flag", async () => {
    await withImpact(
      impact([{ id: "ECON-2", severity: "CRITICAL" }], { shouldRun: false }),
      async (repoRoot) => {
        await expect(runBrowserSwarmCoverageGate({ repoRoot, env })).rejects.toThrow(
          /shouldRun/,
        );
      },
    );
  });
});
