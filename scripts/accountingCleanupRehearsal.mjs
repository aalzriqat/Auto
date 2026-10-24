/** Finite cleanup cases. Historical admission is synthetic; all money originates publicly. */
const PREPARE = "e2eBootstrap:prepareOpeningCleanupFixture";
const OBSERVE = "e2eBootstrap:observeOpeningCleanupFixture";
const RESET = "orgFinancialReset:resetOrgFinancialData";
const WORKER = "adminOrgs:runDeletionRequestBatch";
const MAX_ATTEMPTS = 256;

function demand(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value) {
  demand(value !== null && typeof value === "object" && !Array.isArray(value), "Cleanup evidence object is unavailable");
  return value;
}
function array(value) {
  demand(Array.isArray(value), "Cleanup evidence array is unavailable");
  return value;
}
function id(value) {
  demand(typeof value === "string" && value.length > 0, "Cleanup identity is unavailable");
  return value;
}
async function previewMust(ctx, name, args) {
  const receipt = await ctx.previewCall(name, args);
  demand(receipt.ok === true, "Cleanup preview operation did not succeed");
  return receipt.value;
}
function scope(ctx, knownOrgIds, orgId, deletionRequestId) {
  return { orgId, knownOrgIds: [...knownOrgIds], ...ctx.qaIdentities,
    expectedCloudUrl: ctx.config.convexUrl, ...(deletionRequestId ? { deletionRequestId } : {}) };
}
async function observe(ctx, fixture) {
  return object(await previewMust(ctx, OBSERVE, fixture.scope));
}
function sourceIds(state) {
  return [...array(state.commissions), ...array(state.recoveries)].map(row => id(object(row).id));
}
function sourceReferenced(state, sourceId) {
  return array(state.drafts).some(draft => array(object(draft).results).some(result =>
    Object.values(object(result)).includes(sourceId)));
}
function verifyRemoval(before, after) {
  for (const sourceId of sourceIds(before)) {
    if (!sourceIds(after).includes(sourceId)) {
      demand(!sourceReferenced(after, sourceId), "Cleanup deleted a source before clearing its retained references");
      demand(after.org?.referenceScan?.source?.id !== sourceId, "Cleanup retained a checkpoint to a deleted source");
    }
  }
}

async function prepareNativeOpening(ctx, knownOrgIds, label, large = false) {
  const must = ctx.salesMust;
  const primary = object(await must("query", "users:getMe", {}));
  const approver = object(await ctx.approverMust("query", "users:getMe", {}));
  const orgId = id(await must("mutation", "organizations:create", { name: `QA TEST cleanup ${label}` }));
  knownOrgIds.add(orgId);
  const roles = array(await must("query", "roles:list", { orgId }));
  const finance = roles.find(role => object(role).name === "SENIOR_ACCOUNTANT");
  demand(finance, "Cleanup finance seat is unavailable");
  await must("mutation", "memberships:add", { orgId, userEmail: id(approver.email), roleId: id(finance._id) });
  await must("mutation", "orgSettings:upsert", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
  await must("mutation", "chartOfAccounts:initialize", { orgId });
  const year = new Date().getUTCFullYear();
  await must("mutation", "accountingPeriods:create", { orgId, fiscalYear: year, periodNumber: 1,
    startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), openImmediately: true });
  const accounts = array(await must("query", "chartOfAccounts:list", { orgId }));
  const retained = accounts.find(account => object(account).systemKey === "RETAINED_EARNINGS");
  demand(retained, "Cleanup balancing account is unavailable");
  const asset = id(await must("mutation", "chartOfAccounts:create", { orgId, code: "1998", name: "Cleanup opening claim",
    type: "ASSET", normalBalance: "DEBIT", currencyRestriction: "JOD", isControlAccount: true, allowManualPosting: false }));
  const liability = id(await must("mutation", "chartOfAccounts:create", { orgId, code: "2998", name: "Cleanup opening commission",
    type: "LIABILITY", normalBalance: "CREDIT", currencyRestriction: "JOD", isControlAccount: true, allowManualPosting: false }));
  const fixture = { scope: scope(ctx, knownOrgIds, orgId), orgId };
  await previewMust(ctx, PREPARE, { ...fixture.scope, stage: "SEED_HISTORY", large });
  await must("mutation", "accountingCutover:postOpeningBalanceDirect", { orgId, expectedCurrency: "JOD", asOfDate: Date.now(),
    lines: [{ accountId: asset, debitMinor: 100000, creditMinor: 0 }, { accountId: liability, debitMinor: 0, creditMinor: 50000 },
      { accountId: id(retained._id), debitMinor: 0, creditMinor: 50000 }],
    allocations: [{ kind: "SUPPLIER_RECOVERABLE", rowKey: "claim", accountId: asset, amountMinor: 100000,
      counterpartyName: "Synthetic cleanup supplier", title: "Cleanup claim", purpose: "CLAIM" },
    { kind: "EMPLOYEE_COMMISSION", rowKey: "commission", accountId: liability, amountMinor: 50000, userId: id(approver._id) }] });
  const readback = object(await must("query", "accountingCutover:postedOpeningAllocationReadback", { orgId }));
  demand(array(readback.rows).length === 2 && readback.rows.every(row => object(row).recordAvailable === true), "Cleanup opening is not natively available");
  demand(id(primary._id) !== id(approver._id), "Cleanup identities are not distinct");
  return fixture;
}

