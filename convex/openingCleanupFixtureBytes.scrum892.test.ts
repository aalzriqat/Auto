import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getDocumentSize } from "convex/values";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  OPENING_CLEANUP_PAGE_BYTES, OPENING_CLEANUP_PAGE_OPTIONS, OPENING_CLEANUP_PAGE_ROWS,
} from "./utils/openingResetCleanup";

/**
 * SCRUM-892. The cleanup cap fixtures exist only to push one 50-row `openingBalanceDrafts` page over the 512 000-byte
 * `maximumBytesRead` budget of `openingResetCleanup`. They once used 32 KiB per row (3.3 MB per read, re-read by every
 * observation and reset call), about 6.5 times what the budget needs. Convex bills database I/O per byte read.
 *
 * convex-test 0.0.53 enforces `maximumBytesRead` (it sums `getDocumentSize` per row and returns `SplitRequired`), so the
 * paginate assertions below do exercise the cap. They share the byte accounting of the real runtime but not its scheduler,
 * so the trusted rehearsal's SAME_INVOCATION_CAP_GUARD_MARKER case remains the proof against a live deployment.
 */
const CLOUD = "https://cleanup-bytes.convex.cloud";
const PRIMARY = { clerkUserId: "bytes-primary", email: "primary@bytes.example.test", name: "Primary QA" };
const APPROVER = { clerkUserId: "bytes-approver", email: "approver@bytes.example.test", name: "Approver QA" };
const BYTES_PER_ROW = OPENING_CLEANUP_PAGE_BYTES / OPENING_CLEANUP_PAGE_ROWS;
/** A row may carry at most this much per row: the cap plus the headroom the fixture needs, never the old 32 KiB. */
const MAX_FIXTURE_BYTES_PER_ROW = BYTES_PER_ROW * 1.25;

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function seed(large: boolean) {
  vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "preview");
  vi.stubEnv("CONVEX_CLOUD_URL", CLOUD);
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  registerRateLimiter(t);
  await t.mutation(internal.e2eBootstrap.markPreviewDeployment, {});
  const baseline = await t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, { primary: PRIMARY, approver: APPROVER, expectedCloudUrl: CLOUD });
  const primary = t.withIdentity({ subject: PRIMARY.clerkUserId });
  const orgId = await primary.mutation(api.organizations.create, { name: "QA TEST cleanup bytes" });
  const role = (await primary.query(api.roles.list, { orgId })).find(row => row.name === "SENIOR_ACCOUNTANT");
  if (!role) throw new Error("Missing native finance role");
  await primary.mutation(api.memberships.add, { orgId, userEmail: APPROVER.email, roleId: role._id });
  await t.mutation(internal.e2eBootstrap.prepareOpeningCleanupFixture, {
    orgId, knownOrgIds: [baseline.orgId, orgId], primaryClerkUserId: PRIMARY.clerkUserId,
    approverClerkUserId: APPROVER.clerkUserId, expectedCloudUrl: CLOUD, stage: "SEED_HISTORY", large,
  });
  return { t, orgId };
}

async function productionPage(fixture: Awaited<ReturnType<typeof seed>>, cursor: string | null) {
  return await fixture.t.run(ctx => ctx.db.query("openingBalanceDrafts")
    .withIndex("by_org", q => q.eq("orgId", fixture.orgId)).paginate({ cursor, ...OPENING_CLEANUP_PAGE_OPTIONS }));
}

test("the hoisted page options keep the production cap values byte for byte", () => {
  expect(OPENING_CLEANUP_PAGE_OPTIONS).toEqual({ numItems: 50, maximumRowsRead: 100, maximumBytesRead: 512_000 });
});

test("the enlarged fixture trips the production page cap on the first page (SplitRequired)", async () => {
  const page = await productionPage(await seed(true), null);
  expect(page.pageStatus).toBe("SplitRequired");
});

test("the enlarged fixture trips the cap again on the page after a SplitRequired continuation", async () => {
  const fixture = await seed(true);
  const first = await productionPage(fixture, null);
  expect(first.pageStatus).toBe("SplitRequired");
  expect((await productionPage(fixture, first.continueCursor)).pageStatus).toBe("SplitRequired");
});

test("every 50-row window of the enlarged fixture exceeds the byte cap, wherever the scan cursor sits", async () => {
  const { t, orgId } = await seed(true);
  const sizes = await t.run(async ctx => (await ctx.db.query("openingBalanceDrafts").withIndex("by_org", q => q.eq("orgId", orgId)).collect())
    .map(draft => getDocumentSize(draft)));
  expect(sizes).toHaveLength(101);
  for (let start = 0; start + OPENING_CLEANUP_PAGE_ROWS <= sizes.length; start += 1) {
    const window = sizes.slice(start, start + OPENING_CLEANUP_PAGE_ROWS).reduce((sum, size) => sum + size, 0);
    expect(window, `window starting at row ${start}`).toBeGreaterThan(OPENING_CLEANUP_PAGE_BYTES);
  }
});

test("the enlarged fixture stays near the byte budget instead of the old 32 KiB per row (I/O cost bound)", async () => {
  const { t, orgId } = await seed(true);
  const sizes = await t.run(async ctx => (await ctx.db.query("openingBalanceDrafts").withIndex("by_org", q => q.eq("orgId", orgId)).collect())
    .map(draft => getDocumentSize(draft)));
  expect(Math.min(...sizes)).toBeGreaterThan(BYTES_PER_ROW);
  expect(Math.max(...sizes)).toBeLessThan(MAX_FIXTURE_BYTES_PER_ROW);
});

test("control: the non-enlarged fixture completes a production page without SplitRequired", async () => {
  const page = await productionPage(await seed(false), null);
  expect(page.pageStatus ?? null).toBeNull();
  expect(page.page).toHaveLength(OPENING_CLEANUP_PAGE_ROWS);
});
