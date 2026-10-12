import { test, expect } from "@playwright/test";
import { createInitialBrowserAttackHandlers } from "../../scripts/intelligence/browserAttackSwarmHandlers";
import { executeBrowserSwarmWorker } from "../../scripts/intelligence/browserAttackSwarmExecutor";
import {
  assertBrowserSwarmExecutionEnvironment,
  browserSwarmManifestFromEnv,
} from "../../scripts/intelligence/browserAttackSwarmRuntime";
import { verifyBrowserSwarmPreview } from "../../scripts/intelligence/browserAttackSwarmPreviewVerifier.mjs";

const enabled = process.env.BROWSER_SWARM_ENABLED === "1";

if (enabled) {
  test.describe("SCRUM-350 browser adversarial swarm", () => {
    // SCRUM-826 F1: a retry-pass must never hide a confirmed breach or harness
    // error from attempt 1 (Playwright exits 0 when a retry passes), and the
    // missions mutate the shared preview, so they must not run twice either.
    test.describe.configure({ retries: 0 });

    test("executes the assigned deterministic/Jev mission partition", async ({}, testInfo) => {
    if (testInfo.retry > 0) {
      throw new Error("trusted swarm never retries");
    }
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
}