async function resetHistory(ctx, fixture) {
  await previewMust(ctx, PREPARE, { ...fixture.scope, stage: "BEGIN_RESET" });
  let before = await observe(ctx, fixture);
  demand(array(before.drafts).length === 102 && sourceIds(before).length === 2, "Cleanup history fixture is incomplete");
  demand(before.drafts[0].status === "REJECTED" && array(before.drafts[0].results).length === 2, "Rejected-header source references were not exercised");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const result = object(await previewMust(ctx, RESET, { orgId: fixture.orgId, dryRun: false, batchSize: 1 }));
    const after = await observe(ctx, fixture);
    verifyRemoval(before, after);
    if (result.remaining === 0) {
      demand(sourceIds(after).length === 0 && array(after.drafts).length === 102, "Reset source cleanup or retained history is incomplete");
      demand(after.drafts.every(draft => array(object(draft).results).length === 0), "Reset left opening source references in retained history");
      demand(after.org !== null && Number.isSafeInteger(after.org.resetGeneration) && after.org.resetGeneration >= 1 &&
        Number.isSafeInteger(after.org.completedGeneration) && after.org.completedGeneration >= 1 &&
        after.org.resetGeneration === after.org.completedGeneration, "Reset completion generation is missing");
      return { invocations: attempt + 1, sourcesRemoved: 2, retainedHeaders: 102 };
    }
    before = after;
  }
  throw new Error("Cleanup reset exceeded its finite invocation budget");
}

async function deletionHistory(ctx, fixture) {
  const prepared = object(await previewMust(ctx, PREPARE, { ...fixture.scope, stage: "BEGIN_DELETION" }));
  fixture.scope.deletionRequestId = id(prepared.requestId);
  const before = await observe(ctx, fixture);
  await previewMust(ctx, WORKER, { requestId: fixture.scope.deletionRequestId });
  // Kick off once. The real worker schedules its successors; do not create parallel chains.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const after = await observe(ctx, fixture);
    verifyRemoval(before, after);
    demand(after.request?.status !== "FAILED", "Cleanup deletion worker failed");
    if (after.request?.status === "COMPLETED") {
      demand(after.org === null && sourceIds(after).length === 0 && array(after.drafts).length === 0, "Deletion completed with opening sources remaining");
      return { observations: attempt + 1, admission: "SYNTHETIC_HISTORICAL_RUNNING_REQUEST", workerKickoffs: 1 };
    }
  }
  throw new Error("Cleanup deletion exceeded its finite observation budget");
}

async function splitRefusal(ctx, fixture, phase) {
  await previewMust(ctx, PREPARE, { ...fixture.scope, stage: "BEGIN_RESET" });
  if (phase === "REFERENCE") {
    let ready = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await previewMust(ctx, RESET, { orgId: fixture.orgId, dryRun: false, batchSize: 1 });
      const state = await observe(ctx, fixture);
      if (state.org?.referenceScan && !state.org.referenceScan.complete && state.org.payableScan?.complete === true) { ready = true; break; }
    }
    demand(ready, "Cleanup reference checkpoint was not reached");
    await previewMust(ctx, PREPARE, { ...fixture.scope, stage: "ENLARGE_REFERENCE" });
  }
  const before = await observe(ctx, fixture);
  const receipt = await ctx.previewCall(RESET, { orgId: fixture.orgId, dryRun: false, batchSize: 1 }, phase);
  if (receipt.ok !== false || receipt.refusal !== "OPENING_CLEANUP_SPLIT_REQUIRED" || receipt.phase !== phase) {
    ctx.unproven(`Real ${phase} cap guard was not observed; volume alone is not evidence`);
  }
  const after = await observe(ctx, fixture);
  demand(JSON.stringify(after) === JSON.stringify(before), "SplitRequired refusal changed checkpoint, references or source");
  return { phase, measured: "SAME_INVOCATION_CAP_GUARD_MARKER", stateUnchanged: true };
}

/** Runs after the original31/P1. No baseline seat preflight runs after fixture creation. */
export async function runCleanupRehearsalCases(ctx) {
  const original = [...array(await ctx.salesMust("query", "organizations:listMine", {})),
    ...array(await ctx.approverMust("query", "organizations:listMine", {}))];
  // Native successful create returns are captured by the trusted driver, before this inventory read.
  const knownOrgIds = new Set([id(ctx.orgId), ...array(ctx.createdRehearsalOrgIds).map(id)]);
  demand(original.every(org => knownOrgIds.has(id(object(org)._id))), "Unexpected QA membership outside the trusted public-create inventory");
  await ctx.recordCase(ctx.results, "S858-CLEANUP-HISTORY", "Native cleanup of 102 retained headers; historical admission is synthetic", async () => {
    const started = Date.now();
    const reset = await resetHistory(ctx, await prepareNativeOpening(ctx, knownOrgIds, "HISTORY-RESET"));
    const deletion = await deletionHistory(ctx, await prepareNativeOpening(ctx, knownOrgIds, "HISTORY-DELETION"));
    return { reset, deletion, elapsedMs: Date.now() - started, scope: "actual native functions; synthetic historical admission; no OCC claim" };
  });
  await ctx.recordCase(ctx.results, "S858-CLEANUP-SPLIT", "Actual discovery and reference cap guard receipts preserve cleanup state", async () => {
    const started = Date.now();
    const discovery = await splitRefusal(ctx, await prepareNativeOpening(ctx, knownOrgIds, "SPLIT-DISCOVERY", true), "DISCOVERY");
    const reference = await splitRefusal(ctx, await prepareNativeOpening(ctx, knownOrgIds, "SPLIT-REFERENCE"), "REFERENCE");
    return { discovery, reference, elapsedMs: Date.now() - started, rawPageStatusObserved: false };
  });
}
