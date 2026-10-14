import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import { describe, expect, it } from "vitest";
import {
  assertSwarmPeriodSetupEnvironment,
  ensureSwarmAccountingPeriod,
  SWARM_PERIOD_SETUP_FLAG,
} from "./browserSwarmAccountingPeriod";

/**
 * SCRUM-350 G4 (PR #581, run 38529903614): the disposable swarm preview had a
 * chart of accounts and NO accounting period, so every expense stayed QUEUED in
 * the outbox, ACC-2 never saw a POSTED ledger and returned HARNESS_ERROR. These
 * tests pin the trusted setup that opens the current period between trusted E2E
 * and the attack workers, and the fail-closed verification that follows it.
 */

const ORG = "org_swarm" as never;
const NOW = Date.UTC(2026, 9, 14, 11, 6, 0); // 2026-10-14
const OCT_START = Date.UTC(2026, 9, 1);
const OCT_END = Date.UTC(2026, 10, 1) - 1;

type Status = "FUTURE" | "OPEN" | "CLOSING" | "CLOSED" | "LOCKED";
type Period = {
  _id: string;
  fiscalYear: number;
  periodNumber: number;
  startDate: number;
  endDate: number;
  status: Status;
};
type Pending = { _id: string; status: "PENDING" | "POSTED" | "FAILED"; accountingDate: number };

interface Options {
  periods?: Period[];
  pending?: Pending[];
  /** What a redrive does to the in-window PENDING rows. Default: post them. */
  redrive?: "posts" | "stalls";
  /** currentOpenPeriod answers null even though the period is open. */
  currentOpenIsNull?: boolean;
  /** currentOpenPeriod answers a different, stale period. */
  currentOpenIsStale?: boolean;
  /** The backend refuses accountingPeriods.create with this message. */
  createRefusal?: string;
  /** The instant the backend and the setup both read as "now". */
  now?: number;
  /** Runs on every client call, so a test can make round trips consume time. */
  onCall?: () => void;
}

function setup(options: Options = {}) {
  const periods: Period[] = (options.periods ?? []).map((period) => ({ ...period }));
  const pending: Pending[] = (options.pending ?? []).map((row) => ({ ...row }));
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const now = options.now ?? NOW;
  let nextId = 1;

  const client = {
    query: async (ref: never, args: Record<string, unknown>) => {
      options.onCall?.();
      const name = getFunctionName(ref);
      calls.push({ name, args });
      if (name === "accountingPeriods:list") return periods.map((period) => ({ ...period }));
      if (name === "accountingPeriods:currentOpenPeriod") {
        if (options.currentOpenIsNull) return null;
        if (options.currentOpenIsStale) {
          return { _id: "period_stale", status: "OPEN", startDate: 0, endDate: 1 };
        }
        return (
          periods.find((p) => p.status === "OPEN" && p.startDate <= now && p.endDate >= now) ?? null
        );
      }
      if (name === "accountingOutbox:listPending") {
        const limit = Number(args.limit);
        return pending.filter((row) => row.status === args.status).slice(0, limit);
      }
      throw new Error(`unexpected query ${name}`);
    },
    mutation: async (ref: never, args: Record<string, unknown>) => {
      options.onCall?.();
      const name = getFunctionName(ref);
      calls.push({ name, args });
      if (name === "accountingPeriods:create") {
        if (options.createRefusal) throw new Error(options.createRefusal);
        const id = `period_${nextId++}`;
        periods.push({
          _id: id,
          fiscalYear: Number(args.fiscalYear),
          periodNumber: Number(args.periodNumber),
          startDate: Number(args.startDate),
          endDate: Number(args.endDate),
          status: args.openImmediately ? "OPEN" : "FUTURE",
        });
        return id;
      }
      if (name === "accountingPeriods:open") {
        const period = periods.find((p) => p._id === args.periodId);
        if (!period) throw new Error("Period not found in this organization.");
        period.status = "OPEN";
        return period._id;
      }
      if (name === "accountingOutbox:redrive") {
        if (options.redrive !== "stalls") {
          for (const row of pending) {
            if (periods.some((p) => p.status === "OPEN" && p.startDate <= row.accountingDate && p.endDate >= row.accountingDate)) {
              row.status = "POSTED";
            }
          }
        }
        return { queued: 0 };
      }
      throw new Error(`unexpected mutation ${name}`);
    },
  } as unknown as ConvexHttpClient;

  const run = (overrides: Partial<Parameters<typeof ensureSwarmAccountingPeriod>[2]> = {}) =>
    ensureSwarmAccountingPeriod(client, ORG, {
      now: () => now,
      sleep: async () => undefined,
      timeoutMs: 5,
      pollMs: 1,
      ...overrides,
    });
  const mutations = () =>
    calls.filter((call) => /:(create|open|redrive)$/.test(call.name)).map((call) => call.name);
  return { run, calls, periods, pending, mutations };
}

