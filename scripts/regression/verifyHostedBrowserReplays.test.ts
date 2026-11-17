// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOSTED_REPLAY_WAIT_MINUTES } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import supplier from "../../regression/scenarios/screen/supplier-p7-browser-ar.scenario.json";

const boundary = vi.hoisted(() => ({
  readCandidate: vi.fn(),
  readDiff: vi.fn(),
  collect: vi.fn(),
  wait: vi.fn(),
}));

vi.mock("node:timers/promises", () => ({ setTimeout: boundary.wait }));
vi.mock("./trustedBrowserSource.mjs", () => ({
  hostedReplayCandidate: boundary.readCandidate,
  readProtectedReplayDiff: boundary.readDiff,
  collectHostedBrowserReplays: boundary.collect,
}));

const candidate = {
  repositoryId: 1, prNumber: 825, workflowRunId: 2, workflowAttempt: 1,
  baseSha: "a".repeat(40), headSha: "b".repeat(40), testedSha: "c".repeat(40),
};
const originalExitCode = process.exitCode;
const started = new Date("2026-11-17T00:00:00Z");
let outputDirectory: string;
let outputFile: string;

function readManifest() {
  const output = readFileSync(outputFile, "utf8");
  expect(output).toMatch(/^manifest=\{[^\n]+\}\n$/);
  return JSON.parse(output.slice("manifest=".length));
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  outputDirectory = mkdtempSync(path.join(tmpdir(), "hosted-replay-output-"));
  outputFile = path.join(outputDirectory, "github-output");
  vi.stubEnv("GITHUB_OUTPUT", outputFile);
  vi.useFakeTimers({ now: started, toFake: ["Date"] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  boundary.readCandidate.mockReturnValue(candidate);
  boundary.readDiff.mockReturnValue([supplier.impl.file]);
  boundary.wait.mockImplementation(async milliseconds => {
    vi.setSystemTime(Date.now() + milliseconds);
  });
});

afterEach(() => {
  vi.doUnmock("./prRunner.mjs");
  process.exitCode = originalExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (existsSync(outputFile)) unlinkSync(outputFile);
  rmdirSync(outputDirectory);
});

it("waits for pending candidate evidence and writes only the matching proof", async () => {
  boundary.collect.mockReturnValueOnce({ ready: false, verdicts: [] })
    .mockReturnValueOnce({ ready: true, verdicts: [{ id: supplier.id, code: "PASS" }] });

  await import("./verifyHostedBrowserReplays.mjs");

  expect(boundary.wait).toHaveBeenCalledExactlyOnceWith(60_000);
  expect(boundary.collect.mock.calls.map(([{ selected }]) => selected.map(({ id }: { id: string }) => id)))
    .toEqual([[supplier.id, "supplier-p7-browser-en"], [supplier.id, "supplier-p7-browser-en"]]);
  const { id, status, domain, level, fingerprint, impl: { file, testName } } = supplier;
  expect(readManifest()).toEqual({
    version: 1, candidate, records: [{ id, status, domain, level, fingerprint, impl: { file, testName }, evidence: "browser-replay" }],
  });
});

it("writes an empty manifest without polling when the PR selected no protected case", async () => {
  boundary.readDiff.mockReturnValue(["docs/adr/2026-11-03-pr-time-scenario-runner.md"]);

  await import("./verifyHostedBrowserReplays.mjs");

  expect(boundary.collect).not.toHaveBeenCalled();
  expect(readManifest()).toEqual({ version: 1, candidate, records: [] });
});

it.each(["terminal refusal", "producer deadline", "invalid registry", "unavailable candidate"] as const)(
  "fails without writing a manifest after %s", async cause => {
    boundary.collect.mockReturnValue({ ready: cause === "terminal refusal", verdicts: [] });
    if (cause === "producer deadline") {
      boundary.wait.mockImplementationOnce(async () => {
        vi.setSystemTime(started.getTime() + HOSTED_REPLAY_WAIT_MINUTES * 60_000);
      });
    }
    if (cause === "invalid registry") {
      vi.doMock("./prRunner.mjs", async importOriginal => ({
        ...await importOriginal<typeof import("./prRunner.mjs")>(),
        loadRecords: () => ({ problems: ["invalid"], records: [] }),
      }));
    }
    if (cause === "unavailable candidate") boundary.readCandidate.mockReturnValue(null);

    await import("./verifyHostedBrowserReplays.mjs");

    expect(boundary.wait).toHaveBeenCalledTimes(cause === "producer deadline" ? 1 : 0);
    expect(existsSync(outputFile)).toBe(false);
    expect(process.exitCode).toBe(1);
  },
);
