/**
 * SCRUM-563 R5 / R6.11 — ratchets and pins around the organization purge and
 * financial reset. NO production behaviour is changed by anything pinned here.
 *
 * (a) ORGANIZATION_DELETION_STEPS ORDER RATCHET. `hardDeleteOrg` walks the list
 *     with a numeric cursor (`currentStepIndex`). Reordering the list shifts what
 *     each stored index means, so an in-flight purge resuming after a deploy
 *     silently SKIPS steps. The order is therefore frozen here; a legitimate
 *     change must update this test AND handle in-flight purges.
 *
 * (b) OUTBOX DISPATCH vs ORG LIFECYCLE. `postOutboxRow` consults
 *     `orgEconomicLifecycleBlock` before the first financial write: a permanent
 *     block (destructive purge begun) dead-letters the row, a temporary block
 *     (suspended) holds it with no attempt consumed. Neither posts. There was no
 *     dispatcher-level test of this; the existing orgLifecycleEconomicGate
 *     tests cover the webhook and crons only.
 *
 * (c) SETTLED-INTENT PIN (SCRUM-565). A payment intent that is already SETTLED
 *     survives a financial reset (`paymentIntents` is not a reset table) while
 *     the ledger rows it produced are deleted. After reactivation a replayed
 *     provider webhook returns early and creates NOTHING. This pins current
 *     behaviour only; whether that is the right outcome is SCRUM-565.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ORGANIZATION_DELETION_STEPS } from "./adminOrgs";
import { enqueuePendingPost } from "./accountingOutbox";
import { settleOutbox, makeDue, heldRows, outboxRows } from "../test-utils/outboxWork";
import { resetOrgToCompletion } from "../test-utils/orgResetFixtures";
import { seedOrgWithMember } from "../test-utils/seedOrg";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

type Harness = ReturnType<typeof convexTestWithComponents>;

// ───────────────────────────────────────────────────────────────────────────
// (a) deletion manifest order ratchet
// ───────────────────────────────────────────────────────────────────────────

function orgRowsOrder(): string[] {
  return ORGANIZATION_DELETION_STEPS.flatMap((step) =>
    step.kind === "orgRows" ? [step.table as string] : []
  );
}

describe("SCRUM-563 R5(a) — ORGANIZATION_DELETION_STEPS order is frozen", () => {
  // The cursor is a numeric index into ORGANIZATION_DELETION_STEPS. If an entry
  // moves, is removed or is inserted mid-list, a purge that stored index N
  // resumes at a DIFFERENT step and the steps that moved across N are skipped
  // without error. The FULL current order is pinned (orgRows steps by table,
  // special steps by kind). Appending at the END is the only allowed change: it
  // shifts no existing index, so the pinned list must remain a prefix of the
  // live one. Anything else must update this test AND handle in-flight purges.
  const PINNED_ORDER: string[] = [
      "commandIdempotency",
      "chartOfAccounts",
      "accountingPeriods",
      "accountingEvents",
      "commitmentAuthorityAttempt",
      "commitmentAuthorityWork",
      "pendingAccountingEvents",
      "journalLines",
      "journalEntries",
      "receiptApplications",
      "receiptRetainedPositions",
      "receiptMovements",
      "paymentAllocations", "canonicalPayments", "receivableDocuments", "financialAuditLog",
      "vehicleLandedCosts", "vehicleSupplierPayables", "vehicleSupplierReceivables",
      "supplierCostRecoveryReceipts", "supplierCostRecoveries", "consignedSaleCorrections",
      "vehiclePriceHistory", "vehicleReservations", "vehicleStatusRequests",
      "vehicleEditsWithStorage", "vehiclesWithStorage",
      "leads", "sales", "expenses", "tasks", "taskHistory",
      "notifications", "notificationPreferences", "notificationBroadcasts",
      "test_drives", "workOrders", "financeCompanies", "vehicleValuations", "guarantors",
      "quotes", "applicationStatusLog",
      "financeAppraisalsWithStorage", "financeApplicationOverrides", "financeCompanyForwards",
      "financeDealCustodyEntries", "financeDealFeesWithStorage", "financeDealCustody",
      "financeApplications", "vehicleOwnershipConversionsWithStorage", "financeCompanyRuleVersions",
      "vehicleCommitmentClaims", "commitmentRoots", "depositApplications", "deposits", "depositRequests",
      "receivables", "collectionPayments", "postDatedCheques", "cashierReconciliations",
      "collectionApprovalRequests", "collectionReminders", "companyDocumentRules",
      "applicationDocumentsWithStorage", "branches", "transactions", "fixedAssets", "partnerEquity",
      "claims", "wizardDrafts", "orgSettingsWithStorage", "leadAssignmentCursors",
      "websiteSettings", "websiteDomains", "websitePublishedSections", "websiteLeadRouting",
      "websitePublishSnapshots", "siteVisitorEvents", "siteVisitors", "domainSearchLogs",
      "oauthStates", "instagramEvents", "facebookEvents", "socialContacts", "socialConversations",
      "socialMaterializationState", "facebookMessages", "socialPostsWithStorage",
      "orgCustomFields", "orgCustomFieldValues", "orgLeadSources", "orgValuationCompanies",
      "orgPipelineStages", "orgImportMappings", "orgCustomerStatuses", "profitApprovalRequests",
      "feedback", "customers", "supportOrgAccessGrants", "liveChatThreads", "dmConversations",
      "impersonationGrants", "paymentIntents", "subscriptions", "invitations", "memberships", "roles",
  ];

  test("the full current order is frozen; only appending at the end is allowed (a reorder skips steps for in-flight purges)", () => {
    const live = ORGANIZATION_DELETION_STEPS.map((s) => (s.kind === "orgRows" ? s.table : s.kind));
    expect(live.slice(0, PINNED_ORDER.length)).toEqual(PINNED_ORDER);
    expect(live.length).toBeGreaterThanOrEqual(PINNED_ORDER.length);
  });

  test("accountingEvents, pendingAccountingEvents, journalLines, journalEntries keep their relative order and indexes", () => {
    const order = orgRowsOrder();
    const at = (table: string) => order.indexOf(table);
    expect(at("commandIdempotency")).toBe(0);
    expect(at("accountingEvents")).toBe(3);
    expect(at("pendingAccountingEvents")).toBe(6);
    expect(at("journalLines")).toBe(7);
    expect(at("journalEntries")).toBe(8);
    // dependency order: authority rows before the outbox rows they reference,
    // lines before the entries they belong to.
    expect(at("commitmentAuthorityAttempt")).toBeLessThan(at("commitmentAuthorityWork"));
    expect(at("commitmentAuthorityWork")).toBeLessThan(at("pendingAccountingEvents"));
    expect(at("journalLines")).toBeLessThan(at("journalEntries"));
  });

  test("no table appears twice (a duplicate would make the cursor ambiguous)", () => {
    const order = orgRowsOrder();
    expect(new Set(order).size).toBe(order.length);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// shared dealer fixture
// ───────────────────────────────────────────────────────────────────────────

const FINANCE_PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:expenses", "create:expenses", "edit:expenses",
  "manage:finance", "view:finance",
  "view:customers", "create:customers",
  "view:vehicles", "create:vehicles", "edit:vehicles",
];

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const { orgId, userId, identity: asUser } = await seedOrgWithMember(t, {
    clerkId: `${tag}_user`,
    permissions: FINANCE_PERMS,
    orgName: `SCRUM563 ${tag}`,
    roleName: "Owner",
  });
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Customer" })
  );
  return { t, orgId, userId, asUser, customerId };
}

/** Per-org row counts of the ledger tables a posting would write. */
async function ledgerCounts(t: Harness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const count = async (table: "accountingEvents" | "journalEntries" | "journalLines") =>
      (await ctx.db.query(table).collect()).filter((r) => String(r.orgId) === String(orgId)).length;
    return {
      accountingEvents: await count("accountingEvents"),
      journalEntries: await count("journalEntries"),
      journalLines: await count("journalLines"),
    };
  });
}

