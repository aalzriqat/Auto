import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import { createInitialBrowserAttackHandlers } from "./browserAttackSwarmHandlers";
import { executeBrowserSwarmWorker, type BrowserAttackHandlerRegistry } from "./browserAttackSwarmExecutor";
import { assertBrowserSwarmExecutionEnvironment, browserSwarmManifestFromEnv } from "./browserAttackSwarmRuntime";
import { verifyBrowserSwarmPreview } from "./browserAttackSwarmPreviewVerifier.mjs";

// This file is outside the ordinary Playwright test directories. The G6 controller
// selects it explicitly. No ordinary hunter or gate is disabled or reconfigured.
test("executes the generic swarm and records its actual public RPC invocations", async ({}, testInfo) => {
  assertBrowserSwarmExecutionEnvironment(process.env);
  const { manifest, workerId } = browserSwarmManifestFromEnv(process.env);
  const worker = manifest.workers.find(candidate => candidate.workerId === workerId);
  if (!worker) throw new Error("Replay worker is absent");
  testInfo.setTimeout(worker.missions.reduce((sum, mission) => sum + mission.timeoutMs, 60_000));
  const missionContext = new AsyncLocalStorage<string>();
  const invocations: { missionId: string; name: string; financingType?: "CASH" | "FINANCED" }[] = [];
  const mutation = ConvexHttpClient.prototype.mutation;
  const query = ConvexHttpClient.prototype.query;
  const record = (name: string, args: unknown) => {
    const missionId = missionContext.getStore();
    if (!missionId) return;
    const mode = args !== null && typeof args === "object" && "financingType" in args ? args.financingType : undefined;
    invocations.push({ missionId, name, ...(mode === "CASH" || mode === "FINANCED" ? { financingType: mode } : {}) });
  };
  // Observe the real HTTP boundary. Delegate arguments and results unchanged.
  ConvexHttpClient.prototype.mutation = (async function (this: ConvexHttpClient, ...args: Parameters<typeof mutation>) {
    record(getFunctionName(args[0]), args[1]);
    return await Reflect.apply(mutation, this, args);
  }) as typeof mutation;
  ConvexHttpClient.prototype.query = (async function (this: ConvexHttpClient, ...args: Parameters<typeof query>) {
    record(getFunctionName(args[0]), args[1]);
    return await Reflect.apply(query, this, args);
  }) as typeof query;
  try {
    const registry = createInitialBrowserAttackHandlers();
    const traced: BrowserAttackHandlerRegistry = {};
    for (const family of Object.keys(registry) as (keyof BrowserAttackHandlerRegistry)[]) {
      const handler = registry[family];
      if (handler) traced[family] = context => missionContext.run(context.mission.id, () => handler(context));
    }
    const execution = await executeBrowserSwarmWorker({ manifest, workerId,
      verifyPreviewTarget: candidate => verifyBrowserSwarmPreview(candidate, process.env), handlers: traced });
    for (const [name, observation] of [
      ["browser-swarm-manifest.json", manifest], ["browser-swarm-execution.json", execution],
      ["oracle-invocations.json", invocations],
    ] as const) await testInfo.attach(name, { body: Buffer.from(JSON.stringify(observation)), contentType: "application/json" });
    expect(execution.harnessErrorCount).toBe(0);
    expect(execution.confirmedBreachCount).toBe(0);
    expect(execution.passed).toBe(true);
  } finally {
    ConvexHttpClient.prototype.mutation = mutation;
    ConvexHttpClient.prototype.query = query;
  }
});
