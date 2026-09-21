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
    ).toThrow(/trusted main workflow/);

    expect(() =>
      assertBrowserSwarmExecutionEnvironment({
        BROWSER_SWARM_ENABLED: "1",
        CI: "true",
        PLAYWRIGHT_SKIP_WEBSERVER: "1",
        BROWSER_SWARM_TRUSTED_EXTERNAL_SERVER: "1",
        PLAYWRIGHT_BASE_URL: "http://127.0.0.1:3000",
      }),
    ).not.toThrow();

    expect(() =>
      assertBrowserSwarmExecutionEnvironment({
        BROWSER_SWARM_ENABLED: "1",
        CI: "true",
        BROWSER_SWARM_TRUSTED_EXTERNAL_SERVER: "1",
      }),
    ).toThrow(/requires PLAYWRIGHT_SKIP_WEBSERVER/);

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

  it("fails closed before manifest creation when Jev suggests an unimplemented Phase A family", () => {
    expect(() =>
      browserSwarmManifestFromEnv({
        ...baseEnv,
        BROWSER_SWARM_WORKER_COUNT: "3",
        BROWSER_SWARM_WORKER_ID: "worker-3",
        BROWSER_SWARM_JEV_SUGGESTIONS_JSON:
          '[{"family":"TENANT_ESCAPE","probability":0.91}]',
      }),
    ).toThrow(/no executable handler.*TENANT_ESCAPE/i);
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

  it("refuses Jev attempts to smuggle subtraction authority or oversized input", () => {
    expect(() =>
      browserSwarmManifestFromEnv({
        ...baseEnv,
        BROWSER_SWARM_JEV_SUGGESTIONS_JSON:
          '[{"family":"RTL_PARITY","probability":0.9,"remove":"det::UI-1::UI_BACKEND_MISMATCH"}]',
      }),
    ).toThrow(/unexpected or missing fields/i);

    expect(() =>
      browserSwarmManifestFromEnv({
        ...baseEnv,
        BROWSER_SWARM_JEV_SUGGESTIONS_JSON:
          " ".repeat(4097),
      }),
    ).toThrow(/4 KiB/);
  });

  it("refuses duplicate Jev families before mission IDs can collide", () => {
    expect(() =>
      browserSwarmManifestFromEnv({
        ...baseEnv,
        BROWSER_SWARM_JEV_SUGGESTIONS_JSON:
          '[{"family":"RTL_PARITY","probability":0.8},{"family":"RTL_PARITY","probability":0.7}]',
      }),
    ).toThrow(/duplicate family/i);
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