/** Queue one POST row while the org is still active (enqueue refuses a blocked org). */
async function queueOne(d: Awaited<ReturnType<typeof seedDealer>>, key: string) {
  // Production enqueue helper with a MODERN source family (`expenses`), the
  // shape accountingSourceFamilyRetired.test.ts proves posts for an active org.
  // `expenses.create` posts inline and leaves no outbox row, so it cannot seed
  // a PENDING one. The CONTROL test below proves this row is genuinely postable.
  await d.t.run((ctx) =>
    enqueuePendingPost(
      ctx,
      {
        orgId: d.orgId,
        eventType: "EXPENSE_POSTED",
        sourceType: "expenses",
        sourceId: key,
        eventVersion: 1,
        accountingDate: Date.now(),
        occurredAt: Date.now(),
        currency: "JOD",
        idempotencyKey: key,
        payload: { expenseId: key, amountMinor: 100_000, currency: "JOD" },
        actorId: d.userId,
      },
      "seeded PENDING for the lifecycle dispatch test"
    )
  );
}

// ───────────────────────────────────────────────────────────────────────────
// (b) outbox dispatcher vs lifecycle
// ───────────────────────────────────────────────────────────────────────────

describe("SCRUM-563 R5(b) — outbox dispatch honours the org lifecycle before posting", () => {
  test("a PENDING row of an org that began destructive purge is dead-lettered and posts nothing", async () => {
    const d = await seedDealer("purge");
    await queueOne(d, "purge_row");
    expect(await outboxRows(d.t, d.orgId)).toHaveLength(1);
    const before = await ledgerCounts(d.t, d.orgId);

    await d.t.run((ctx) => ctx.db.patch(d.orgId, { suspended: true, destructivePurgeStartedAt: Date.now() }));

    // Each refusal burns an attempt and backs off; the row dead-letters at the
    // attempt budget (10). The row must never post in any round.
    for (let i = 0; i < 10; i += 1) {
      await settleOutbox(d.t, d.orgId);
      await makeDue(d.t, d.orgId);
    }

    const rows = await outboxRows(d.t, d.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("FAILED");
    expect(rows[0].attempts).toBe(10);
    expect(String(rows[0].lastError)).toContain("irreversible destructive deletion");
    expect(await ledgerCounts(d.t, d.orgId)).toEqual(before);
  });

  test("a PENDING row of a merely SUSPENDED org is held with no attempt consumed and posts nothing", async () => {
    const d = await seedDealer("susp");
    await queueOne(d, "susp_row");
    const before = await ledgerCounts(d.t, d.orgId);

    await d.t.run((ctx) => ctx.db.patch(d.orgId, { suspended: true, suspendedAt: Date.now() }));

    for (let i = 0; i < 3; i += 1) {
      await settleOutbox(d.t, d.orgId);
      await makeDue(d.t, d.orgId);
    }

    const held = await heldRows(d.t, d.orgId);
    expect(held).toHaveLength(1);
    expect(held[0].status).toBe("PENDING");
    expect(held[0].attempts).toBe(0);
    expect(String(held[0].lastError)).toContain("suspended");
    expect(await ledgerCounts(d.t, d.orgId)).toEqual(before);
  });

  test("CONTROL: the same row of an ACTIVE org posts", async () => {
    const d = await seedDealer("ctl");
    await queueOne(d, "ctl_row");
    const before = await ledgerCounts(d.t, d.orgId);

    await settleOutbox(d.t, d.orgId);

    const after = await ledgerCounts(d.t, d.orgId);
    expect(after.journalEntries).toBeGreaterThan(before.journalEntries);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c) SETTLED intent survives reset + reactivation (SCRUM-565 pin)
// ───────────────────────────────────────────────────────────────────────────

describe("SCRUM-563 R6.11 — a SETTLED payment intent after reset and reactivation creates nothing (pin; see SCRUM-565)", () => {
  test("settleByExternalId on the leftover SETTLED intent returns early with the ledger counts unchanged", async () => {
    const d = await seedDealer("pin");
    // SCRUM-571 S1: an intent needs a target document (refused otherwise).
    const receivableDocumentId = await d.asUser.mutation(internal.subledger.createReceivable, {
      orgId: d.orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId: d.customerId,
      sourceType: "test_intent",
      sourceId: "scrum563_pin_receivable",
      originalAmountMinor: 1_000_000,
      currency: "JOD",
      issueDate: Date.now(),
      dueDate: Date.now(),
    });
    // D-20: create/settle are shut, so the already-SETTLED intent the pilot left
    // behind is seeded directly. That leftover is exactly what this pin covers.
    const intentId = await d.t.run((ctx) =>
      ctx.db.insert("paymentIntents", {
        orgId: d.orgId,
        customerId: d.customerId,
        receivableDocumentId,
        amountMinor: 1_000_000,
        currency: "JOD",
        provider: "tap",
        externalId: "tap_pin",
        status: "SETTLED",
        idempotencyKey: crypto.randomUUID(),
        createdBy: d.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        settledAt: Date.now(),
      })
    );
    const settle = () =>
      d.t.mutation(internal.paymentIntents.settleByExternalId, {
        provider: "tap",
        externalId: "tap_pin",
        amountMinor: 1_000_000,
        currency: "JOD",
        providerSignatureVerifiedAt: Date.now(),
      });
    expect((await d.t.run((ctx) => ctx.db.get(intentId)))?.status).toBe("SETTLED");

    // Real reset: suspend, run to completion, reactivate (state flip only; the
    // admin reactivation guard is covered in orgResetGeneration.scrum563.test.ts).
    await d.t.run((ctx) => ctx.db.patch(d.orgId, { suspended: true, suspendedAt: Date.now() }));
    await resetOrgToCompletion(d.t, d.orgId);
    await d.t.run((ctx) => ctx.db.patch(d.orgId, { suspended: false }));

    // The intent survived the reset; the ledger rows it produced did not.
    expect((await d.t.run((ctx) => ctx.db.get(intentId)))?.status).toBe("SETTLED");
    const before = await ledgerCounts(d.t, d.orgId);
    expect(before).toEqual({ accountingEvents: 0, journalEntries: 0, journalLines: 0 });

    await settle();

    expect(await ledgerCounts(d.t, d.orgId)).toEqual(before);
    const canonical = await d.t.run(async (ctx) =>
      (await ctx.db.query("canonicalPayments").collect()).filter((r) => String(r.orgId) === String(d.orgId))
    );
    expect(canonical).toHaveLength(0);
  });
});
