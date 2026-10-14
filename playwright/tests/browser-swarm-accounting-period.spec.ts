import { test } from "@playwright/test";
import type { Id } from "../../convex/_generated/dataModel";
import {
  assertSwarmPeriodSetupEnvironment,
  ensureSwarmAccountingPeriod,
  SWARM_PERIOD_SETUP_FLAG,
} from "../../scripts/intelligence/browserSwarmAccountingPeriod";
import { authenticatedConvexClient, resolveOrgId } from "../utils";

// SCRUM-350 G4: runs once, after the full trusted E2E suite and before any
// attack worker, only when the trusted swarm workflow opts in. Anywhere else
// (PR E2E, local runs) this file registers no test at all.
if (process.env[SWARM_PERIOD_SETUP_FLAG] === "1") {
  test.describe("SCRUM-350 swarm accounting period setup", () => {
    // The setup mutates the shared preview's books: a retry must never mask a
    // failed first attempt.
    test.describe.configure({ retries: 0 });

    test("opens the current accounting period and proves postings can settle", async ({ page }, testInfo) => {
      if (testInfo.retry > 0) {
        throw new Error("swarm accounting period setup never retries");
      }
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
