/**
 * Phase 10 tests — true two-person manual-journal approval.
 *
 * Replaces the old single-shot postManualJournal (which trusted a
 * poster-supplied reviewedBy) with a create -> approve/reject workflow
 * where the reviewer authenticates and acts themselves.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedAuditDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase10 Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p10_user", email: "p10@example.com", name: "Poster" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:sales", "manage:finance", "view:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  // Second finance-authorized user, eligible to review/approve manual journals.
  const reviewerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p10_reviewer", email: "p10reviewer@example.com", name: "Reviewer" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: reviewerId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );
  const asUser = t.withIdentity({ subject: "p10_user", clerkId: "p10_user" });
  const asReviewer = t.withIdentity({ subject: "p10_reviewer", clerkId: "p10_reviewer" });

  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const accounts = await asUser.query(api.chartOfAccounts.list, { orgId });
  const manualAccounts = accounts.filter((a) => a.allowManualPosting);

  return { t, orgId, userId, reviewerId, period, asUser, asReviewer, manualAccounts };
}

describe("Phase 10 — manual journal draft creation", () => {
  test("balanced draft is created in PENDING_APPROVAL", async () => {
    const { orgId, manualAccounts, asUser } = await seedAuditDealer();
    expect(manualAccounts.length).toBeGreaterThanOrEqual(2);

    const result = await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "Year-end adjustment",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 5000, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 5000 },
      ],
      idempotencyKey: "p10_mj_001",
    });

    expect(result.alreadyCreated).toBe(false);
    expect(result.draftId).toBeTruthy();
  });

  test("unbalanced draft is rejected", async () => {
    const { orgId, manualAccounts, asUser } = await seedAuditDealer();

    await expect(
      asUser.mutation(api.financialAudit.createManualJournal, {
        orgId,
        memo: "Bad journal",
        lines: [
          { accountId: manualAccounts[0]._id, debitMinor: 5000, creditMinor: 0 },
          { accountId: manualAccounts[0]._id, debitMinor: 0, creditMinor: 3000 },
        ],
        idempotencyKey: "p10_mj_bad_001",
      })
    ).rejects.toThrow(/unbalanced/i);
  });

  test("draft creation is idempotent", async () => {
    const { orgId, manualAccounts, asUser } = await seedAuditDealer();

    const first = await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "Idempotent adjustment",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 2000, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 2000 },
      ],
      idempotencyKey: "p10_mj_idem_001",
    });

    const second = await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "Idempotent adjustment",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 2000, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 2000 },
      ],
      idempotencyKey: "p10_mj_idem_001",
    });

    expect(second.alreadyCreated).toBe(true);
    expect(second.draftId).toBe(first.draftId);
  });

  test("reusing an idempotency key with different content is rejected", async () => {
    const { orgId, manualAccounts, asUser } = await seedAuditDealer();

    await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "First version",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 1000, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 1000 },
      ],
      idempotencyKey: "p10_mj_reuse_001",
    });

    await expect(
      asUser.mutation(api.financialAudit.createManualJournal, {
        orgId,
        memo: "Different content, same key",
        lines: [
          { accountId: manualAccounts[0]._id, debitMinor: 4000, creditMinor: 0 },
          { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 4000 },
        ],
        idempotencyKey: "p10_mj_reuse_001",
      })
    ).rejects.toThrow(/different journal content/i);
  });
});

describe("Phase 10 — manual journal approval", () => {
  test("a second finance-authorized user can approve, posting exactly one balanced journal", async () => {
    const { orgId, manualAccounts, asUser, asReviewer } = await seedAuditDealer();

    const { draftId } = await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "Approved adjustment",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 3000, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 3000 },
      ],
      idempotencyKey: "p10_mj_approve_001",
    });

    const result = await asReviewer.mutation(api.financialAudit.approveManualJournal, { orgId, draftId });
    expect(result.resourceId).toBeTruthy();

    const logs = await asReviewer.query(api.financialAudit.listAuditLog, {
      orgId, actionType: "POST_MANUAL_JOURNAL",
    });
    expect(logs.some((l) => l.resourceId === result.resourceId)).toBe(true);
  });

  test("the poster cannot approve their own draft", async () => {
    const { orgId, manualAccounts, asUser } = await seedAuditDealer();

    const { draftId } = await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "Self-approval attempt",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 1000, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 1000 },
      ],
      idempotencyKey: "p10_mj_selfapprove_001",
    });

    await expect(
      asUser.mutation(api.financialAudit.approveManualJournal, { orgId, draftId })
    ).rejects.toThrow(/reviewer cannot be the same/i);
  });

  test("approving the same draft twice fails the second time", async () => {
    const { orgId, manualAccounts, asUser, asReviewer } = await seedAuditDealer();

    const { draftId } = await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "Double-approve attempt",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 1500, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 1500 },
      ],
      idempotencyKey: "p10_mj_dblapprove_001",
    });

    await asReviewer.mutation(api.financialAudit.approveManualJournal, { orgId, draftId });

    await expect(
      asReviewer.mutation(api.financialAudit.approveManualJournal, { orgId, draftId })
    ).rejects.toThrow(/already been resolved/i);
  });
});

describe("Phase 10 — manual journal rejection", () => {
  test("rejecting a draft requires a reason and posts nothing", async () => {
    const { orgId, manualAccounts, asUser, asReviewer } = await seedAuditDealer();

    const { draftId } = await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "Reject me",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 2500, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 2500 },
      ],
      idempotencyKey: "p10_mj_reject_001",
    });

    await expect(
      asReviewer.mutation(api.financialAudit.rejectManualJournal, { orgId, draftId, rejectionReason: "" })
    ).rejects.toThrow(/reason is required/i);

    await asReviewer.mutation(api.financialAudit.rejectManualJournal, {
      orgId, draftId, rejectionReason: "Missing supporting documentation.",
    });

    const pending = await asReviewer.query(api.financialAudit.listPendingManualJournals, { orgId });
    expect(pending.find((d) => d._id === draftId)).toBeUndefined();

    await expect(
      asReviewer.mutation(api.financialAudit.approveManualJournal, { orgId, draftId })
    ).rejects.toThrow(/already been resolved/i);
  });

  test("the poster cannot reject their own draft", async () => {
    const { orgId, manualAccounts, asUser } = await seedAuditDealer();

    const { draftId } = await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "Self-reject attempt",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 1000, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 1000 },
      ],
      idempotencyKey: "p10_mj_selfreject_001",
    });

    await expect(
      asUser.mutation(api.financialAudit.rejectManualJournal, {
        orgId, draftId, rejectionReason: "Trying to self-reject.",
      })
    ).rejects.toThrow(/reviewer cannot be the same/i);
  });
});

describe("Phase 10 — pending manual journal queue", () => {
  test("listPendingManualJournals only returns PENDING_APPROVAL drafts for this org", async () => {
    const { orgId, manualAccounts, asUser, asReviewer } = await seedAuditDealer();

    const { draftId: approvedDraftId } = await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "Will be approved",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 1000, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 1000 },
      ],
      idempotencyKey: "p10_mj_queue_approved",
    });
    await asReviewer.mutation(api.financialAudit.approveManualJournal, { orgId, draftId: approvedDraftId });

    const { draftId: pendingDraftId } = await asUser.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "Still pending",
      lines: [
        { accountId: manualAccounts[0]._id, debitMinor: 1200, creditMinor: 0 },
        { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 1200 },
      ],
      idempotencyKey: "p10_mj_queue_pending",
    });

    const pending = await asReviewer.query(api.financialAudit.listPendingManualJournals, { orgId });
    expect(pending.some((d) => d._id === pendingDraftId)).toBe(true);
    expect(pending.some((d) => d._id === approvedDraftId)).toBe(false);
    expect(pending.find((d) => d._id === pendingDraftId)?.creatorName).toBeTruthy();
  });
});
