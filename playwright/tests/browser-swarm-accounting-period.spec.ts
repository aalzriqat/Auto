import { test } from "@playwright/test";
import type { Id } from "../../convex/_generated/dataModel";
import {
  assertSwarmPeriodSetupEnvironment,
  ensureSwarmAccountingPeriod,
  SWARM_PERIOD_SETTLE_TIMEOUT_MS,
  SWARM_PERIOD_SETUP_FLAG,
} from "../../scripts/intelligence/browserSwarmAccountingPeriod";
import { authenticatedConvexClient, resolveOrgId } from "../utils";

// Everything before the settle loop: the dashboard load and org resolution, the
// Clerk token wait (up to 30s in playwright/utils.ts), and the period and
// redrive mutations. The default 60s test timeout would fire inside the loop
// and replace its "did not settle" blockers with a bare timeout.
const BROWSER_AND_MUTATION_MARGIN_MS = 90_000;

// SCRUM-350 G4 / SCRUM-411: runs twice in trusted-e2e, before the full trusted
// E2E suite and again after it and before any attack worker, only when the trusted swarm workflow opts in. Anywhere else
// (PR E2E, local runs) this file registers no test at all.
if (process.env[SWARM_PERIOD_SETUP_FLAG] === "1") {
  test.describe("SCRUM-350 swarm accounting period setup", () => {
    // The setup mutates the shared preview's books: a retry must never mask a
    // failed first attempt.
    test.describe.configure({ retries: 0 });

    test("opens the current accounting period and drains its pending outbox", async ({ page }, testInfo) => {
      if (testInfo.retry > 0) {
        throw new Error("swarm accounting period setup never retries");
      }
      testInfo.setTimeout(SWARM_PERIOD_SETTLE_TIMEOUT_MS + BROWSER_AND_MUTATION_MARGIN_MS);
      assertSwarmPeriodSetupEnvironment(process.env);

      const orgId = (await resolveOrgId(page)) as Id<"organizations">;
      const client = await authenticatedConvexClient(page);
      const evidence = await ensureSwarmAccountingPeriod(client, orgId);

      await testInfo.attach("swarm-accounting-period.json", {
        body: Buffer.from(JSON.stringify(evidence, null, 2)),
        contentType: "application/json",
      });
    });
  });
}
