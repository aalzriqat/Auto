import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";
import type { BrowserOracleKind } from "./browserAttackSwarm";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { runBoundaryMission, type BoundaryMissionSpec } from "./browserSwarmBoundaryHarness";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import type { MissionBrowser, MissionBrowserRuntime, MissionSeat } from "./browserSwarmEconomicAttacks";

/**
 * SCRUM-350 — the shared boundary mission lifecycle. It owns the evidence
 * contract, so these tests pin it independently of any attack: nothing passes
 * without its evidence, a proven breach survives an interruption and a flaky
 * write, and every run that cannot conclude still leaves labelled evidence.
 */

interface Options {
  /** The first N backend evidence writes fail. */
  writeFailures?: number;
  /** Evidence writes carrying one of these outcomes fail; every other write lands. */
  failOutcomes?: string[];
  finishFails?: boolean;
  signal?: AbortSignal;
  oracle?: BrowserOracleKind;
}

function setup(options: Options = {}) {
  const evidence: Record<string, unknown>[] = [];
  const opened: { seat: MissionSeat; finished: boolean }[] = [];
  const order: string[] = [];
  let failuresLeft = options.writeFailures ?? 0;
  /** Every evidence write attempted, landed or not. */
  const attempted: Record<string, unknown>[] = [];
  const runtimeApi: MissionBrowserRuntime = {
    open: async (_context, seat = "primary") => {
      const entry = { seat, finished: false };
      opened.push(entry);
      return {
        browser: {} as MissionBrowser["browser"],
        browserContext: { entry } as unknown as MissionBrowser["browserContext"],
        page: { seat } as unknown as Page,
        paths: { root: "r", trace: "t", screenshot: "s", backendState: "backend-state.json" },
      };
    },
    finish: async (runtime) => {
      order.push("finish");
      (runtime.browserContext as unknown as { entry: { finished: boolean } }).entry.finished = true;
      if (options.finishFails) throw new Error("trace stop failed");
      return ["trace.zip"];
    },
    rethrowAfterCleanup: async (_runtime, error) => {
      throw error;
    },
    writeBackendEvidence: async (paths, value) => {
      order.push("evidence");
      attempted.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
      if (options.failOutcomes?.includes((value as { outcome?: string }).outcome ?? "")) throw new Error("labelled write failed");
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("disk full");
      }
      evidence.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
      return paths.backendState;
    },
    resolveOrgRoute: async () => "org1",
    authenticatedClient: async () => ({}) as ConvexHttpClient,
  };
  const context = {
    manifest: { runId: "run-1" },
    worker: { workerId: "worker-1" },
    mission: { id: "mission-1", family: "TENANT_ESCAPE", oracle: options.oracle ?? "TENANT_ISOLATION" },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const spec = (run: BoundaryMissionSpec["run"]): BoundaryMissionSpec => ({
    attack: "TEST_ATTACK",
    seat: "primary",
    oracles: ["TENANT_ISOLATION"],
    passSummary: "held",
    breachSummary: "broke",
    run,
  });
  return {
    evidence,
    attempted,
    opened,
    order,
    run: (run: BoundaryMissionSpec["run"]) => runBoundaryMission(runtimeApi, context, spec(run)),
  };
}

