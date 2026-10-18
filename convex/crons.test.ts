import { expect, test } from "vitest";
import crons from "./crons";

// SCRUM-807: the owner requires all Convex records to be preserved while I/O is
// diagnosed. The scheduled sweep deleted from four tables every hour, so no
// registered cron may target it (the mutation itself is also gone; see
// adminSystem.test.ts).
test("no scheduled cron targets adminSystem.pruneOperationalLogs", () => {
  const registered = Object.values(crons.crons);
  expect(registered.length).toBeGreaterThan(0); // guards against an empty/mis-imported registry
  // CronJob.name is the scheduled function's path, e.g. "adminSystem:pruneOperationalLogs".
  expect(registered.map((job) => job.name)).not.toContain("adminSystem:pruneOperationalLogs");
});
