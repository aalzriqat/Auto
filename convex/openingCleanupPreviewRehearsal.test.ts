import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { makeFunctionReference } from "convex/server";
import { runCleanupRehearsalCases } from "../scripts/accountingCleanupRehearsal.mjs";
import { recordCase, unproven } from "../scripts/accountingPreviewRehearsal.mjs";

const CLOUD = "https://cleanup-preview.convex.cloud";
const PRIMARY = { clerkUserId: "cleanup-primary", email: "primary@cleanup.example.test", name: "Primary QA" };
const APPROVER = { clerkUserId: "cleanup-approver", email: "approver@cleanup.example.test", name: "Approver QA" };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function setup() {
  vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "preview");
  vi.stubEnv("CONVEX_CLOUD_URL", CLOUD);
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  registerRateLimiter(t);
  await t.mutation(internal.e2eBootstrap.markPreviewDeployment, {});
  const baseline = await t.mutation(internal.e2eBootstrap.bootstrapE2EOrganization, { primary: PRIMARY, approver: APPROVER, expectedCloudUrl: CLOUD });
  const primary = t.withIdentity({ subject: PRIMARY.clerkUserId });
  const approver = t.withIdentity({ subject: APPROVER.clerkUserId });
  return { t, baseline, primary, approver };
}

async function prepareScope() {
  const fixture = await setup();
  const orgId = await fixture.primary.mutation(api.organizations.create, { name: "QA TEST cleanup guard" });
  const roles = await fixture.primary.query(api.roles.list, { orgId });
  const role = roles.find(row => row.name === "SENIOR_ACCOUNTANT");
  if (!role) throw new Error("Missing native finance role");
  await fixture.primary.mutation(api.memberships.add, { orgId, userEmail: APPROVER.email, roleId: role._id });
  return { ...fixture, args: { orgId, knownOrgIds: [fixture.baseline.orgId, orgId], primaryClerkUserId: PRIMARY.clerkUserId,
    approverClerkUserId: APPROVER.clerkUserId, expectedCloudUrl: CLOUD, stage: "SEED_HISTORY" as const, large: false } };
}

test("cleanup fixture preparation refuses a deployment without its preview marker before writes", async () => {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "preview");
  vi.stubEnv("CONVEX_CLOUD_URL", "https://cleanup-preview.convex.cloud");
  const orgId = await t.run(ctx => ctx.db.insert("organizations", { name: "QA TEST cleanup HISTORY", createdAt: 1 }));
  await expect(t.mutation(internal.e2eBootstrap.prepareOpeningCleanupFixture, {
    orgId, knownOrgIds: [orgId], primaryClerkUserId: "qa-primary", approverClerkUserId: "qa-approver",
    expectedCloudUrl: "https://cleanup-preview.convex.cloud", stage: "SEED_HISTORY", large: false,
  })).rejects.toThrow(/preview bootstrap marker/);
  expect(await t.run(ctx => ctx.db.query("openingBalanceDrafts").collect())).toEqual([]);
});

test.each(["class", "provider", "url", "baseline", "membership", "actor", "role", "reuse"] as const)(
  "preview cleanup fixture refuses unsafe scope before writes: %s", async defect => {
    const { t, primary, args, baseline } = await prepareScope();
    if (defect === "class") vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "production");
    if (defect === "provider") vi.stubEnv("RESEND_API_KEY", "configured-real-provider");
    if (defect === "url") args.expectedCloudUrl = "https://another-preview.convex.cloud";
    if (defect === "baseline") args.orgId = baseline.orgId;
    if (defect === "actor") args.primaryClerkUserId = APPROVER.clerkUserId;
    if (defect === "membership") await primary.mutation(api.organizations.create, { name: "Unenumerated QA organization" });
    if (defect === "role") await t.run(async ctx => {
      const seats = await ctx.db.query("memberships").withIndex("by_org", q => q.eq("orgId", args.orgId)).collect();
      const seat = seats.find(row => row.userId !== baseline.primary.userId);
      if (!seat) throw new Error("Missing finance seat");
      const owner = seats.find(row => row.userId === baseline.primary.userId);
      if (!owner) throw new Error("Missing owner seat");
      await ctx.db.patch(seat._id, { roleId: owner.roleId });
    });
    if (defect === "reuse") await t.mutation(internal.e2eBootstrap.prepareOpeningCleanupFixture, args);
    const before = await t.run(ctx => ctx.db.query("openingBalanceDrafts").collect());
    await expect(t.mutation(internal.e2eBootstrap.prepareOpeningCleanupFixture, args)).rejects.toThrow();
    expect(await t.run(ctx => ctx.db.query("openingBalanceDrafts").collect())).toEqual(before);
  },
);

test("cleanup historical reset refuses missing native opening proof without starting a generation", async () => {
  const { t, args } = await prepareScope();
  await t.mutation(internal.e2eBootstrap.prepareOpeningCleanupFixture, args);
  const before = await t.run(ctx => ctx.db.get(args.orgId));
  await expect(t.mutation(internal.e2eBootstrap.prepareOpeningCleanupFixture, { ...args, stage: "BEGIN_RESET" })).rejects.toThrow(/late authentic opening/);
  expect(await t.run(ctx => ctx.db.get(args.orgId))).toEqual(before);
});

