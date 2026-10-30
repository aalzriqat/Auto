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

test("an earlier organization that seats the approver as MANAGER refuses the cleanup fixture (SCRUM-486 U-RET shape)", async () => {
  // Root cause of S858-CLEANUP-HISTORY failing in run 40521502331: U-RET seats the approver as MANAGER in the organization it
  // creates. That organization is in the caller's inventory, but the seat is not a shape the cleanup fixture allows (owner or
  // SENIOR_ACCOUNTANT), so the server refuses with UNEXPECTED_MEMBERSHIP. The cure is to run such cases after cleanup
  // (runRehearsalSequence), never to relax this server fence.
  const control = await prepareScope();
  await expect(control.t.mutation(internal.e2eBootstrap.prepareOpeningCleanupFixture, control.args)).resolves.toBeDefined();
  const { t, primary, args } = await prepareScope();
  const earlierOrg = await primary.mutation(api.organizations.create, { name: "QA TEST U-RET" });
  const manager = (await primary.query(api.roles.list, { orgId: earlierOrg })).find(row => row.name === "MANAGER");
  if (!manager) throw new Error("Missing native MANAGER role");
  await primary.mutation(api.memberships.add, { orgId: earlierOrg, userEmail: APPROVER.email, roleId: manager._id });
  const before = await t.run(ctx => ctx.db.query("openingBalanceDrafts").collect());
  await expect(t.mutation(internal.e2eBootstrap.prepareOpeningCleanupFixture, { ...args, knownOrgIds: [...args.knownOrgIds, earlierOrg] }))
    .rejects.toThrow(/unexpected cleanup QA membership/);
  expect(await t.run(ctx => ctx.db.query("openingBalanceDrafts").collect())).toEqual(before);
});
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

let listPrimaryOrgNames: () => Promise<string[]> = async () => [];

async function executeCallbacks(defect?: "phase" | "state" | "inventory" | "generation" | "deletion-throws", priorOrgs = 0, rehearsalEvent?: string) {
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
    if (name === "adminOrgs:runDeletionRequestBatch" && defect === "deletion-throws") throw new Error("Synthetic deletion worker failure");
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
  listPrimaryOrgNames = async () => (await primary.query(api.organizations.listMine, {})).flatMap(org => (org ? [org.name] : []));
  // Earlier rehearsal cases leave their organizations behind; the 12-organization fixture bound counts them.
  const createdRehearsalOrgIds: string[] = [];
  for (let index = 0; index < priorOrgs; index += 1)
    createdRehearsalOrgIds.push(await primary.mutation(api.organizations.create, { name: `Prior rehearsal org ${index}` }));
  await runCleanupRehearsalCases({ orgId: baseline.orgId, results, config: { convexUrl: CLOUD }, rehearsalEvent,
    createdRehearsalOrgIds, qaIdentities: { primaryClerkUserId: PRIMARY.clerkUserId, approverClerkUserId: APPROVER.clerkUserId },
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

test.each(["repository_dispatch", "workflow_run"])("SCRUM-883 %s runs reference cleanup and truthfully records large discovery coverage", async rehearsalEvent => {
  const results = await executeCallbacks(undefined, 0, rehearsalEvent);
  expect(results.map(result => result.status)).toEqual(["PASS", "PASS"]);
  const names = await listPrimaryOrgNames();
  expect(names).toContain("QA TEST cleanup SPLIT-REFERENCE");
  if (rehearsalEvent === "workflow_run") {
    expect(names).not.toContain("QA TEST cleanup SPLIT-DISCOVERY");
    expect(results[1]?.detail).toMatchObject({ discovery: {
      status: "NOT_RUN", reason: "Large retained-history fixture runs only at release; PR rehearsal excludes it (SCRUM-883).",
    }, reference: { phase: "REFERENCE", stateUnchanged: true } });
  } else {
    expect(names).toContain("QA TEST cleanup SPLIT-DISCOVERY");
    expect(results[1]?.detail).toMatchObject({ discovery: { phase: "DISCOVERY", stateUnchanged: true } });
  }
});

test("cleanup cases stay inside the 12-organization fixture bound after eight earlier rehearsal organizations", async () => {
  // Production rehearsal shape: 8 prior orgs + baseline + 4 cleanup fixtures would be 13 without releasing the deleted one.
  const results = await executeCallbacks(undefined, 8);
  expect(results, JSON.stringify(results)).toEqual([
    expect.objectContaining({ id: "S858-CLEANUP-HISTORY", status: "PASS" }),
    expect.objectContaining({ id: "S858-CLEANUP-SPLIT", status: "PASS" }),
  ]);
});

test("with nine earlier organizations the driver refuses before creating the fixture that would exceed the bound", async () => {
  const results = await executeCallbacks(undefined, 9);
  expect(results[0], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-HISTORY", status: "PASS" });
  expect(results[1], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-SPLIT", status: "FAIL", detail: expect.stringMatching(/12-organization/) });
  // Only the refused SPLIT-REFERENCE fixture is proven absent: it was never created, so the server bound was not crossed.
  expect(await listPrimaryOrgNames()).not.toContain("QA TEST cleanup SPLIT-REFERENCE");
});

test("ten earlier organizations (the usual eight plus the two U-RET creates) leave no room: both cleanup cases refuse at the bound", async () => {
  // SCRUM-486: this is the arithmetic behind the 12-organization failure in run 40521502331. U-RET therefore runs after cleanup.
  const results = await executeCallbacks(undefined, 10);
  expect(results[0], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-HISTORY", status: "FAIL", detail: expect.stringMatching(/12-organization/) });
  expect(results[1], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-SPLIT", status: "FAIL", detail: expect.stringMatching(/12-organization/) });
});

test("a HISTORY case that fails after its deletion fixture exists keeps that slot, and SPLIT stops at the bound", async () => {
  // 8 prior + baseline + RESET + DELETION = 11 known (the failed deletion is not released); DISCOVERY reaches 12; REFERENCE would be 13.
  const results = await executeCallbacks("deletion-throws", 8);
  expect(results[0], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-HISTORY", status: "FAIL" });
  expect(results[1], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-SPLIT", status: "FAIL", detail: expect.stringMatching(/12-organization/) });
  const names = await listPrimaryOrgNames();
  expect(names).toContain("QA TEST cleanup HISTORY-DELETION");
  expect(names).not.toContain("QA TEST cleanup SPLIT-REFERENCE");
});

test("a failing HISTORY case does not stop SPLIT from running inside the bound", async () => {
  const results = await executeCallbacks("generation", 8);
  expect(results[0], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-HISTORY", status: "FAIL" });
  expect(results[1], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-SPLIT", status: "PASS" });
});

test("a deletion that throws keeps its organization in the inventory so later fixtures still pass the server scope", async () => {
  // Releasing before success would drop a live QA membership from the known set, and the next fixture would be refused.
  const results = await executeCallbacks("deletion-throws");
  expect(results[0], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-HISTORY", status: "FAIL" });
  expect(results[1], JSON.stringify(results)).toMatchObject({ id: "S858-CLEANUP-SPLIT", status: "PASS" });
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
