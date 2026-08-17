/**
 * The production release workflow decides whether a rollout succeeded by
 * reading `adminSystem.materializationReportForRelease`. These pin the two
 * properties that make that safe to rely on: it is reachable without a human
 * identity, and it reports exactly what the `/admin` screen reports.
 *
 * The second is the one that rots quietly. Two functions answering "is this org
 * on the fast path" will drift the moment someone edits one of them, and the
 * drift is invisible — both keep returning plausible reports, and the deploy
 * gate starts certifying something subtly different from what an operator sees.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SOCIAL_CONVERSATION_GENERATION } from "./utils/materialization";

const MODULES = import.meta.glob("./**/*.ts");
const PAGE = { paginationOpts: { numItems: 50, cursor: null } };

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;
beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
});
afterEach(() => {
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.SUPER_ADMIN_EMAILS;
  else process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

async function seedSuperAdmin(t: ReturnType<typeof convexTestWithComponents>) {
  await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "admin", email: "admin@autoflow.dev", name: "Admin" })
  );
  return t.withIdentity({ subject: "admin" });
}

async function seedOrg(t: ReturnType<typeof convexTestWithComponents>, name: string) {
  return await t.run((ctx) => ctx.db.insert("organizations", { name, createdAt: Date.now() }));
}

async function writeState(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  platform: "instagram" | "facebook",
  overrides: Record<string, unknown> = {}
) {
  await t.run((ctx) =>
    ctx.db.insert("socialMaterializationState", {
      orgId,
      platform,
      generation: SOCIAL_CONVERSATION_GENERATION,
      status: "completed",
      runId: "test",
      processedCount: 0,
      materializedCount: 0,
      expectedCount: 0,
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      completedAt: Date.now(),
      ...overrides,
    })
  );
}

describe("the release workflow can read the rollout report", () => {
  test("the internal query answers with NO identity at all", async () => {
    // This is the whole reason it exists. A Convex deploy key carries no Clerk
    // subject, so `requireAuth` rejects it before any handler runs — the public
    // query is structurally unreachable from CI, and a deploy gate that cannot
    // read the state it gates on is not a gate.
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await seedOrg(t, "Bloom Cars");

    const report = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);

    expect(report.page).toHaveLength(1);
    expect(report.page[0]).toMatchObject({ orgId, orgName: "Bloom Cars", readerSource: "legacyEvents" });
  });

  test("the PUBLIC query still refuses everyone who is not a super admin", async () => {
    // Adding the internal route must not have widened the /admin boundary.
    const t = convexTestWithComponents(schema, MODULES);
    await seedOrg(t, "Bloom Cars");

    await expect(t.query(api.adminSystem.getSocialMaterializationStatus, PAGE)).rejects.toThrow();

    const notAdmin = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "sales", email: "sales@bloom.example", name: "Sales" })
    );
    expect(notAdmin).toBeDefined();
    await expect(
      t.withIdentity({ subject: "sales" }).query(api.adminSystem.getSocialMaterializationStatus, PAGE)
    ).rejects.toThrow();
  });

  test("ANTI-DRIFT: the two queries return byte-identical reports", async () => {
    // If someone re-inlines either handler, this is what notices. Both are fed
    // the same deliberately messy state so the comparison covers more than the
    // happy path.
    const t = convexTestWithComponents(schema, MODULES);
    const asAdmin = await seedSuperAdmin(t);

    const ready = await seedOrg(t, "Complete Motors");
    await writeState(t, ready, "instagram", { processedCount: 1029, materializedCount: 12, expectedCount: 1029 });
    await writeState(t, ready, "facebook", { processedCount: 689, materializedCount: 8, expectedCount: 689 });

    const halfway = await seedOrg(t, "Halfway Autos");
    await writeState(t, halfway, "instagram", { status: "running", completedAt: undefined });

    const broken = await seedOrg(t, "Broken Cars");
    await writeState(t, broken, "facebook", {
      status: "failed",
      failureMessage: "hit a document limit",
      completedAt: undefined,
    });

    await seedOrg(t, "Untouched Garage");

    const fromAdmin = await asAdmin.query(api.adminSystem.getSocialMaterializationStatus, PAGE);
    const fromRelease = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);

    expect(fromRelease.page).toHaveLength(4);
    // `_creationTime`-ordered pagination gives both the same order, so the
    // whole payload is comparable rather than just its contents.
    expect(JSON.stringify(fromRelease.page)).toEqual(JSON.stringify(fromAdmin.page));
    expect(fromRelease.isDone).toEqual(fromAdmin.isDone);
  });
});

describe("the report says what the reader will actually do", () => {
  test("both platforms complete at the current generation means materialized", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await seedOrg(t, "Bloom Cars");
    await writeState(t, orgId, "instagram");
    await writeState(t, orgId, "facebook");

    const report = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);
    expect(report.page[0].readerSource).toBe("materialized");
    expect(report.page[0].platforms.map((p) => p.status)).toEqual(["completed", "completed"]);
  });

  test("ONE platform short still means legacyEvents", async () => {
    // An org whose Instagram backfill finished and whose Facebook backfill did
    // not would show a confidently incomplete inbox, which is the same defect
    // as showing a confidently empty one.
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await seedOrg(t, "Bloom Cars");
    await writeState(t, orgId, "instagram");

    const report = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);
    expect(report.page[0].readerSource).toBe("legacyEvents");
  });

  test("THE 2026-08-07 SHAPE survives the query: completed, real events, zero conversations", async () => {
    // The classifier refuses this, but only if the counts reach it. If the
    // report ever stopped carrying `expectedCount`/`materializedCount`, the
    // gate would be comparing zeros and would pass the incident silently.
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await seedOrg(t, "Bloom Cars");
    await writeState(t, orgId, "instagram", {
      processedCount: 347,
      expectedCount: 347,
      materializedCount: 0,
    });
    await writeState(t, orgId, "facebook", {
      processedCount: 689,
      expectedCount: 689,
      materializedCount: 0,
    });

    const report = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);
    expect(report.page[0].readerSource).toBe("materialized");
    expect(report.page[0].platforms.map((p) => [p.expectedCount, p.materializedCount])).toEqual([
      [347, 0],
      [689, 0],
    ]);
  });

  test("contradictory duplicate state rows are reported as ambiguous, not resolved", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await seedOrg(t, "Bloom Cars");
    await writeState(t, orgId, "instagram");
    await writeState(t, orgId, "instagram", { runId: "second" });

    const report = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);
    const instagram = report.page[0].platforms.find((p) => p.platform === "instagram");
    expect(instagram).toMatchObject({ status: "ambiguous", duplicateState: true });
    expect(report.page[0].readerSource).toBe("legacyEvents");
  });
});
