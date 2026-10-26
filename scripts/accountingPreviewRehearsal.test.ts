/**
 * The rehearsal runner's REFUSALS, proved rather than asserted.
 *
 * Everything worth testing here is a way the rehearsal could quietly run
 * somewhere it must not, or report success it did not earn. The orchestration
 * itself only runs in CI against a live preview and is not simulated here — a
 * mock of a Convex deployment would test the mock.
 */
import { describe, expect, test, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { format } from "node:util";
import { spawnSync } from "node:child_process";
import {
  assertRehearsalEnv,
  convexCall,
  convexCallWithRateLimitRetry,
  createCleanupPreviewCall,
  fd1BankContractInputs,
  rateLimitRetryDelayMs,
  isClerkSessionId,
  isPreviewCloudUrl,
  mintConvexToken,
  recordCase,
  rehearsalRefScope,
  runPreviewFunction,
  sanitizeClerkSessionId,
  summarize,
  unproven,
  exitCodeForSummary,
  bannerForSummary,
} from "./accountingPreviewRehearsal.mjs";
import { previewNameForRef } from "./e2ePreviewBootstrap.mjs";

const VALID = {
  CONVEX_DEPLOY_KEY: "preview:acme:proj|abcdef",
  CONVEX_PREVIEW_NAME: "rehearsal-branch-0123456789",
  NEXT_PUBLIC_CONVEX_URL: "https://fine-gerbil-123.convex.cloud",
  CLERK_SECRET_KEY: "sk_test_xxx",
  E2E_LOGIN_USER: "sales@example.test",
  E2E_APPROVER_USER: "approver@example.test",
};

const RESET = "orgFinancialReset:resetOrgFinancialData";
const DISCOVERY = "OPENING_CLEANUP_SPLIT_REQUIRED_DISCOVERY";
const REFERENCE = "OPENING_CLEANUP_SPLIT_REQUIRED_REFERENCE";
type CleanupSpawn = NonNullable<NonNullable<Parameters<typeof createCleanupPreviewCall>[1]>["spawnCli"]>;

async function failedSdkLogs(logLines: string[]) {
  const logs: string[] = [];
  const collect = (...args: unknown[]) => { logs.push(format(...args)); };
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    status: "error",
    errorMessage: "Uncaught ConvexError: Opening cleanup could not be verified. Please contact support.",
    errorData: "Opening cleanup could not be verified. Please contact support.",
    logLines,
  }), { status: 560 }));
  const client = new ConvexHttpClient(VALID.NEXT_PUBLIC_CONVEX_URL, {
    fetch: fetchImpl,
    logger: { log: collect, warn: collect, error: collect, logVerbose: () => {} },
  });
  // The installed CLI calls this runtime method; public SDK declarations omit it.
  if (!("function" in client) || typeof client.function !== "function") throw new Error("Installed SDK has no CLI function method");
  const cliMethod = client.function;
  const invokeCli: (name: string, componentPath: undefined, args: Record<string, unknown>) => Promise<unknown> = async (name, componentPath, args) => {
    const result: unknown = Reflect.apply(cliMethod, client, [name, componentPath, args]);
    return await result;
  };
  await expect(invokeCli(RESET, undefined, { orgId: "synthetic", batchSize: 1 })).rejects.toThrow("Opening cleanup could not be verified");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${VALID.NEXT_PUBLIC_CONVEX_URL}/api/function`);
  expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ path: RESET, args: { orgId: "synthetic", batchSize: 1 } });
  return logs.join("\n");
}

describe("cleanup invocation receipts", () => {
  const target = () => ({ deployKey: VALID.CONVEX_DEPLOY_KEY, previewName: VALID.CONVEX_PREVIEW_NAME, convexUrl: VALID.NEXT_PUBLIC_CONVEX_URL });
  const refused = (marker = DISCOVERY, fn = RESET) => `[CONVEX ?(${fn})] [ERROR] '${marker}'\nFailed to run function "${fn}":\nConvexError: Opening cleanup could not be verified. Please contact support.\n`;

  test("unavailable cleanup retains anonymous invocation diagnostics in failed rehearsal evidence", async () => {
    const evidence = { cases: [] as Array<Record<string, unknown>>,
      cleanupInvocations: { records: [] as unknown[], truncated: false } };
    const call = createCleanupPreviewCall(target(), { env: { ...VALID }, diagnostics: evidence.cleanupInvocations,
      spawnCli: () => ({ status: 1, stdout: "", stderr: "private-child-output" }) });
    await recordCase(evidence.cases, "S858-CLEANUP-SPLIT", "cleanup diagnostic control", () =>
      call(RESET, { orgId: "private-argument" }, "DISCOVERY"));
    const retained = JSON.parse(JSON.stringify(evidence));
    expect(retained.cases[0]).toMatchObject({ status: "FAIL", detail: "Cleanup preview invocation is UNAVAILABLE." });
    expect(retained.cleanupInvocations.records).toHaveLength(1);
    expect(retained.cleanupInvocations.records[0]).toMatchObject({
      functionName: RESET, phase: "DISCOVERY", status: 1, reason: "REFUSAL_PREREQUISITES", stage: "PARSER",
      stdout: { bytes: 0 }, stderr: { bytes: 20 },
    });
    expect(JSON.stringify(retained)).not.toMatch(/private-child-output|private-argument/);
    expect(exitCodeForSummary(summarize(retained.cases))).toBe(1);
  });

  test("a fixed fixture refusal is named by an allowlisted code, never by raw stderr", async () => {
    const diagnostics: { records: Array<Record<string, unknown>>; truncated: boolean } = { records: [], truncated: false };
    const prepare = "e2eBootstrap:prepareOpeningCleanupFixture";
    const stderr = (message: string) => `[CONVEX M(${prepare})] [ERROR] 'private-detail'\nConvexError: E2E_BOOTSTRAP: ${message}\n`;
    const spawnCli = vi.fn(() => ({ status: 1, stdout: "", stderr: stderr("invalid cleanup fixture scope.") }));
    const call = createCleanupPreviewCall(target(), { env: { ...VALID }, diagnostics, spawnCli });
    await expect(call(prepare, { orgId: "private-argument" })).rejects.toThrow(/^Cleanup preview invocation is UNAVAILABLE\.$/);
    spawnCli.mockReturnValue({ status: 1, stdout: "", stderr: stderr("something not in the allowlist private-text") });
    await expect(call(prepare, { orgId: "private-argument" })).rejects.toThrow(/^Cleanup preview invocation is UNAVAILABLE\.$/);
    expect(diagnostics.records[0]).toMatchObject({ reason: "REFUSAL_PREREQUISITES", serverRefusal: "INVALID_SCOPE" });
    expect(diagnostics.records[1]).toMatchObject({ reason: "REFUSAL_PREREQUISITES", serverRefusal: null });
    expect(JSON.stringify(diagnostics)).not.toMatch(/private/);
  });

  test("a broken diagnostic sink cannot replace the original cleanup refusal", async () => {
    const diagnostics = { records: [] as unknown[], truncated: false };
    Object.freeze(diagnostics.records);
    Object.freeze(diagnostics);
    const call = createCleanupPreviewCall(target(), { env: { ...VALID }, diagnostics,
      spawnCli: () => ({ status: 1, stdout: "", stderr: "private failure" }) });
    await expect(call(RESET, { orgId: "synthetic" }, "DISCOVERY")).rejects.toThrow(/^Cleanup preview invocation is UNAVAILABLE\.$/);
  });

  test("maxBuffer termination cannot label its bounded captured fragments complete", async () => {
    // Actual bounded Node child; no Convex CLI, target, identity or cloud call.
    const child = spawnSync(process.execPath, ["-e",
      'process.stdout.write("x".repeat(196608));process.stderr.write("y".repeat(196608));'],
    { maxBuffer: 262144, timeout: 3000, encoding: "utf8" });
    expect(child.error).toMatchObject({ code: "ENOBUFS" });
    expect(Buffer.byteLength(child.stdout)).toBeGreaterThan(0);
    expect(Buffer.byteLength(child.stdout)).toBeLessThanOrEqual(262144);
    expect(Buffer.byteLength(child.stderr)).toBeGreaterThan(0);
    expect(Buffer.byteLength(child.stderr)).toBeLessThanOrEqual(262144);
    const diagnostics = { records: [] as unknown[], truncated: false };
    const call = createCleanupPreviewCall(target(), { env: { ...VALID }, diagnostics, spawnCli: () => child });
    await expect(call(RESET, { orgId: "synthetic" }, "DISCOVERY")).rejects.toThrow(/^Cleanup preview invocation is UNAVAILABLE\.$/);
    expect(diagnostics.records[0]).toMatchObject({
      reason: "CHILD_RESULT_UNAVAILABLE", errorCode: "ENOBUFS",
      stdout: { bytes: Buffer.byteLength(child.stdout), sha256: null, digestScope: "UNAVAILABLE_INCOMPLETE" },
      stderr: { bytes: Buffer.byteLength(child.stderr), sha256: null, digestScope: "UNAVAILABLE_INCOMPLETE" },
    });
  });

  test.each([
    ["ETIMEDOUT", "SIGTERM", "ETIMEDOUT", "SIGTERM"],
    ["private-code", "private-signal", "UNAVAILABLE", "UNAVAILABLE"],
  ])("child metadata %s is bounded and cannot certify cleanup", async (code, signal, expectedCode, expectedSignal) => {
    const diagnostics = { records: [] as unknown[], truncated: false };
    const call = createCleanupPreviewCall(target(), { env: { ...VALID }, diagnostics,
      spawnCli: () => ({ status: null, error: Object.assign(new Error("private-error"), { code }), signal,
        stdout: "", stderr: "private-child-output" }) });
    await expect(call(RESET, { orgId: "private-argument" }, "DISCOVERY")).rejects.toThrow(/^Cleanup preview invocation is UNAVAILABLE\.$/);
    expect(diagnostics.records[0]).toMatchObject({
      status: null, errorCode: expectedCode, signal: expectedSignal, reason: "CHILD_RESULT_UNAVAILABLE",
      stderr: { bytes: 20, sha256: null, digestScope: "UNAVAILABLE_INCOMPLETE" },
    });
    expect(JSON.stringify(diagnostics)).not.toContain("private-");
  });

  test("the installed SDK forwards failed-response server logs before rejection", async () => {
    const logs = await failedSdkLogs([`[ERROR] '${DISCOVERY}'`]);
    expect(logs).toBe(`[CONVEX ?(${RESET})] [ERROR] '${DISCOVERY}'`);
  });

  test("a single SDK-forwarded phase marker binds a nonzero refusal to the canonical invocation", async () => {
    const logs = await failedSdkLogs([`[ERROR] '${DISCOVERY}'`]);
    const spawnCli = vi.fn(() => ({ status: 1, stdout: "", stderr: `${logs}\nFailed to run function "${RESET}":\nConvexError: Opening cleanup could not be verified. Please contact support.` }));
    const call = createCleanupPreviewCall(target(), { env: { ...VALID }, spawnCli });
    expect(await call(RESET, { orgId: "synthetic", batchSize: 1 }, "DISCOVERY")).toEqual({
      ok: false, refusal: "OPENING_CLEANUP_SPLIT_REQUIRED", phase: "DISCOVERY", exitCode: 1,
    });
  });

  test("success parses bounded JSON and preserves the captured explicit preview target", async () => {
    const config = target();
    const env = { ...VALID };
    const spawnCli = vi.fn<CleanupSpawn>(() => ({ status: 0, stdout: '{"phase":"DONE"}', stderr: "" }));
    const call = createCleanupPreviewCall(config, { env, spawnCli });
    config.previewName = "caller-changed";
    config.deployKey = "prod:wrong|secret";
    env.NEXT_PUBLIC_CONVEX_URL = "https://wrong.convex.cloud";
    expect(await call("e2eBootstrap:observeOpeningCleanupFixture", { orgId: "synthetic" })).toEqual({ ok: true, value: { phase: "DONE" } });
    const [, argv, options] = spawnCli.mock.calls[0];
    expect(argv.slice(-2)).toEqual(["--preview-name", VALID.CONVEX_PREVIEW_NAME]);
    expect(JSON.parse(argv[4]).expectedCloudUrl).toBe(VALID.NEXT_PUBLIC_CONVEX_URL);
    expect(options).toMatchObject({ stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, maxBuffer: 262_144,
      env: { CONVEX_DEPLOY_KEY: VALID.CONVEX_DEPLOY_KEY, NEXT_PUBLIC_CONVEX_URL: VALID.NEXT_PUBLIC_CONVEX_URL } });
  });

  test.each([
    ["missing marker", { status: 1, stdout: "", stderr: `Failed to run function "${RESET}":\nServer Error` }],
    ["duplicate marker", { status: 1, stdout: "", stderr: refused() + refused() }],
    ["duplicate refused-call header", { status: 1, stdout: "", stderr: refused() + `Failed to run function "${RESET}":` }],
    ["wrong phase", { status: 1, stdout: "", stderr: refused(REFERENCE) }],
    ["wrong function", { status: 1, stdout: "", stderr: refused(DISCOVERY, "adminOrgs:runDeletionRequestBatch") }],
    ["marker without canonical refusal", { status: 1, stdout: "", stderr: `[CONVEX ?(${RESET})] [ERROR] '${DISCOVERY}'\nnetwork failed` }],
    ["unframed marker", { status: 1, stdout: "", stderr: `${DISCOVERY}\nFailed to run function "${RESET}":\nOpening cleanup could not be verified. Please contact support.` }],
    ["quoted log record", { status: 1, stdout: "", stderr: JSON.stringify(refused()) }],
    ["echoed argument", { status: 1, stdout: "", stderr: JSON.stringify({ args: { note: refused() } }) }],
    ["transport-only marker text", { status: 1, stdout: "", stderr: `Connection refused: ${DISCOVERY}` }],
    ["transport error", { status: 1, stdout: "", stderr: refused(), error: new Error("private transport detail") }],
    ["terminated child", { status: null, stdout: "", stderr: refused(), signal: "SIGTERM" }],
    ["oversized output", { status: 1, stdout: "", stderr: refused() + "x".repeat(262_144) }],
    ["malformed success", { status: 0, stdout: "not json", stderr: "private response" }],
    ["empty success", { status: 0, stdout: "", stderr: "" }],
    ["oversized success", { status: 0, stdout: JSON.stringify("x".repeat(262_144)), stderr: "" }],
  ])("%s produces sanitized UNAVAILABLE, not a split receipt", async (_label, result) => {
    const output = captureConsoleOutput();
    const call = createCleanupPreviewCall(target(), { env: { ...VALID }, spawnCli: () => result });
    try {
      await expect(call(RESET, { orgId: "synthetic" }, "DISCOVERY")).rejects.toThrow(/^Cleanup preview invocation is UNAVAILABLE\.$/);
      output.expectSilent();
    } finally { output.restore(); }
  });

  test("unlisted functions and conflicting fixture targets are refused before any child starts", async () => {
    const spawnCli = vi.fn();
    const call = createCleanupPreviewCall(target(), { env: { ...VALID }, spawnCli });
    await expect(call("e2eBootstrap:bootstrapE2EOrganization", {})).rejects.toThrow(/UNAVAILABLE/);
    await expect(call("e2eBootstrap:prepareOpeningCleanupFixture", { expectedCloudUrl: "https://wrong.convex.cloud" })).rejects.toThrow(/UNAVAILABLE/);
    expect(spawnCli).not.toHaveBeenCalled();
    expect(() => createCleanupPreviewCall({ ...target(), previewName: "" }, { env: { ...VALID }, spawnCli })).toThrow(/UNAVAILABLE/);
    expect(() => createCleanupPreviewCall(target(), { env: { ...VALID, CONVEX_DEPLOYMENT: "prod:wrong" }, spawnCli })).toThrow(/UNAVAILABLE/);
  });

  test("a previous invocation's marker cannot certify a later failed child", async () => {
    const spawnCli = vi.fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: refused() })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: `Failed to run function "${RESET}":\nServer Error` });
    const call = createCleanupPreviewCall(target(), { env: { ...VALID }, spawnCli });
    expect(await call(RESET, { orgId: "first" }, "DISCOVERY")).toMatchObject({ refusal: "OPENING_CLEANUP_SPLIT_REQUIRED" });
    await expect(call(RESET, { orgId: "second" }, "DISCOVERY")).rejects.toThrow(/^Cleanup preview invocation is UNAVAILABLE\.$/);
    expect(spawnCli).toHaveBeenCalledTimes(2);
  });

  test("diagnostics preserve same-invocation receipts and bound collection without changing acceptance", async () => {
    const diagnostics = { records: [] as unknown[], truncated: false };
    const spawnCli = vi.fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: refused() })
      .mockReturnValueOnce({ status: 0, stdout: '{"phase":"DONE"}', stderr: "" });
    const call = createCleanupPreviewCall(target(), { env: { ...VALID }, diagnostics, spawnCli });
    expect(await call(RESET, { orgId: "synthetic" }, "DISCOVERY")).toMatchObject({ ok: false, phase: "DISCOVERY" });
    expect(await call("e2eBootstrap:observeOpeningCleanupFixture", {})).toEqual({ ok: true, value: { phase: "DONE" } });
    expect(diagnostics.records).toEqual([
      expect.objectContaining({ reason: "SPLIT_REFUSAL", stage: "COMPLETE",
        stderr: expect.objectContaining({ digestScope: "COMPLETE", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) }),
      expect.objectContaining({ reason: "SUCCESS", stage: "COMPLETE",
        stdout: expect.objectContaining({ digestScope: "COMPLETE", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) }),
    ]);
    diagnostics.records.length = 256;
    spawnCli.mockReturnValue({ status: 0, stdout: '{"phase":"DONE"}', stderr: "" });
    expect(await call("e2eBootstrap:observeOpeningCleanupFixture", {})).toEqual({ ok: true, value: { phase: "DONE" } });
    expect(diagnostics.records).toHaveLength(256);
    expect(diagnostics.truncated).toBe(true);
  });

  test("a late unavailable invocation survives the 256-record prefix and subsequent successful refusals", async () => {
    const diagnostics: { records: unknown[]; truncated: boolean; terminal?: unknown; lastUnavailable?: unknown } =
      { records: [], truncated: false };
    const spawnCli = vi.fn(() => ({ status: 0, stdout: '{"phase":"DONE"}', stderr: "" }));
    const call = createCleanupPreviewCall(target(), { env: { ...VALID }, diagnostics, spawnCli });
    for (let index = 0; index < 256; index += 1)
      await call("e2eBootstrap:observeOpeningCleanupFixture", {});
    spawnCli.mockReturnValue({ status: 1, stdout: "", stderr: "private late failure" });
    await expect(call(RESET, { orgId: "private-argument" }, "REFERENCE")).rejects.toThrow(/^Cleanup preview invocation is UNAVAILABLE\.$/);
    expect(diagnostics.records).toHaveLength(256);
    expect(diagnostics.truncated).toBe(true);
    expect(diagnostics.terminal).toMatchObject({ functionName: RESET, phase: "REFERENCE", status: 1, reason: "REFUSAL_PREREQUISITES" });
    expect(diagnostics.lastUnavailable).toEqual(diagnostics.terminal);
    const failure = diagnostics.lastUnavailable;
    spawnCli.mockReturnValue({ status: 0, stdout: '{"phase":"DONE"}', stderr: "" });
    await call("e2eBootstrap:observeOpeningCleanupFixture", {});
    spawnCli.mockReturnValue({ status: 1, stdout: "", stderr: refused() });
    expect(await call(RESET, { orgId: "synthetic" }, "DISCOVERY")).toMatchObject({ ok: false, phase: "DISCOVERY" });
    expect(diagnostics.terminal).toMatchObject({ status: 1, reason: "SPLIT_REFUSAL" });
    expect(diagnostics.lastUnavailable).toBe(failure);
    expect(JSON.stringify(diagnostics)).not.toContain("private");
  });
});

function captureConsoleOutput() {
  const spies = [
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "debug").mockImplementation(() => {}),
    vi.spyOn(console, "dir").mockImplementation(() => {}),
    vi.spyOn(console, "table").mockImplementation(() => {}),
    vi.spyOn(console, "trace").mockImplementation(() => {}),
  ];
  return {
    expectSilent: () => spies.forEach((spy) => expect(spy).not.toHaveBeenCalled()),
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

describe("the rehearsal refuses rather than degrades", () => {
  test("preview assertion CLI output cannot prefix the machine-readable release evidence", async () => {
    const spawnCli = vi.fn((_command: string, _args: string[], _options: object) =>
      ({ status: 0, stdout: Buffer.from('{"marker":true}\n') }));
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const consoleOutput = captureConsoleOutput();
    try {
      await runPreviewFunction({
        functionName: "e2eBootstrap:assertE2EBootstrap",
        args: { primaryClerkUserId: "user_a", approverClerkUserId: "user_b", expectedCloudUrl: VALID.NEXT_PUBLIC_CONVEX_URL },
        previewName: VALID.CONVEX_PREVIEW_NAME,
        deployKey: VALID.CONVEX_DEPLOY_KEY,
        env: { ...VALID, NODE_ENV: "test" },
        spawnCli,
      });
      expect(spawnCli).toHaveBeenCalledTimes(1);
      expect(spawnCli.mock.calls[0]?.[2]).toMatchObject({ stdio: ["inherit", "pipe", "inherit"] });
      expect(stdoutWrite).not.toHaveBeenCalled();
      consoleOutput.expectSilent();
    } finally {
      consoleOutput.restore();
      stdoutWrite.mockRestore();
    }
  });

  test("failed preview assertion keeps captured stdout out of public logs", async () => {
    const spawnCli = vi.fn((_command: string, _args: string[], _options: object) =>
      ({ status: 3, stdout: Buffer.from('{"tenantMarker":true}\n') }));
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const consoleOutput = captureConsoleOutput();
    try {
      const rejection = runPreviewFunction({
        functionName: "e2eBootstrap:assertE2EBootstrap",
        args: { primaryClerkUserId: "user_a", approverClerkUserId: "user_b", expectedCloudUrl: VALID.NEXT_PUBLIC_CONVEX_URL },
        previewName: VALID.CONVEX_PREVIEW_NAME,
        deployKey: VALID.CONVEX_DEPLOY_KEY,
        env: { ...VALID, NODE_ENV: "test" },
        spawnCli,
      });
      await expect(rejection).rejects.toThrow("failed with exit code 3");
      await expect(rejection).rejects.not.toThrow("tenantMarker");
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(stderrWrite).not.toHaveBeenCalled();
      consoleOutput.expectSilent();
    } finally {
      consoleOutput.restore();
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  test("it accepts a complete, preview-shaped environment", () => {
    const config = assertRehearsalEnv({ ...VALID });
    expect(config.convexUrl).toBe("https://fine-gerbil-123.convex.cloud");
    expect(config.previewName).toBe("rehearsal-branch-0123456789");
  });

  test.each([
    "CONVEX_DEPLOY_KEY",
    "CONVEX_PREVIEW_NAME",
    "NEXT_PUBLIC_CONVEX_URL",
    "CLERK_SECRET_KEY",
    "E2E_LOGIN_USER",
    "E2E_APPROVER_USER",
  ])("a missing %s is a refusal, never a default", (key) => {
    const env = { ...VALID, [key]: "" };
    expect(() => assertRehearsalEnv(env)).toThrow(new RegExp(key));
  });

  test.each([
    ["prod", "prod:acme:proj|abcdef"],
    ["dev", "dev:acme:proj|abcdef"],
    ["project", "project:acme:proj|abcdef"],
    ["a bare admin key", "acme|abcdef"],
  ])("a %s deploy key is refused before any argument is assembled", (_label, key) => {
    // The single most important refusal in this file: every one of these keys
    // can reach a REAL deployment, and `convex run` — unlike `--preview-create`
    // — does not refuse them on its own.
    expect(() => assertRehearsalEnv({ ...VALID, CONVEX_DEPLOY_KEY: key })).toThrow(/PREVIEW deploy key/);
  });

  test.each([
    ["a local backend", "http://127.0.0.1:3210"],
    ["a bare hostname", "fine-gerbil-123.convex.cloud"],
    ["something else entirely", "https://example.com"],
  ])("%s is refused as a target URL", (_label, url) => {
    expect(() => assertRehearsalEnv({ ...VALID, NEXT_PUBLIC_CONVEX_URL: url })).toThrow(/Convex cloud deployment URL/);
  });
});

describe("the rehearsal preview is a DIFFERENT destructive key from the browser suite's", () => {
  test("the same ref yields a different preview name for the rehearsal", () => {
    // `--preview-create` DELETES the deployment it names. If this job and the
    // Playwright job derived the same name from the same branch, the rehearsal
    // would destroy the browser suite's backend mid-run — the exact failure the
    // Playwright workflow's own naming comment records. They are in different
    // concurrency groups, so they must be in different names.
    const ref = "refs/heads/agent/accounting-rc-integration";
    const browserName = previewNameForRef({ ref, prNumber: "299" });
    const rehearsalName = previewNameForRef({ ref: rehearsalRefScope(ref), prNumber: "299" });
    expect(rehearsalName).not.toBe(browserName);
  });

  test("the scope is deterministic, so re-running a branch reuses its own preview", () => {
    expect(rehearsalRefScope("refs/heads/x")).toBe(rehearsalRefScope("refs/heads/x"));
    expect(rehearsalRefScope("refs/heads/x")).not.toBe(rehearsalRefScope("refs/heads/y"));
  });
});

describe("FD1 bank-contract inputs come from trusted provenance (SCRUM-54)", () => {
  const cwd = "/work/trusted";
  const read = vi.fn((file: string) => `source of ${file.replace(/\\/g, "/")}`);

  test("the candidate source is read from the checkout beside the trusted one; unreadable is undefined", () => {
    const inputs = fd1BankContractInputs({ env: { PR_NUMBER: "602" }, cwd, readText: read });
    expect(inputs.candidateSource).toMatch(/\/work\/candidate\/convex\/applications\.ts$/);
    expect(inputs.directFeeSource).toMatch(/\/work\/candidate\/convex\/financeDealCosts\.ts$/);
    expect(inputs.chequeSource).toMatch(/\/work\/candidate\/convex\/collections\.ts$/);
    const unreadable = fd1BankContractInputs({
      env: { PR_NUMBER: "602" },
      cwd,
      readText: () => {
        throw new Error("ENOENT");
      },
    });
    expect(unreadable.candidateSource).toBeUndefined();
    expect(unreadable.directFeeSource).toBeUndefined();
    expect(unreadable.chequeSource).toBeUndefined();
    expect(unreadable.requireBankContract).toBe(true);
  });
});

describe("convexCall reports failures as data, not exceptions", () => {
  const fakeFetch = (payload: unknown, status = 200) =>
    async () => ({ status, text: async () => JSON.stringify(payload) }) as unknown as Response;

  test("a success carries the value through", async () => {
    const result = await convexCall(
      { convexUrl: "https://x.convex.cloud", token: "t", kind: "query", path: "a:b", args: {} },
      fakeFetch({ status: "success", value: 42 }) as unknown as typeof fetch
    );
    expect(result).toEqual({ ok: true, value: 42 });
  });

  test("a ConvexError's message is surfaced, not the wrapper", async () => {
    const result = await convexCall(
      { convexUrl: "https://x.convex.cloud", token: "t", kind: "mutation", path: "a:b", args: {} },
      fakeFetch({ status: "error", errorData: { message: "nothing left to refund" } }) as unknown as typeof fetch
    );
    expect(result).toEqual({ ok: false, error: "nothing left to refund" });
  });

  test("a coded refusal also surfaces its machine code, so an expected-refusal case can assert it", async () => {
    const result = await convexCall(
      { convexUrl: "https://x.convex.cloud", token: "t", kind: "mutation", path: "a:b", args: {} },
      fakeFetch({
        status: "error",
        errorData: { code: "CLEARED_CHEQUE_RETURN_PILOT_DISABLED", message: "not available during the pilot" },
      }) as unknown as typeof fetch
    );
    expect(result).toEqual({
      ok: false,
      error: "not available during the pilot",
      errorCode: "CLEARED_CHEQUE_RETURN_PILOT_DISABLED",
    });
  });

  test("a non-JSON body is a hard failure, because it usually means the wrong URL", async () => {
    const notJson = async () => ({ status: 502, text: async () => "<html>bad gateway" }) as unknown as Response;
    await expect(
      convexCall(
        { convexUrl: "https://x.convex.cloud", token: "t", kind: "query", path: "a:b", args: {} },
        notJson as unknown as typeof fetch
      )
    ).rejects.toThrow(/non-JSON response/);
  });
});

describe("live-cloud rate-limit retries are narrow and fail closed", () => {
  const spec = {
    convexUrl: "https://x.convex.cloud",
    token: "t",
    kind: "mutation",
    path: "customers:create",
    args: { orgId: "o" },
  };

  test("the exact pre-write tenant limiter refusal is retried, then the real result is returned", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      const payload =
        calls === 1
          ? { status: "error", errorData: { message: "Rate limit exceeded. Try again in 1s" } }
          : { status: "success", value: "customer_1" };
      return { status: 200, text: async () => JSON.stringify(payload) } as unknown as Response;
    };
    const sleeps: number[] = [];

    const result = await convexCallWithRateLimitRetry(spec, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
    });

    expect(result).toEqual({ ok: true, value: "customer_1" });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1250]);
  });

  test("an arbitrary business refusal is NEVER retried or converted into success", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            status: "error",
            errorData: { message: "Execution Fees are not configured for this finance company." },
          }),
      } as unknown as Response;
    };

    const result = await convexCallWithRateLimitRetry(spec, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async () => {
        throw new Error("business refusals must not sleep/retry");
      },
      maxAttempts: 5,
    });

    expect(result).toEqual({
      ok: false,
      error: "Execution Fees are not configured for this finance company.",
    });
    expect(calls).toBe(1);
  });

  test("retry parsing accepts only the product's exact rate-limit message", () => {
    expect(rateLimitRetryDelayMs("Rate limit exceeded. Try again in 1s")).toBe(1250);
    // The upload bucket refills 10 tokens/minute and can legitimately return 6s.
    // Keep the 250ms boundary cushion instead of retrying 750ms too early.
    expect(rateLimitRetryDelayMs("Rate limit exceeded. Try again in 6s")).toBe(6250);
    expect(rateLimitRetryDelayMs("Rate limit exceeded. Try again later")).toBeNull();
    expect(rateLimitRetryDelayMs("Customer not found")).toBeNull();
  });

  test("persistent throttling remains a failure after the bounded retry budget", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            status: "error",
            errorData: { message: "Rate limit exceeded. Try again in 0s" },
          }),
      } as unknown as Response;
    };
    const sleeps: number[] = [];

    const result = await convexCallWithRateLimitRetry(spec, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
    });

    expect(result.ok).toBe(false);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([500, 500]);
  });
});

describe("token minting surfaces a denial instead of working around it", () => {
  test("a refused session says so, and names why no bypass was added", async () => {
    const denied = async () => ({ ok: false, status: 403, text: async () => "forbidden" }) as unknown as Response;
    await expect(
      mintConvexToken({ userId: "user_1", secretKey: "sk_test" }, denied as unknown as typeof fetch)
    ).rejects.toThrow(/refused to create a session/);
  });

  test("a session without a convex-template token is refused too", async () => {
    let call = 0;
    const partial = async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, json: async () => ({ id: "sess_2abcDEF3456789ghijk" }) } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => "no template" } as unknown as Response;
    };
    await expect(
      mintConvexToken({ userId: "user_1", secretKey: "sk_test" }, partial as unknown as typeof fetch)
    ).rejects.toThrow(/`convex` template token/);
  });

  test("a malformed session id from Clerk never reaches the token URL", async () => {
    // The SSRF shape Sonar flagged, as a behavioural test rather than a promise:
    // if the remote response carries a traversal, the SECOND request — the one
    // that would carry the Clerk secret to the wrong path — must never be made.
    let calls = 0;
    const hostile = async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, json: async () => ({ id: "sess_../../../../tokens" }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ jwt: "should-never-be-reached" }) } as unknown as Response;
    };
    await expect(
      mintConvexToken({ userId: "user_1", secretKey: "sk_test" }, hostile as unknown as typeof fetch)
    ).rejects.toThrow(/does not match the expected/);
    expect(calls, "the token request must not have been attempted").toBe(1);
  });
});

describe("values that reach a URL are validated before they get there", () => {
  test.each([
    ["a path traversal", "sess_../../../admin"],
    ["an absolute URL", "https://evil.example/x"],
    ["a protocol-relative URL", "//evil.example"],
    ["an empty id", ""],
    ["a non-string", null],
  ])("%s is refused as a Clerk session id", (_label, value) => {
    // These reach a URL PATH on an authenticated request carrying the Clerk
    // secret. A response is not trustworthy input just because the host is.
    expect(isClerkSessionId(value as string)).toBe(false);
  });

  test("a real Clerk session id is accepted", () => {
    expect(isClerkSessionId("sess_2abcDEF3456789ghijk")).toBe(true);
  });

  test("the id that reaches the URL is REBUILT from the matched characters", () => {
    // Not merely validated. Testing a value and then using the original leaves
    // the untrusted string flowing into the request; reconstructing means what
    // reaches the URL can only ever be `sess_` plus admitted characters.
    expect(sanitizeClerkSessionId("sess_2abcDEF3456789ghijk")).toBe("sess_2abcDEF3456789ghijk");
    expect(sanitizeClerkSessionId("sess_../../../admin")).toBeNull();
    expect(sanitizeClerkSessionId("https://evil.example")).toBeNull();
    expect(sanitizeClerkSessionId(undefined)).toBeNull();
  });

  test.each([
    ["a local backend", "http://127.0.0.1:3210"],
    ["an attacker host", "https://evil.example"],
    ["a path suffix", "https://x.convex.cloud/evil"],
  ])("%s is refused as a mutation target", (_label, value) => {
    expect(isPreviewCloudUrl(value)).toBe(false);
  });

  test("a Convex cloud deployment URL is accepted", () => {
    expect(isPreviewCloudUrl("https://energized-pheasant-272.convex.cloud")).toBe(true);
  });
});

describe("case recording keeps a failure as evidence", () => {
  test("a thrown assertion becomes a FAIL record rather than aborting the run", async () => {
    const results: Array<Record<string, unknown>> = [];
    await recordCase(results, "X1", "a case that fails", () => {
      throw new Error("released 4000, expected 2000");
    });
    await recordCase(results, "X2", "a case that passes", () => ({ released: 2000 }));
    expect(results.map((r) => r.status)).toEqual(["FAIL", "PASS"]);
    expect(results[0].detail).toMatch(/released 4000/);
    expect(summarize(results)).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      failedIds: ["X1"],
      unproven: 0,
      unprovenIds: [],
      complete: false,
    });
  });

  test("a case that could not be tested is UNPROVEN, and the run is not complete", async () => {
    // The whole point of the third status: this run found no defect AND
    // demonstrated nothing. Counting it as a pass would let a rehearsal that
    // skipped a requirement be quoted as one that met it.
    const results: Array<Record<string, unknown>> = [];
    await recordCase(results, "P1", "a case that could not run", () => {
      unproven("no OPEN period existed to close");
    });
    await recordCase(results, "A1", "a case that ran", () => ({ ok: true }));
    expect(results.map((r) => r.status)).toEqual(["UNPROVEN", "PASS"]);
    const summary = summarize(results);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(1);
    expect(summary.unproven).toBe(1);
    expect(summary.unprovenIds).toEqual(["P1"]);
    expect(summary.complete).toBe(false);
  });

  test("the process exit code is non-zero for UNPROVEN, not only for FAIL (Sonnet F1b / Codex RG-02)", () => {
    // Both seats found this independently: an UNPROVEN case returned 0, so an
    // INCOMPLETE rehearsal was a GREEN job. That was my deliberate design and it
    // was wrong by this repository's own rule — an unexecuted gate is
    // UNAVAILABLE, never PASS. To a release gate, 'could not test it' and 'it
    // failed' are the same answer: not certified. The JSON and the banner keep
    // the two distinct because they invite different responses.
    const base = { total: 3, passed: 3, failed: 0, failedIds: [], unproven: 0, unprovenIds: [], complete: true };
    expect(exitCodeForSummary(base)).toBe(0);
    const empty = summarize([]);
    expect(empty.complete).toBe(false);
    expect(exitCodeForSummary(empty)).toBe(1);
    expect(bannerForSummary(empty)).toMatch(/INCOMPLETE — NOT CERTIFIED.*no cloud cases executed/);
    expect(exitCodeForSummary({ ...base, passed: 2, failed: 1, failedIds: ["D2"], complete: false })).toBe(1);
    expect(exitCodeForSummary({ ...base, passed: 2, unproven: 1, unprovenIds: ["P1"], complete: false })).toBe(1);
    // Distinguishable in the banner, identical at the process boundary.
    expect(bannerForSummary({ ...base, passed: 2, unproven: 1, unprovenIds: ["P1"], complete: false })).toMatch(
      /INCOMPLETE — NOT CERTIFIED.*P1/
    );
    expect(bannerForSummary({ ...base, passed: 2, failed: 1, failedIds: ["D2"], complete: false })).toMatch(/FAILED.*D2/);
    expect(bannerForSummary(base)).toMatch(/REHEARSAL PASSED: 3 of 3/);
  });

  test("an all-passing run reports no failures", () => {
    expect(summarize([{ id: "A", status: "PASS" }])).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      failedIds: [],
      unproven: 0,
      unprovenIds: [],
      complete: true,
    });
  });
});

test("a run that both FAILED and left cases UNPROVEN names BOTH lists in the banner (Sonnet MAX LOW)", () => {
  const banner = bannerForSummary({
    total: 5,
    passed: 2,
    failed: 2,
    failedIds: ["D2", "D3"],
    unproven: 1,
    unprovenIds: ["C1"],
    complete: false,
  });
  expect(banner).toMatch(/FAILED: 2 of 5/);
  expect(banner).toMatch(/D2, D3/);
  expect(banner).toMatch(/1 UNPROVEN \(C1\)/);
});
