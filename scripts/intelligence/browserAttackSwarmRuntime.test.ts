import { describe, expect, it } from "vitest";
import {
  assertBrowserSwarmExecutionEnvironment,
  browserSwarmLocalBaseUrl,
  browserSwarmManifestFromEnv,
} from "./browserAttackSwarmRuntime";

const baseEnv = {
  BROWSER_SWARM_IMPACTED_INVARIANTS_JSON:
    '[{"id":"UI-1","severity":"HIGH"}]',
  BROWSER_SWARM_WORKER_COUNT: "2",
  BROWSER_SWARM_WORKER_ID: "worker-1",
  BROWSER_SWARM_RUN_ID: "gh-350-1",
  CONVEX_PREVIEW_NAME: "e2e-swarm-pr-350",
  NEXT_PUBLIC_CONVEX_URL: "https://example-preview.convex.cloud",
};

describe("SCRUM-350 browser swarm runtime config", () => {
  it("requires a fresh CI-owned Playwright web server for real swarm execution", () => {
    expect(() =>
      assertBrowserSwarmExecutionEnvironment({
        BROWSER_SWARM_ENABLED: "1",
        CI: "true",
      }),
    ).not.toThrow();

    expect(() =>
      assertBrowserSwarmExecutionEnvironment({
        BROWSER_SWARM_ENABLED: "1",
        CI: "false",
      }),
    ).toThrow(/CI=true/);

    expect(() =>
      assertBrowserSwarmExecutionEnvironment({
        BROWSER_SWARM_ENABLED: "1",
        CI: "true",
        PLAYWRIGHT_SKIP_WEBSERVER: "1",
      }),
    ).toThrow(/PLAYWRIGHT_SKIP_WEBSERVER/);

    expect(() =>
      assertBrowserSwarmExecutionEnvironment({
        BROWSER_SWARM_ENABLED: "1",
        CI: "true",
        PLAYWRIGHT_BASE_URL: "https://autoflowdealer.com",
      }),
    ).toThrow(/localhost\/loopback/);
  });

  it("allows only a local loopback frontend origin for attack execution", () => {
    expect(browserSwarmLocalBaseUrl({})).toBe("http://127.0.0.1:3000");
    expect(
      browserSwarmLocalBaseUrl({
        PLAYWRIGHT_BASE_URL: "http://localhost:3000/",
      }),
    ).toBe("http://localhost:3000");

    expect(() =>
      browserSwarmLocalBaseUrl({
        PLAYWRIGHT_BASE_URL: "https://autoflowdealer.com",
      }),
    ).toThrow(/localhost\/loopback/);
    expect(() =>
      browserSwarmLocalBaseUrl({
        PLAYWRIGHT_BASE_URL: "http://10.0.0.12:3000",
      }),
    ).toThrow(/localhost\/loopback/);
  });

  it("reconstructs the same bounded manifest in every worker", () => {
    const first = browserSwarmManifestFromEnv(baseEnv);
    const second = browserSwarmManifestFromEnv({
      ...baseEnv,
      BROWSER_SWARM_WORKER_ID: "worker-2",
    });

    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifest.workers).toHaveLength(2);
    expect(first.manifest.workers[0]?.missions.map((m) => m.family)).toEqual([
      "UI_BACKEND_MISMATCH",
    ]);
    expect(first.manifest.workers[1]?.missions.map((m) => m.family)).toEqual([
      "RTL_PARITY",
    ]);
  });

  it("admits Jev suggestions only through the normal union planner", () => {
    const { manifest } = browserSwarmManifestFromEnv({
      ...baseEnv,
      BROWSER_SWARM_WORKER_COUNT: "3",
      BROWSER_SWARM_WORKER_ID: "worker-3",
      BROWSER_SWARM_JEV_SUGGESTIONS_JSON:
        '[{"family":"TENANT_ESCAPE","probability":0.91}]',
    });

    expect(
      manifest.workers.flatMap((worker) => worker.missions).map((m) => m.family),
    ).toContain("TENANT_ESCAPE");
    expect(
      manifest.workers
        .flatMap((worker) => worker.missions)
        .filter((m) => m.source === "DETERMINISTIC")
        .map((m) => m.family)
        .sort(),
    ).toEqual(["RTL_PARITY", "UI_BACKEND_MISMATCH"]);
  });

  it("rejects unknown Jev attack families before planning", () => {
    expect(() =>
      browserSwarmManifestFromEnv({
        ...baseEnv,
        BROWSER_SWARM_JEV_SUGGESTIONS_JSON:
          '[{"family":"DELETE_PRODUCTION","probability":1}]',
      }),
    ).toThrow(/known family/);
  });

  it("refuses malformed invariant severity instead of coercing it", () => {
    expect(() =>
      browserSwarmManifestFromEnv({
        ...baseEnv,
        BROWSER_SWARM_IMPACTED_INVARIANTS_JSON:
          '[{"id":"UI-1","severity":"LOW"}]',
      }),
    ).toThrow(/HIGH\/CRITICAL/);
  });

  it("refuses a worker id outside the configured worker count", () => {
    expect(() =>
      browserSwarmManifestFromEnv({
        ...baseEnv,
        BROWSER_SWARM_WORKER_COUNT: "1",
        BROWSER_SWARM_WORKER_ID: "worker-2",
      }),
    ).toThrow(/outside the configured worker count/);
  });
});