describe("SCRUM-350 runBoundaryMission", () => {
  it("passes only when every observation was judged clean and the evidence was written", async () => {
    const t = setup();
    const result = await t.run(async (env) => {
      env.judge({ violations: [], unjudged: [] });
    });
    expect(result.oracle).toEqual({ kind: "TENANT_ISOLATION", passed: true, summary: "held" });
    expect(t.evidence).toHaveLength(1);
    expect(t.opened.every((entry) => entry.finished)).toBe(true);
  });

  it("an attack that records no observation at all is inconclusive, never a pass by omission", async () => {
    const t = setup();
    await expect(t.run(async () => undefined)).rejects.toThrow(/recorded no observation/);
    expect(t.evidence.at(-1)).toMatchObject({ outcome: "INCONCLUSIVE" });
  });

  it("an explicitly unjudged observation is inconclusive, never a pass", async () => {
    const t = setup();
    await expect(
      t.run(async (env) => {
        env.unjudged("nothing was observed");
      }),
    ).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(t.evidence.at(-1)).toMatchObject({ outcome: "INCONCLUSIVE", reason: expect.stringContaining("nothing was observed") });
  });

  it("proof wins over unjudged observations and is labelled partial", async () => {
    const t = setup();
    const result = await t.run(async (env) => {
      env.judge({ violations: ["leak"], unjudged: [] });
      env.unjudged("something else could not be read");
    });
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toBe("broke: leak");
    expect(t.evidence[0]).toMatchObject({ phase: "PARTIAL", unjudged: ["something else could not be read"] });
  });

  it("a pass is never certified when its evidence cannot be written", async () => {
    const t = setup({ writeFailures: 1 });
    await expect(
      t.run(async (env) => {
        env.judge({ violations: [], unjudged: [] });
      }),
    ).rejects.toThrow(/disk full/);
    expect(t.evidence).toHaveLength(1);
    expect(t.evidence[0]).toMatchObject({ outcome: "HARNESS_ERROR", reason: "disk full" });
    // The browsers were finished before the write; the failure path must not finish them again.
    expect(t.order.filter((step) => step === "finish")).toHaveLength(1);
  });

  it("a proven breach survives one failed evidence write", async () => {
    const t = setup({ writeFailures: 1 });
    const result = await t.run(async (env) => {
      env.judge({ violations: ["leak"], unjudged: [] });
    });
    expect(result.oracle.passed).toBe(false);
    expect(t.evidence).toHaveLength(1);
  });

  it("a proven breach whose evidence cannot be delivered is labelled BREACH_UNDELIVERED and not certified", async () => {
    const t = setup({ writeFailures: 2 });
    await expect(
      t.run(async (env) => {
        env.judge({ violations: ["leak"], unjudged: [] });
      }),
    ).rejects.toThrow(/disk full/);
    expect(t.evidence.at(-1)).toMatchObject({ outcome: "BREACH_UNDELIVERED", violations: ["leak"] });
  });

  it("a failure after proof still concludes as a breach, marked as interrupted", async () => {
    const t = setup();
    const result = await t.run(async (env) => {
      env.judge({ violations: ["leak"], unjudged: [] });
      throw new Error("page crashed");
    });
    expect(result.oracle.passed).toBe(false);
    expect(t.evidence[0]).toMatchObject({ phase: "INTERRUPTED", interruptedBy: "page crashed" });
  });

  it("a failure with no proof is a harness error with labelled evidence, never a pass", async () => {
    const t = setup();
    await expect(
      t.run(async () => {
        throw new Error("page crashed");
      }),
    ).rejects.toThrow(/page crashed/);
    expect(t.evidence.at(-1)).toMatchObject({ outcome: "HARNESS_ERROR", reason: "page crashed" });
    expect(t.opened.every((entry) => entry.finished)).toBe(true);
  });

  it("an aborted mission is never reported as a breach", async () => {
    const controller = new AbortController();
    const t = setup({ signal: controller.signal });
    await expect(
      t.run(async (env) => {
        env.judge({ violations: ["leak"], unjudged: [] });
        controller.abort(new Error("timed out"));
        await new Promise(() => undefined);
      }),
    ).rejects.toThrow(/timed out/);
    expect(t.evidence.some((entry) => entry.phase === "INTERRUPTED")).toBe(false);
  });

  it("runs cleanups newest first, before the evidence, and reports a failed one without hiding it", async () => {
    const t = setup();
    const calls: string[] = [];
    await t.run(async (env) => {
      env.onCleanup("first", async () => {
        calls.push("first");
        t.order.push("cleanup-first");
      });
      env.onCleanup("second", async () => {
        calls.push("second");
        t.order.push("cleanup-second");
        throw new Error("already gone");
      });
      env.judge({ violations: [], unjudged: [] });
    });
    expect(calls).toEqual(["second", "first"]);
    expect(t.order).toEqual(["cleanup-second", "cleanup-first", "finish", "evidence"]);
    expect(t.evidence[0].cleanup).toEqual({ second: "failed: already gone", first: "done" });
  });

  it("skips cleanups of an aborted mission so it never touches the preview again", async () => {
    const controller = new AbortController();
    const t = setup({ signal: controller.signal });
    const calls: string[] = [];
    await expect(
      t.run(async (env) => {
        env.onCleanup("undo", async () => {
          calls.push("undo");
        });
        controller.abort(new Error("timed out"));
        await new Promise(() => undefined);
      }),
    ).rejects.toThrow(/timed out/);
    expect(calls).toEqual([]);
  });

  it("opens an extra seat in its own browser and closes it with the mission", async () => {
    const t = setup();
    await t.run(async (env) => {
      const other = await env.openSeat("approver");
      expect(other.seat).toBe("approver");
      expect(other.orgId).toBe("org1");
      env.judge({ violations: [], unjudged: [] });
    });
    expect(t.opened.map((entry) => entry.seat)).toEqual(["primary", "approver"]);
    expect(t.opened.every((entry) => entry.finished)).toBe(true);
  });

  it("a pass is not certified when browser cleanup fails", async () => {
    const t = setup({ finishFails: true });
    await expect(
      t.run(async (env) => {
        env.judge({ violations: [], unjudged: [] });
      }),
    ).rejects.toThrow(/browser evidence cleanup failed: trace stop failed/);
  });

  it("a pass whose browser cleanup fails leaves its evidence labelled HARNESS_ERROR, never pass-looking", async () => {
    const t = setup({ finishFails: true });
    await expect(
      t.run(async (env) => {
        env.judge({ violations: [], unjudged: [] });
      }),
    ).rejects.toThrow(/browser evidence cleanup failed/);
    // The browsers fail before anything is written, so the only evidence is the failure label.
    expect(t.evidence).toHaveLength(1);
    expect(t.evidence[0]).toMatchObject({
      outcome: "HARNESS_ERROR",
      reason: expect.stringContaining("browser evidence cleanup failed: trace stop failed"),
      browserCleanupFailure: "trace stop failed",
    });
  });

  it("a pass whose browser cleanup fails never writes pass-shaped evidence, even when the failure write also fails", async () => {
    const t = setup({ finishFails: true, failOutcomes: ["HARNESS_ERROR"] });
    const error: unknown = await t
      .run(async (env) => {
        env.judge({ violations: [], unjudged: [] });
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect((error as Error).message).toMatch(/browser evidence cleanup failed: trace stop failed/);
    // Nothing pass-shaped may be on disk, and none may even have been attempted.
    expect(t.evidence).toEqual([]);
    expect(t.attempted.length).toBeGreaterThan(0);
    expect(t.attempted.every((body) => body.outcome === "HARNESS_ERROR")).toBe(true);
  });

  it("finishes the browsers before a pass's evidence is written, and after a breach's", async () => {
    const pass = setup();
    await pass.run(async (env) => {
      env.judge({ violations: [], unjudged: [] });
    });
    expect(pass.order).toEqual(["finish", "evidence"]);
    const breach = setup();
    await breach.run(async (env) => {
      env.judge({ violations: ["leak"], unjudged: [] });
    });
    // A breach is made durable first so a stuck browser cannot delay or lose it.
    expect(breach.order).toEqual(["evidence", "finish"]);
  });

  it("a breach survives a browser cleanup failure and says so", async () => {
    const t = setup({ finishFails: true });
    const result = await t.run(async (env) => {
      env.judge({ violations: ["leak"], unjudged: [] });
    });
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/browser evidence cleanup also failed: trace stop failed/);
    // A proven breach is never relabelled: its evidence is the only write.
    expect(t.evidence).toHaveLength(1);
    expect(t.evidence[0]).not.toHaveProperty("outcome");
    expect(t.evidence[0]).toMatchObject({ violations: ["leak"] });
  });

  it("refuses a mission whose oracle the attack does not judge, before touching anything", async () => {
    const t = setup({ oracle: "AUTHORIZATION" });
    await expect(t.run(async () => undefined)).rejects.toThrow(/does not judge the AUTHORIZATION oracle/);
    expect(t.opened).toEqual([]);
  });
});