const octoberPeriod = (status: Status, id = "period_oct"): Period => ({
  _id: id,
  fiscalYear: 2026,
  periodNumber: 10,
  startDate: OCT_START,
  endDate: OCT_END,
  status,
});

describe("ensureSwarmAccountingPeriod", () => {
  it("creates and opens the current UTC month when the preview has no period (the PR #581 state)", async () => {
    const { run, calls, mutations } = setup();

    const evidence = await run();

    const create = calls.find((call) => call.name === "accountingPeriods:create");
    expect(create?.args).toEqual({
      orgId: ORG,
      fiscalYear: 2026,
      periodNumber: 10,
      startDate: OCT_START,
      endDate: OCT_END,
      openImmediately: true,
    });
    expect(evidence).toMatchObject({
      action: "created",
      fiscalYear: 2026,
      periodNumber: 10,
      startDate: OCT_START,
      endDate: OCT_END,
      pendingInWindow: 0,
    });
    expect(mutations()).toEqual(["accountingPeriods:create", "accountingOutbox:redrive"]);
  });

  it("leaves an already-open covering period alone and still verifies it", async () => {
    const { run, mutations } = setup({ periods: [octoberPeriod("OPEN")] });

    const evidence = await run();

    expect(evidence.action).toBe("already-open");
    expect(mutations()).toEqual(["accountingOutbox:redrive"]);
  });

  it("opens a FUTURE covering period instead of creating a conflicting one", async () => {
    const { run, mutations, periods } = setup({ periods: [octoberPeriod("FUTURE")] });

    const evidence = await run();

    expect(evidence.action).toBe("opened");
    expect(mutations()).toEqual(["accountingPeriods:open", "accountingOutbox:redrive"]);
    expect(periods).toHaveLength(1);
  });

  it.each(["CLOSING", "CLOSED", "LOCKED"] as const)(
    "refuses a %s covering period without reopening it or touching the books",
    async (status) => {
      const { run, mutations } = setup({ periods: [octoberPeriod(status)] });

      await expect(run()).rejects.toThrow(new RegExp(status));
      expect(mutations()).toEqual([]);
    },
  );

  it("propagates a refused create instead of swallowing it, and never reaches verification", async () => {
    // A period with the same year and number but other dates does not cover
    // now, so a create is attempted and the backend refuses it as a conflict.
    const clash: Period = { ...octoberPeriod("OPEN", "period_clash"), startDate: 0, endDate: 1 };
    const { run, mutations } = setup({
      periods: [clash],
      createRefusal: "Period 2026-10 already exists.",
    });

    await expect(run()).rejects.toThrow("Period 2026-10 already exists.");
    expect(mutations()).toEqual(["accountingPeriods:create"]);
  });

  it("computes December and January windows without spilling into the next year", async () => {
    const dec = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
    const decEvidence = await setup({ now: dec }).run();
    expect(decEvidence).toMatchObject({
      fiscalYear: 2026,
      periodNumber: 12,
      startDate: Date.UTC(2026, 11, 1),
      endDate: Date.UTC(2027, 0, 1) - 1,
    });

    const jan = Date.UTC(2027, 0, 1, 0, 0, 0, 0);
    const janEvidence = await setup({ now: jan }).run();
    expect(janEvidence).toMatchObject({ fiscalYear: 2027, periodNumber: 1 });
  });

  describe("verification before any attack worker starts", () => {
    it("waits for PENDING events inside the period window and succeeds once they post", async () => {
      const { run, pending } = setup({
        pending: [{ _id: "evt_1", status: "PENDING", accountingDate: NOW - 1000 }],
      });

      const evidence = await run();

      expect(pending[0].status).toBe("POSTED");
      expect(evidence.pendingInWindow).toBe(0);
    });

    it("fails closed when a PENDING event inside the window never posts (the ACC-2 QUEUED symptom)", async () => {
      const { run } = setup({
        redrive: "stalls",
        pending: [{ _id: "evt_stuck", status: "PENDING", accountingDate: NOW - 1000 }],
      });

      await expect(run()).rejects.toThrow(/did not settle/i);
    });

    it("ignores PENDING events dated outside the period it opened", async () => {
      const { run } = setup({
        redrive: "stalls",
        pending: [{ _id: "evt_aug", status: "PENDING", accountingDate: Date.UTC(2026, 7, 15) }],
      });

      const evidence = await run();

      expect(evidence.pendingInWindow).toBe(0);
    });

    it("fails closed when the backend does not report the period as the current open one", async () => {
      await expect(setup({ currentOpenIsNull: true }).run()).rejects.toThrow(/did not settle/i);
      await expect(setup({ currentOpenIsStale: true }).run()).rejects.toThrow(/did not settle/i);
    });

    it("fails closed when the pending list is truncated and cannot prove the window is empty", async () => {
      const outside = Array.from({ length: 200 }, (_, index) => ({
        _id: `evt_${index}`,
        status: "PENDING" as const,
        accountingDate: Date.UTC(2026, 7, 15),
      }));
      const { run } = setup({ redrive: "stalls", pending: outside });

      await expect(run()).rejects.toThrow(/did not settle/i);
    });

    it("bounds the wait by elapsed time when every backend call consumes time, not by an attempt count", async () => {
      // Fake time: each client call costs 400ms and each sleep advances the clock
      // by what it was asked for. List, create and redrive are three calls, so the
      // 5s budget starts at t=1200ms and the deadline is t=6200ms:
      //   check 1 = two queries -> t=2000, remaining 4200, sleep 1000 -> 3000
      //   check 2 -> 3800, remaining 2400, sleep 1000 -> 4800
      //   check 3 -> 5600, remaining 600, sleep clamped to 600 -> 6200
      //   check 4 -> 7000, deadline passed -> refuse
      // An attempt-count loop (ceil(5000 / 1000) = 5) would run a fifth check and
      // never clamp the last sleep.
      let elapsed = 0;
      const sleeps: number[] = [];
      const { run, calls } = setup({
        redrive: "stalls",
        pending: [{ _id: "evt_stuck", status: "PENDING", accountingDate: NOW - 1000 }],
        onCall: () => {
          elapsed += 400;
        },
      });

      await expect(
        run({
          clock: () => elapsed,
          sleep: async (ms) => {
            sleeps.push(ms);
            elapsed += ms;
          },
          timeoutMs: 5_000,
          pollMs: 1_000,
        }),
      ).rejects.toThrow("did not settle within 5000ms (4 checks)");

      expect(sleeps).toEqual([1_000, 1_000, 600]);
      expect(calls.filter((call) => call.name === "accountingOutbox:listPending")).toHaveLength(4);
    });
  });
});

describe("assertSwarmPeriodSetupEnvironment", () => {
  const valid = {
    CI: "true",
    [SWARM_PERIOD_SETUP_FLAG]: "1",
    PLAYWRIGHT_SKIP_WEBSERVER: "1",
    BROWSER_EGRESS_REQUIRED: "1",
    BROWSER_EGRESS_PROXY_SERVER: "http://127.0.0.1:3129",
  };

  it("accepts the trusted workflow environment", () => {
    expect(() => assertSwarmPeriodSetupEnvironment(valid)).not.toThrow();
  });

  it.each([
    ["the opt-in flag", { [SWARM_PERIOD_SETUP_FLAG]: undefined }],
    ["CI=true", { CI: undefined }],
    ["the skipped web server", { PLAYWRIGHT_SKIP_WEBSERVER: undefined }],
    ["the egress proxy", { BROWSER_EGRESS_PROXY_SERVER: undefined }],
  ])("refuses to run without %s", (_label, patch) => {
    expect(() => assertSwarmPeriodSetupEnvironment({ ...valid, ...patch })).toThrow();
  });
});
