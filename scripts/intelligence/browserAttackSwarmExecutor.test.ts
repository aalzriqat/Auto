import { describe, expect, it, vi } from "vitest";
import type {
  BrowserAttackMission,
  BrowserSwarmRunManifest,
} from "./browserAttackSwarm";
import {
  BrowserSwarmExecutionError,
  executeBrowserSwarmWorker,
  type BrowserAttackHandlerRegistry,
} from "./browserAttackSwarmExecutor";

function mission(
  overrides: Partial<BrowserAttackMission> = {},
): BrowserAttackMission {
  return {
    id: "det::UI-1::UI_BACKEND_MISMATCH",
    family: "UI_BACKEND_MISMATCH",
    source: "DETERMINISTIC",
    invariantIds: ["UI-1"],
    invariantSeverity: "HIGH",
    oracle: "UI_BACKEND_AUTHORITY",
    timeoutMs: 100,
    estimatedCostUnits: 4,
    evidence: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
    ...overrides,
  };
}

function manifestFor(
  missions: readonly BrowserAttackMission[],
): BrowserSwarmRunManifest {
  return {
    version: 1,
    runId: "pr-350-worker-test",
    previewName: "e2e-pr-350-worker-test",
    expectedCloudUrl: "https://example-preview.convex.cloud",
    requiresPreviewMarker: true,
    workers: [
      {
        workerId: "worker-1",
        artifactRoot: "swarm/pr-350-worker-test/worker-1",
        missions,
      },
    ],
  };
}

function evidenceFor(
  item: BrowserAttackMission,
  overrides: Partial<{
    missionId: string;
    workerId: string;
    startedAt: string;
    completedAt: string;
    oracle: {
      kind: BrowserAttackMission["oracle"];
      passed: boolean;
      summary: string;
    };
    artifacts: readonly string[];
    harnessError: string;
  }> = {},
) {
  return {
    missionId: item.id,
    workerId: "worker-1",
    startedAt: "2026-09-21T00:00:00.000Z",
    completedAt: "2026-09-21T00:00:01.000Z",
    oracle: {
      kind: item.oracle,
      passed: true,
      summary: "authoritative state matched the browser",
    },
    artifacts: [
      "swarm/pr-350-worker-test/worker-1/ui-backend/trace.json",
    ],
    ...overrides,
  };
}

