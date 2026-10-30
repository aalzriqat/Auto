export const LEAD_STAGES = [
  "NEW",
  "CONTACTED",
  "INTERESTED",
  "TEST_DRIVE",
  "NEGOTIATION",
  "RESERVED",
  "WON",
  "LOST",
] as const;

export type LeadStage = typeof LEAD_STAGES[number];

/**
 * Every cron job that writes a `cronHeartbeats` row. The admin Cron Status
 * panel reads the newest heartbeat *per name in this list* via the by_job
 * index — it deliberately does not scan the table to discover names, because
 * that table grows by ~288 rows/day forever and a full scan re-ran on every
 * heartbeat insert (every 5 min) was the single largest consumer of database
 * bandwidth on this deployment.
 *
 * Adding a heartbeat to a new cron means adding its name here, or it will not
 * appear on the admin panel. `adminSystem.test.ts` fails if a job inserts a
 * heartbeat under a name that is missing from this list.
 */
export const CRON_HEARTBEAT_JOBS = [
  "check-upcoming-tasks",
  "reconcile-expired-subscriptions",
] as const;

export type CronHeartbeatJob = typeof CRON_HEARTBEAT_JOBS[number];

/**
 * SCRUM-869 (PR #716 round 3): the durable failure signal of the supplier due-alert worker.
 *
 * A Convex mutation that throws rolls back everything it wrote, including any failure row it tried to
 * write, so the worker cannot report its own failure; the action that runs it does, from a separate
 * transaction, into `cronHeartbeats`. The job name is per organisation so that one organisation's
 * later success can never hide another's failure. These names are deliberately NOT in
 * `CRON_HEARTBEAT_JOBS`: that list drives the fixed-width Cron Status panel, and one name per
 * organisation would not fit it. They are read by `adminSystem.listSupplierDueAlertFailures`, which
 * pages the organisations.
 */
export const SUPPLIER_DUE_ALERT_JOB_PREFIX = "supplier-due-alerts:";

export function supplierDueAlertJobName(orgId: string): string {
  return `${SUPPLIER_DUE_ALERT_JOB_PREFIX}${orgId}`;
}