test("cleanup observation refuses a foreign deletion request before returning evidence", async () => {
  const { t, args, baseline } = await prepareScope();
  const requestId = await t.run(ctx => ctx.db.insert("organizationDeletionRequests", { orgId: baseline.orgId,
    orgName: "QA TEST cleanup foreign", requestedBy: baseline.primary.userId, requestedAt: 1, status: "RUNNING" }));
  const { stage: _stage, large: _large, ...scopeArgs } = args;
  await expect(t.query(internal.e2eBootstrap.observeOpeningCleanupFixture, { ...scopeArgs, deletionRequestId: requestId })).rejects.toThrow();
});

async function executeCallbacks(defect?: "phase" | "state" | "inventory" | "generation") {
  const { t, baseline, primary, approver } = await setup();
  const sdk = (actor: typeof primary) => async (kind: "query" | "mutation", name: string, args: Record<string, unknown>) =>
    kind === "query" ? await actor.query(makeFunctionReference<"query">(name), args)
      : await actor.mutation(makeFunctionReference<"mutation">(name), args);
  const results: { id: string; status: string; detail: unknown }[] = [];
  const errors = vi.spyOn(console, "error");
  let capRefused = false;
  const previewCall = async (name: string, args: Record<string, unknown>, phase?: "DISCOVERY" | "REFERENCE") => {
    if (name === "e2eBootstrap:prepareOpeningCleanupFixture") return { ok: true, value: await t.mutation(makeFunctionReference<"mutation">(name), args) };
    if (name === "e2eBootstrap:observeOpeningCleanupFixture") {
      if (args.deletionRequestId) {
        // Advance the due zero-delay worker chain, without draining far-future component GC timers.
        await vi.advanceTimersByTimeAsync(1);
        await t.finishInProgressScheduledFunctions();
      }
      const value = await t.query(makeFunctionReference<"query">(name), args);
      if (defect === "state" && capRefused && value.commissions[0]) value.commissions[0].paidMinor += 1;
      if (defect === "generation" && value.org?.resetGeneration === 1 && value.org.completedGeneration === 1) {
        delete value.org.resetGeneration;
        delete value.org.completedGeneration;
      }
      return { ok: true, value };
    }
    if (name === "adminOrgs:runDeletionRequestBatch") return { ok: true, value: await t.mutation(makeFunctionReference<"mutation">(name), args) };
    if (name !== "orgFinancialReset:resetOrgFinancialData") throw new Error("Unsupported native test call");
    const beforeErrors = errors.mock.calls.length;
    try {
      return { ok: true, value: await t.mutation(makeFunctionReference<"mutation">(name), args) };
    } catch (error) {
      const markers = errors.mock.calls.slice(beforeErrors).flat().filter(value => value === `OPENING_CLEANUP_SPLIT_REQUIRED_${phase}`);
      if (phase && markers.length === 1 && String(error).includes("Opening cleanup could not be verified")) {
        capRefused = true;
        return { ok: false, refusal: "OPENING_CLEANUP_SPLIT_REQUIRED", phase: defect === "phase" ? (phase === "DISCOVERY" ? "REFERENCE" : "DISCOVERY") : phase, exitCode: 1 };
      }
      throw error;
    }
  };
  if (defect === "inventory") await primary.mutation(api.organizations.create, { name: "Unexpected unrecorded QA membership" });
  await runCleanupRehearsalCases({ orgId: baseline.orgId, results, config: { convexUrl: CLOUD },
    createdRehearsalOrgIds: [], qaIdentities: { primaryClerkUserId: PRIMARY.clerkUserId, approverClerkUserId: APPROVER.clerkUserId },
    salesMust: sdk(primary), approverMust: sdk(approver), previewCall, recordCase, unproven });
  return results;
}

test("cleanup cloud callbacks execute real fixture, reset and scheduled worker handlers", async () => {
  const results = await executeCallbacks();
  expect(results, JSON.stringify(results)).toEqual([
    expect.objectContaining({ id: "S858-CLEANUP-HISTORY", status: "PASS" }),
    expect.objectContaining({ id: "S858-CLEANUP-SPLIT", status: "PASS" }),
  ]);
});

test.each(["phase", "state", "generation"] as const)("cleanup cloud assertions reject corrupted SDK %s evidence", async defect => {
  // Corrupt only SDK-returned evidence. Real handlers and database effects remain unchanged.
  const results = await executeCallbacks(defect);
  expect(results[0], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-HISTORY", status: defect === "generation" ? "FAIL" : "PASS" });
  const splitStatus = defect === "generation" ? "PASS" : defect === "phase" ? "UNPROVEN" : "FAIL";
  expect(results[1], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-SPLIT", status: splitStatus });
});

test("cleanup driver refuses a current membership absent from trusted successful create receipts", async () => {
  await expect(executeCallbacks("inventory")).rejects.toThrow(/Unexpected QA membership outside the trusted public-create inventory/);
});