describe("SCRUM-350 trusted browser swarm worker", () => {
  it("verifies the preview before the first mission can run", async () => {
    const item = mission();
    const events: string[] = [];

    const result = await executeBrowserSwarmWorker({
      manifest: manifestFor([item]),
      workerId: "worker-1",
      verifyPreviewTarget: async () => {
        events.push("verify");
        return { verified: true, summary: "marker and URL matched" };
      },
      handlers: {
        UI_BACKEND_MISMATCH: async () => {
          events.push("mission");
          return evidenceFor(item);
        },
      },
    });

    expect(events).toEqual(["verify", "mission"]);
    expect(result.passed).toBe(true);
    expect(result.results[0]?.outcome).toBe("PASS");
  });

  it("refuses the whole worker when SCRUM-143 preview verification does not pass", async () => {
    const item = mission();
    const handler = vi.fn(async () => evidenceFor(item));

    await expect(
      executeBrowserSwarmWorker({
        manifest: manifestFor([item]),
        workerId: "worker-1",
        verifyPreviewTarget: async () => ({
          verified: false,
          summary: "preview marker missing",
        }),
        handlers: { UI_BACKEND_MISMATCH: handler },
      }),
    ).rejects.toThrow(/preview marker missing/);

    expect(handler).not.toHaveBeenCalled();
  });

  it("turns an unimplemented attack family into HARNESS_ERROR rather than a false pass", async () => {
    const item = mission({
      id: "det::TEN-1::TENANT_ESCAPE",
      family: "TENANT_ESCAPE",
      invariantIds: ["TEN-1"],
      invariantSeverity: "CRITICAL",
      oracle: "TENANT_ISOLATION",
    });

    const result = await executeBrowserSwarmWorker({
      manifest: manifestFor([item]),
      workerId: "worker-1",
      verifyPreviewTarget: async () => ({
        verified: true,
        summary: "verified",
      }),
      handlers: {},
    });

    expect(result.passed).toBe(false);
    expect(result.harnessErrorCount).toBe(1);
    expect(result.results[0]?.outcome).toBe("HARNESS_ERROR");
    expect(result.results[0]?.evidence.harnessError).toMatch(
      /No browser attack handler/,
    );
  });

  it("refuses evidence written outside the worker artifact root", async () => {
    const item = mission();
    const handlers: BrowserAttackHandlerRegistry = {
      UI_BACKEND_MISMATCH: async () =>
        evidenceFor(item, {
          artifacts: ["swarm/another-run/worker-9/trace.json"],
        }),
    };

    const result = await executeBrowserSwarmWorker({
      manifest: manifestFor([item]),
      workerId: "worker-1",
      verifyPreviewTarget: async () => ({
        verified: true,
        summary: "verified",
      }),
      handlers,
    });

    expect(result.results[0]?.outcome).toBe("HARNESS_ERROR");
    expect(result.results[0]?.evidence.artifacts).toEqual([]);
    expect(result.results[0]?.evidence.harnessError).toMatch(
      /outside its assigned artifact root/,
    );
  });

  it("rejects evidence that claims to belong to another worker", async () => {
    const item = mission();

    const result = await executeBrowserSwarmWorker({
      manifest: manifestFor([item]),
      workerId: "worker-1",
      verifyPreviewTarget: async () => ({
        verified: true,
        summary: "verified",
      }),
      handlers: {
        UI_BACKEND_MISMATCH: async () =>
          evidenceFor(item, { workerId: "worker-7" }),
      },
    });

    expect(result.results[0]?.outcome).toBe("HARNESS_ERROR");
    expect(result.results[0]?.evidence.harnessError).toMatch(
      /instead of worker-1/,
    );
  });

  it("aborts a timed-out mission and reports a harness error", async () => {
    const item = mission({ timeoutMs: 20 });
    let observedAbort = false;

    const result = await executeBrowserSwarmWorker({
      manifest: manifestFor([item]),
      workerId: "worker-1",
      verifyPreviewTarget: async () => ({
        verified: true,
        summary: "verified",
      }),
      handlers: {
        UI_BACKEND_MISMATCH: async ({ signal }) =>
          await new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                observedAbort = true;
                reject(new Error("browser context closed after abort"));
              },
              { once: true },
            );
          }),
      },
    });

    expect(observedAbort).toBe(true);
    expect(result.results[0]?.outcome).toBe("HARNESS_ERROR");
    expect(result.results[0]?.evidence.harnessError).toMatch(
      /exceeded its 20ms timeout/,
    );
  });

  it("reports deterministic oracle failures as confirmed breaches", async () => {
    const item = mission();

    const result = await executeBrowserSwarmWorker({
      manifest: manifestFor([item]),
      workerId: "worker-1",
      verifyPreviewTarget: async () => ({
        verified: true,
        summary: "verified",
      }),
      handlers: {
        UI_BACKEND_MISMATCH: async () =>
          evidenceFor(item, {
            oracle: {
              kind: "UI_BACKEND_AUTHORITY",
              passed: false,
              summary: "toast claimed success but the customer vanished after reload",
            },
          }),
      },
    });

    expect(result.passed).toBe(false);
    expect(result.confirmedBreachCount).toBe(1);
    expect(result.harnessErrorCount).toBe(0);
    expect(result.results[0]?.outcome).toBe("CONFIRMED_BREACH");
  });

  it("refuses a tampered manifest whose worker artifact root no longer matches the run id", async () => {
    const item = mission();
    const original = manifestFor([item]);
    const [originalWorker] = original.workers;
    if (!originalWorker) throw new Error("test manifest missing worker");
    const manifest: BrowserSwarmRunManifest = {
      ...original,
      workers: [
        {
          ...originalWorker,
          artifactRoot: "swarm/other-run/worker-1",
        },
      ],
    };

    await expect(
      executeBrowserSwarmWorker({
        manifest,
        workerId: "worker-1",
        verifyPreviewTarget: async () => ({
          verified: true,
          summary: "verified",
        }),
        handlers: {},
      }),
    ).rejects.toBeInstanceOf(BrowserSwarmExecutionError);
  });
});
