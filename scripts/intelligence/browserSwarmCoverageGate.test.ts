import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runBrowserSwarmCoverageGate } from "./browserSwarmCoverageGate.mjs";

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

  it("refuses unexecutable mandatory missions before anything is provisioned", async () => {
    await withImpact(
      impact([
        { id: "ECON-2", severity: "CRITICAL" },
        { id: "ACC-1", severity: "CRITICAL" },
      ]),
      async (repoRoot) => {
        await expect(runBrowserSwarmCoverageGate({ repoRoot, env })).rejects.toThrow(
          /no executable handler.*MONEY_BOUNDARY.*ACC-1/i,
        );
      },
    );
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
