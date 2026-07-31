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
export const CRON_HEARTBEAT_JOBS = ["check-upcoming-tasks"] as const;

export type CronHeartbeatJob = typeof CRON_HEARTBEAT_JOBS[number];
