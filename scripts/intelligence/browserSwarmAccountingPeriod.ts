/**
 * SCRUM-350 G4 — swarm-only accounting period setup.
 *
 * The disposable swarm preview is seeded with a chart of accounts and, on
 * purpose, NO accounting period (`seedAccountingBaseline` in
 * convex/e2eBootstrap.ts: Accounting Cloud Rehearsal relies on that). Without
 * an open period every posting parks in the accounting outbox, so ACC-2 never
 * sees a POSTED ledger and cannot judge reversal (PR #581, run 38529903614).
 *
 * This runs once, after trusted E2E and before any attack worker, through the
 * same public mutations a dealership uses. It opens the period the current
 * instant falls in, then refuses to finish until the backend itself reports
 * that period as the current open one and no PENDING outbox event dated inside
 * it remains. That establishes an open period and a drained backlog; it does
 * not post anything or observe a posting, so it is not proof that a later
 * expense will reach POSTED. It never writes a probe expense: ACC-2 judges its
 * own.
 */
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { browserEgressLaunchOptions } from "./browserEgressLaunch.mjs";

export const SWARM_PERIOD_SETUP_FLAG = "BROWSER_SWARM_PERIOD_SETUP";

const PENDING_PAGE_LIMIT = 200; // accountingOutbox.listPending caps at 200
/** Real elapsed time the final check loop may take; the spec sizes its own timeout from this. */
export const SWARM_PERIOD_SETTLE_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 1_000;

export type SwarmAccountingPeriodEvidence = {
  action: "created" | "opened" | "already-open";
  periodId: string;
  fiscalYear: number;
  periodNumber: number;
  startDate: number;
  endDate: number;
  /** PENDING outbox events dated inside the period at the final check. */
  pendingInWindow: number;
  verificationAttempts: number;
};

export type SwarmAccountingPeriodOptions = {
  /** The instant whose month is opened. */
  now?: () => number;
  /** Elapsed-time clock for the settle deadline; separate so a fixed `now` cannot stall it. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
};

type Env = Record<string, string | undefined>;

export function assertSwarmPeriodSetupEnvironment(env: Env): void {
  if (env[SWARM_PERIOD_SETUP_FLAG] !== "1") {
    throw new Error(`Swarm period setup requires ${SWARM_PERIOD_SETUP_FLAG}=1`);
  }
  if (env.CI !== "true") {
    throw new Error("Swarm period setup requires CI=true so Playwright cannot reuse a local server");
  }
  if (!env.PLAYWRIGHT_SKIP_WEBSERVER?.trim()) {
    throw new Error("Swarm period setup must drive the already-running trusted candidate frontend");
  }
  // The browser holds the authenticated QA seat: no trusted egress proxy, no run.
  browserEgressLaunchOptions({ ...env, BROWSER_EGRESS_REQUIRED: "1" });
}

type PeriodRow = {
  _id: Id<"accountingPeriods">;
  fiscalYear: number;
  periodNumber: number;
  startDate: number;
  endDate: number;
  status: string;
};

function periodLabel(period: Pick<PeriodRow, "fiscalYear" | "periodNumber">): string {
  return `${period.fiscalYear}-${String(period.periodNumber).padStart(2, "0")}`;
}

/** Opens (or confirms) the period containing `now` and returns what to check. */
async function establishPeriod(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
  now: number,
): Promise<{ period: PeriodRow; action: SwarmAccountingPeriodEvidence["action"] }> {
  const periods = (await client.query(api.accountingPeriods.list, { orgId })) as PeriodRow[];
  const covering = periods.find((p) => p.startDate <= now && p.endDate >= now);

  if (covering) {
    if (covering.status === "OPEN") return { period: covering, action: "already-open" };
    // A closing/closed/locked period is a deliberate state of the books. A
    // fresh preview should never hold one; do not reopen it to make a run pass.
    if (covering.status !== "FUTURE") {
      throw new Error(
        `Accounting period ${periodLabel(covering)} covers this instant but is ${covering.status}; refusing to reopen it.`,
      );
    }
    await client.mutation(api.accountingPeriods.open, { orgId, periodId: covering._id });
    return { period: { ...covering, status: "OPEN" }, action: "opened" };
  }

  const at = new Date(now);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const startDate = Date.UTC(year, month, 1);
  const endDate = Date.UTC(year, month + 1, 1) - 1;
  const periodId = await client.mutation(api.accountingPeriods.create, {
    orgId,
    fiscalYear: year,
    periodNumber: month + 1,
    startDate,
    endDate,
    openImmediately: true,
  });
  return {
    period: { _id: periodId, fiscalYear: year, periodNumber: month + 1, startDate, endDate, status: "OPEN" },
    action: "created",
  };
}

/** What still blocks `period` from being the open period with a drained backlog; empty means none. */
async function postingBlockers(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
  period: PeriodRow,
): Promise<{ blockers: string[]; pendingInWindow: number }> {
  const blockers: string[] = [];

  const current = (await client.query(api.accountingPeriods.currentOpenPeriod, { orgId })) as
    | { _id: string; status: string }
    | null;
  if (!current || current._id !== period._id || current.status !== "OPEN") {
    blockers.push("the backend does not report this period as the current open one");
  }

  const pending = (await client.query(api.accountingOutbox.listPending, {
    orgId,
    status: "PENDING",
    limit: PENDING_PAGE_LIMIT,
  })) as { accountingDate: number }[];
  const pendingInWindow = pending.filter(
    (event) => event.accountingDate >= period.startDate && event.accountingDate <= period.endDate,
  ).length;
  if (pendingInWindow > 0) {
    blockers.push(`${pendingInWindow} outbox event(s) dated inside the period are still PENDING`);
  } else if (pending.length >= PENDING_PAGE_LIMIT) {
    blockers.push(`the PENDING outbox list is truncated at ${PENDING_PAGE_LIMIT}, so an empty window is unproven`);
  }
  return { blockers, pendingInWindow };
}

export async function ensureSwarmAccountingPeriod(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
  options: SwarmAccountingPeriodOptions = {},
): Promise<SwarmAccountingPeriodEvidence> {
  const now = (options.now ?? Date.now)();
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? SWARM_PERIOD_SETTLE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const { period, action } = await establishPeriod(client, orgId, now);
  // Opening drains the outbox itself; a freshly created OPEN period does not,
  // and anything queued earlier in the run must post before workers attack.
  await client.mutation(api.accountingOutbox.redrive, { orgId });

  // Real elapsed time, not an attempt count: every check costs round trips on
  // top of the sleep, so counting polls would run well past `timeoutMs`.
  const deadline = clock() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    const { blockers, pendingInWindow } = await postingBlockers(client, orgId, period);
    if (blockers.length === 0) {
      return {
        action,
        periodId: period._id,
        fiscalYear: period.fiscalYear,
        periodNumber: period.periodNumber,
        startDate: period.startDate,
        endDate: period.endDate,
        pendingInWindow,
        verificationAttempts: attempt,
      };
    }
    const remainingMs = deadline - clock();
    if (remainingMs <= 0) {
      throw new Error(
        `Swarm accounting period ${periodLabel(period)} did not settle within ${timeoutMs}ms (${attempt} checks): ${blockers.join("; ")}.`,
      );
    }
    await sleep(Math.min(pollMs, remainingMs));
  }
}
