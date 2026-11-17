// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOSTED_REPLAY_WAIT_MINUTES } from "../intelligence/trustedBrowserReplayPolicy.mjs";

const boundary = vi.hoisted(() => ({
  writeOutput: vi.fn(),
  readCandidate: vi.fn(),
  readDiff: vi.fn(),
  readRegistry: vi.fn(),
  select: vi.fn(),
  collect: vi.fn(),
  wait: vi.fn(),
}));

vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  appendFileSync: boundary.writeOutput,
}));
vi.mock("node:timers/promises", () => ({ setTimeout: boundary.wait }));
vi.mock("./prRunner.mjs", () => ({ loadRecords: boundary.readRegistry, selectForPr: boundary.select }));
vi.mock("./trustedBrowserSource.mjs", () => ({
  hostedReplayCandidate: boundary.readCandidate,
  readProtectedReplayDiff: boundary.readDiff,
  collectHostedBrowserReplays: boundary.collect,
}));

const candidate = {
  repositoryId: 1, prNumber: 825, workflowRunId: 2, workflowAttempt: 1,
  baseSha: "a".repeat(40), headSha: "b".repeat(40), testedSha: "c".repeat(40),
};
const supplier = {
  id: "supplier-p7-browser-ar", status: "active", domain: "screen", level: "browser",
  fingerprint: "1".repeat(64), impl: { file: "playwright/tests/supplier-identity.spec.ts", testName: "supplier in Arabic" },
};
const originalExitCode = process.exitCode;
const started = new Date("2026-11-17T00:00:00Z");

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("GITHUB_OUTPUT", "fixture.github-output");
  vi.useFakeTimers({ now: started, toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  boundary.readCandidate.mockReturnValue(candidate);
  boundary.readDiff.mockReturnValue(["components/supplier/SupplierVehicleTarget.tsx"]);
  boundary.readRegistry.mockReturnValue({ problems: [], records: [supplier] });
  boundary.select.mockReturnValue({ browserSelected: [supplier] });
  boundary.wait.mockImplementation(async milliseconds => {
    vi.setSystemTime(Date.now() + milliseconds);
  });
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("waits for pending candidate evidence and writes only the matching proof", async () => {
  boundary.collect.mockReturnValueOnce({ ready: false, verdicts: [] })
    .mockReturnValueOnce({ ready: true, verdicts: [{ id: supplier.id, code: "PASS" }] });

  await import("./verifyHostedBrowserReplays.mjs");

  expect(boundary.wait).toHaveBeenCalledExactlyOnceWith(60_000);
  expect(boundary.writeOutput).toHaveBeenCalledExactlyOnceWith("fixture.github-output",
    `manifest=${JSON.stringify({ version: 1, candidate, records: [{ ...supplier, evidence: "browser-replay" }] })}\n`);
});

it("writes an empty manifest without polling when the PR selected no protected case", async () => {
  boundary.select.mockReturnValue({ browserSelected: [] });

  await import("./verifyHostedBrowserReplays.mjs");

  expect(boundary.collect).not.toHaveBeenCalled();
  expect(boundary.writeOutput).toHaveBeenCalledExactlyOnceWith("fixture.github-output",
    `manifest=${JSON.stringify({ version: 1, candidate, records: [] })}\n`);
});

it.each(["terminal refusal", "producer deadline", "invalid registry", "unavailable candidate"] as const)(
  "fails without writing a manifest after %s", async cause => {
    boundary.collect.mockReturnValue({ ready: cause === "terminal refusal", verdicts: [] });
    if (cause === "producer deadline") {
      boundary.wait.mockImplementationOnce(async () => {
        vi.setSystemTime(started.getTime() + HOSTED_REPLAY_WAIT_MINUTES * 60_000);
      });
    }
    if (cause === "invalid registry") boundary.readRegistry.mockReturnValue({ problems: ["invalid"], records: [] });
    if (cause === "unavailable candidate") boundary.readCandidate.mockReturnValue(null);

    await import("./verifyHostedBrowserReplays.mjs");

    expect(boundary.wait).toHaveBeenCalledTimes(cause === "producer deadline" ? 1 : 0);
    expect(boundary.writeOutput).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  },
);
