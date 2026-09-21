import { test, expect } from "@playwright/test";
import { createInitialBrowserAttackHandlers } from "../../scripts/intelligence/browserAttackSwarmHandlers";
import { executeBrowserSwarmWorker } from "../../scripts/intelligence/browserAttackSwarmExecutor";
import {
  assertBrowserSwarmExecutionEnvironment,
  browserSwarmManifestFromEnv,
} from "../../scripts/intelligence/browserAttackSwarmRuntime";
import { verifyBrowserSwarmPreview } from "../../scripts/intelligence/browserAttackSwarmPreviewVerifier.mjs";

const enabled = process.env.BROWSER_SWARM_ENABLED === "1";

test.describe("SCRUM-350 browser adversarial swarm", () => {
  test.skip(!enabled, "Browser swarm is only enabled by its dedicated preview workflow.");

  test("executes the assigned deterministic/Jev mission partition", async ({}, testInfo) => {
    assertBrowserSwarmExecutionEnvironment(process.env);
    const { manifest, workerId } = browserSwarmManifestFromEnv(process.env);
    const worker = manifest.workers.find((entry) => entry.workerId === workerId);
    if (!worker) throw new Error("Browser swarm worker missing from manifest");
    const missionTimeoutBudget = worker.missions.reduce(
      (total, mission) => total + mission.timeoutMs,
      0,
    );
    testInfo.setTimeout(Math.max(60_000, missionTimeoutBudget + 60_000));

    await testInfo.attach("browser-swarm-manifest.json", {
      body: Buffer.from(JSON.stringify(manifest, null, 2)),
      contentType: "application/json",
    });

    const execution = await executeBrowserSwarmWorker({
      manifest,
      workerId,
      verifyPreviewTarget: (runManifest) =>
        verifyBrowserSwarmPreview(runManifest, process.env),
      handlers: createInitialBrowserAttackHandlers(),
    });

    await testInfo.attach("browser-swarm-execution.json", {
      body: Buffer.from(JSON.stringify(execution, null, 2)),
      contentType: "application/json",
    });

    expect(
      execution.harnessErrorCount,
      JSON.stringify(execution.results, null, 2),
    ).toBe(0);
    expect(
      execution.confirmedBreachCount,
      JSON.stringify(execution.results, null, 2),
    ).toBe(0);
    expect(execution.passed).toBe(true);
  });
});
