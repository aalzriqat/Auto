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

async function seedConversation(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  platform: "instagram" | "facebook",
  overrides: Record<string, unknown> = {}
) {
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Alice", lastName: "Buyer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("socialConversations", {
      orgId,
      generation: SOCIAL_CONVERSATION_GENERATION,
      conversationKey: `${platform}:dm:alice`,
      platform,
      conversationKind: "dm" as const,
      customerId,
      lastEventAt: Date.now(),
      eventCount: 1,
      unansweredCount: 0,
      vehicleIds: [],
      vehicleCount: 0,
      latestSenderRawId: "raw_alice",
      ...overrides,
    })
  );
}

/** The per-platform table probe, keyed by platform so assertions read plainly. */
function probe(org: {
  platforms: { platform: string; hasCurrentGenerationConversations: boolean }[];
}): Record<string, boolean> {
  return Object.fromEntries(
    org.platforms.map((p) => [p.platform, p.hasCurrentGenerationConversations])
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
    expect(report.page[0]).toMatchObject({ orgId, readerSource: "legacyEvents" });
  });

  test("the ORG NAME never leaves Convex on the release route", async () => {
    // ⚠️ REGRESSION. The release workflow runs on a PUBLIC repository. The
    // verifier hashes the org id before printing anything, but "the caller
    // happens not to log this" is a property of today's caller, not a boundary
    // — so the name is withheld at the source instead.
    //
    // The query returns an explicit ALLOWLIST, which is the part worth pinning:
    // a field added to the shared report later cannot join the payload by
    // default, it has to be named deliberately.
    const t = convexTestWithComponents(schema, MODULES);
    await seedOrg(t, "Al Zriqat Motors");

    const report = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);

    expect(JSON.stringify(report)).not.toMatch(/Al Zriqat Motors/);
    expect(Object.hasOwn(report.page[0], "orgName")).toBe(false);
    expect(Object.keys(report.page[0]).sort()).toEqual(["orgId", "platforms", "readerSource"]);
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

    // The release route withholds `orgName` deliberately, so the comparison is
    // "identical apart from exactly that field" — which is stronger than
    // comparing contents, because it also pins that nothing ELSE differs.
    expect(fromAdmin.page.every((org) => typeof org.orgName === "string")).toBe(true);
    const withoutName = fromAdmin.page.map((org) => ({
      orgId: org.orgId,
      readerSource: org.readerSource,
      platforms: org.platforms,
    }));

    // `_creationTime`-ordered pagination gives both the same order, so the
    // whole payload is comparable rather than just its contents. Compared as
    // values rather than as JSON text: Convex sorts object keys on the way out,
    // so a reconstructed object differs in key ORDER while being identical in
    // content — and key order is not the drift this is watching for.
    expect(fromRelease.page).toEqual(withoutName);
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

  test("the table is PROBED, not inferred — the claim and the rows are separate facts", async () => {
    // ⚠️ This is what makes the 2026-08-07 check enforceable. A completion
    // counter is a *claim* about the table; on that day the reader served a
    // table that had nothing in it. Reporting whether a row actually exists
    // turns the check from an inference into an observation — and it cannot be
    // confused with a healthy all-unlinked org, because those claim zero.
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await seedOrg(t, "Bloom Cars");
    await writeState(t, orgId, "instagram", { materializedCount: 4 });
    await writeState(t, orgId, "facebook", { materializedCount: 4 });

    const claimedButEmpty = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);
    expect(probe(claimedButEmpty.page[0])).toEqual({ instagram: false, facebook: false });

    await seedConversation(t, orgId, "instagram");

    // ⚠️ REGRESSION, and the reason this probe is per-platform. The org-wide
    // version answered `true` here — one Instagram row vouching for Facebook's
    // 8 claimed-and-absent conversations, and a confidently empty Facebook
    // inbox is the 2026-08-07 incident surviving the guard written for it.
    const withRows = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);
    expect(probe(withRows.page[0])).toEqual({ instagram: true, facebook: false });
  });

  test("a row from a SUPERSEDED generation does not count as present", async () => {
    // The probe has to be generation-scoped for the same reason the reader is:
    // superseded rows are inert, and treating them as coverage would vouch for
    // a table the reader will not serve.
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await seedOrg(t, "Bloom Cars");
    await seedConversation(t, orgId, "instagram", {
      generation: SOCIAL_CONVERSATION_GENERATION + 1,
    });

    const report = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);
    expect(probe(report.page[0])).toEqual({ instagram: false, facebook: false });
  });

  test("the run identity is reported, so a stale failure can be told from a new one", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await seedOrg(t, "Bloom Cars");
    await writeState(t, orgId, "instagram", { runId: "run-abc", status: "failed", completedAt: undefined });

    const report = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);
    const instagram = report.page[0].platforms.find((p) => p.platform === "instagram");
    expect(instagram?.runId).toBe("run-abc");
  });

  test("the deployment reports its own URL so a verifier can prove which one answered", async () => {
    // A deploy key names its target, but a credential can be the WRONG
    // credential — a valid production key for another project deploys, verifies
    // and reports success there. This lets the verifier confirm identity over
    // the same connection it verifies on, rather than trusting a log line.
    const t = convexTestWithComponents(schema, MODULES);
    await seedOrg(t, "Bloom Cars");

    const report = await t.query(internal.adminSystem.materializationReportForRelease, PAGE);
    // Convex sets CONVEX_CLOUD_URL in the real function runtime; convex-test
    // does not, so the field must be PRESENT and null rather than absent —
    // absent would read as "not reported" for a different reason.
    expect(Object.hasOwn(report, "deploymentUrl")).toBe(true);
    expect(report.deploymentUrl ?? null).toBe(process.env.CONVEX_CLOUD_URL ?? null);
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
