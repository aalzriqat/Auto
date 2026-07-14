/**
 * Phase 41 tests — bank reconciliation.
 *
 * Covers: uploading statement lines, scored suggestion (exact amount + date
 * proximity, never auto-confirming), confirming a match, the double-claim
 * guard on confirmMatch, and unmatch/ignore.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedDealerWithBankAccount() {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase41 Recon Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p41r_owner", email: "p41rowner@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner", permissions: ["view:finance", "manage:finance"], isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );

  const asOwner = t.withIdentity({ subject: "p41r_owner", clerkId: "p41r_owner" });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });

  const bankAccountId = await asOwner.mutation(api.bankAccounts.create, {
    orgId, name: "Operating Account", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now() - 60 * 24 * 60 * 60 * 1000,
    isReconciliationTarget: true,
  });

  const bankChartAccount = await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "BANK_ACCOUNT"))
      .unique()
  );
  const retainedEarnings = await t.run((ctx) =>
    ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "RETAINED_EARNINGS"))
      .unique()
  );

  async function seedLedgerLine(amountMinor: number, accountingDate: number) {
    const now = Date.now();
    const journalId = await t.run((ctx) =>
      ctx.db.insert("journalEntries", {
        orgId, journalNumber: `TEST-${accountingDate}`, accountingDate, sourceType: "test", sourceId: `test-${accountingDate}`,
        category: "SYSTEM", memo: "Test ledger line", status: "POSTED", currency: "JOD",
        postedBy: userId, postedAt: now, createdAt: now,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("journalLines", {
        orgId, journalEntryId: journalId, lineNumber: 1, accountId: bankChartAccount!._id,
        debitMinor: amountMinor, creditMinor: 0, currency: "JOD", scale: 3, accountingDate,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("journalLines", {
        orgId, journalEntryId: journalId, lineNumber: 2, accountId: retainedEarnings!._id,
        debitMinor: 0, creditMinor: amountMinor, currency: "JOD", scale: 3, accountingDate,
      })
    );
    return await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalId)).collect()
    ).then((lines) => lines.find((l) => l.accountId === bankChartAccount!._id)!);
  }

  return { t, orgId, asOwner, bankAccountId, seedLedgerLine };
}

describe("bankReconciliation.uploadStatementLines", () => {
  test("bulk-inserts statement rows as UNMATCHED under one import batch", async () => {
    const { orgId, asOwner, bankAccountId } = await seedDealerWithBankAccount();

    const result = await asOwner.mutation(api.bankReconciliation.uploadStatementLines, {
      orgId, bankAccountId,
      rows: [
        { statementDate: Date.now(), description: "Deposit A", amountMinor: 100_000 },
        { statementDate: Date.now(), description: "Deposit B", amountMinor: 50_000 },
      ],
    });
    expect(result.count).toBe(2);

    const lines = await asOwner.query(api.bankReconciliation.listStatementLines, { orgId, bankAccountId });
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.status === "UNMATCHED")).toBe(true);
    expect(lines[0].importBatchId).toBe(lines[1].importBatchId);
  });

  test("rejects an empty upload", async () => {
    const { orgId, asOwner, bankAccountId } = await seedDealerWithBankAccount();
    await expect(
      asOwner.mutation(api.bankReconciliation.uploadStatementLines, { orgId, bankAccountId, rows: [] })
    ).rejects.toThrow();
  });
});

describe("bankReconciliation.suggestMatches", () => {
  test("suggests an unambiguous match by exact amount + close date", async () => {
    const { orgId, asOwner, bankAccountId, seedLedgerLine } = await seedDealerWithBankAccount();
    const statementDate = Date.now();
    const ledgerLine = await seedLedgerLine(75_000, statementDate);

    await asOwner.mutation(api.bankReconciliation.uploadStatementLines, {
      orgId, bankAccountId,
      rows: [{ statementDate, description: "Payment received", amountMinor: 75_000 }],
    });

    const suggestions = await asOwner.query(api.bankReconciliation.suggestMatches, { orgId, bankAccountId });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].suggestedJournalLineId).toBe(ledgerLine._id);
  });

  test("does not suggest a match when the amount differs", async () => {
    const { orgId, asOwner, bankAccountId, seedLedgerLine } = await seedDealerWithBankAccount();
    const statementDate = Date.now();
    await seedLedgerLine(75_000, statementDate);

    await asOwner.mutation(api.bankReconciliation.uploadStatementLines, {
      orgId, bankAccountId,
      rows: [{ statementDate, description: "No match", amountMinor: 80_000 }],
    });

    const suggestions = await asOwner.query(api.bankReconciliation.suggestMatches, { orgId, bankAccountId });
    expect(suggestions[0].suggestedJournalLineId).toBeUndefined();
    expect(suggestions[0].candidates).toHaveLength(0);
  });

  test("does not pick a suggestion when two candidates tie on score", async () => {
    const { orgId, asOwner, bankAccountId, seedLedgerLine } = await seedDealerWithBankAccount();
    const statementDate = Date.now();
    // Two ledger lines with the same amount on the same date — genuinely ambiguous.
    await seedLedgerLine(60_000, statementDate);
    await seedLedgerLine(60_000, statementDate);

    await asOwner.mutation(api.bankReconciliation.uploadStatementLines, {
      orgId, bankAccountId,
      rows: [{ statementDate, description: "Ambiguous", amountMinor: 60_000 }],
    });

    const suggestions = await asOwner.query(api.bankReconciliation.suggestMatches, { orgId, bankAccountId });
    expect(suggestions[0].candidates.length).toBeGreaterThanOrEqual(2);
    expect(suggestions[0].suggestedJournalLineId).toBeUndefined();
  });
});

describe("bankReconciliation.confirmMatch", () => {
  test("confirms a match and marks the statement line MATCHED", async () => {
    const { orgId, asOwner, bankAccountId, seedLedgerLine } = await seedDealerWithBankAccount();
    const statementDate = Date.now();
    const ledgerLine = await seedLedgerLine(40_000, statementDate);
    await asOwner.mutation(api.bankReconciliation.uploadStatementLines, {
      orgId, bankAccountId, rows: [{ statementDate, description: "Match me", amountMinor: 40_000 }],
    });
    const [line] = await asOwner.query(api.bankReconciliation.listStatementLines, { orgId, bankAccountId });

    await asOwner.mutation(api.bankReconciliation.confirmMatch, {
      orgId, statementLineId: line._id, journalLineId: ledgerLine._id,
    });

    const [updated] = await asOwner.query(api.bankReconciliation.listStatementLines, { orgId, bankAccountId });
    expect(updated.status).toBe("MATCHED");
    expect(updated.matchedJournalLineId).toBe(ledgerLine._id);
  });

  test("rejects matching the same ledger line to two different statement lines", async () => {
    const { orgId, asOwner, bankAccountId, seedLedgerLine } = await seedDealerWithBankAccount();
    const statementDate = Date.now();
    const ledgerLine = await seedLedgerLine(30_000, statementDate);
    await asOwner.mutation(api.bankReconciliation.uploadStatementLines, {
      orgId, bankAccountId,
      rows: [
        { statementDate, description: "First claim", amountMinor: 30_000 },
        { statementDate, description: "Second claim", amountMinor: 30_000 },
      ],
    });
    const lines = await asOwner.query(api.bankReconciliation.listStatementLines, { orgId, bankAccountId });

    await asOwner.mutation(api.bankReconciliation.confirmMatch, {
      orgId, statementLineId: lines[0]._id, journalLineId: ledgerLine._id,
    });

    await expect(
      asOwner.mutation(api.bankReconciliation.confirmMatch, {
        orgId, statementLineId: lines[1]._id, journalLineId: ledgerLine._id,
      })
    ).rejects.toThrow(/already been matched/i);
  });

  test("rejects confirming a line that is no longer UNMATCHED", async () => {
    const { orgId, asOwner, bankAccountId, seedLedgerLine } = await seedDealerWithBankAccount();
    const statementDate = Date.now();
    const ledgerLine = await seedLedgerLine(20_000, statementDate);
    await asOwner.mutation(api.bankReconciliation.uploadStatementLines, {
      orgId, bankAccountId, rows: [{ statementDate, description: "Once", amountMinor: 20_000 }],
    });
    const [line] = await asOwner.query(api.bankReconciliation.listStatementLines, { orgId, bankAccountId });
    await asOwner.mutation(api.bankReconciliation.ignoreLine, { orgId, statementLineId: line._id, reason: "Bank error, never posted." });

    await expect(
      asOwner.mutation(api.bankReconciliation.confirmMatch, {
        orgId, statementLineId: line._id, journalLineId: ledgerLine._id,
      })
    ).rejects.toThrow(/no longer unmatched/i);
  });
});

describe("bankReconciliation.unmatch / ignoreLine", () => {
  test("unmatch reopens a MATCHED line for rematching", async () => {
    const { orgId, asOwner, bankAccountId, seedLedgerLine } = await seedDealerWithBankAccount();
    const statementDate = Date.now();
    const ledgerLine = await seedLedgerLine(15_000, statementDate);
    await asOwner.mutation(api.bankReconciliation.uploadStatementLines, {
      orgId, bankAccountId, rows: [{ statementDate, description: "Reopen me", amountMinor: 15_000 }],
    });
    const [line] = await asOwner.query(api.bankReconciliation.listStatementLines, { orgId, bankAccountId });
    await asOwner.mutation(api.bankReconciliation.confirmMatch, {
      orgId, statementLineId: line._id, journalLineId: ledgerLine._id,
    });

    await asOwner.mutation(api.bankReconciliation.unmatch, { orgId, statementLineId: line._id });

    const [updated] = await asOwner.query(api.bankReconciliation.listStatementLines, { orgId, bankAccountId });
    expect(updated.status).toBe("UNMATCHED");
    expect(updated.matchedJournalLineId).toBeUndefined();
  });

  test("cannot ignore a MATCHED line directly — must unmatch first", async () => {
    const { orgId, asOwner, bankAccountId, seedLedgerLine } = await seedDealerWithBankAccount();
    const statementDate = Date.now();
    const ledgerLine = await seedLedgerLine(10_000, statementDate);
    await asOwner.mutation(api.bankReconciliation.uploadStatementLines, {
      orgId, bankAccountId, rows: [{ statementDate, description: "Locked", amountMinor: 10_000 }],
    });
    const [line] = await asOwner.query(api.bankReconciliation.listStatementLines, { orgId, bankAccountId });
    await asOwner.mutation(api.bankReconciliation.confirmMatch, {
      orgId, statementLineId: line._id, journalLineId: ledgerLine._id,
    });

    await expect(
      asOwner.mutation(api.bankReconciliation.ignoreLine, { orgId, statementLineId: line._id, reason: "Test" })
    ).rejects.toThrow(/unmatch/i);
  });

  test("ignoreLine requires a reason and records who/when/why in the audit log", async () => {
    const { orgId, asOwner, bankAccountId } = await seedDealerWithBankAccount();
    const statementDate = Date.now();
    await asOwner.mutation(api.bankReconciliation.uploadStatementLines, {
      orgId, bankAccountId, rows: [{ statementDate, description: "Duplicate bank fee", amountMinor: 500 }],
    });
    const [line] = await asOwner.query(api.bankReconciliation.listStatementLines, { orgId, bankAccountId });

    await expect(
      asOwner.mutation(api.bankReconciliation.ignoreLine, { orgId, statementLineId: line._id, reason: "  " })
    ).rejects.toThrow(/reason is required/i);

    await asOwner.mutation(api.bankReconciliation.ignoreLine, {
      orgId, statementLineId: line._id, reason: "Duplicate import, already reconciled under a different line.",
    });

    const [updated] = await asOwner.query(api.bankReconciliation.listStatementLines, { orgId, bankAccountId });
    expect(updated.status).toBe("IGNORED");
    expect(updated.ignoreReason).toBe("Duplicate import, already reconciled under a different line.");
    expect(updated.ignoredBy).toBeTruthy();
    expect(updated.ignoredAt).toBeTruthy();

    const auditEntries = await asOwner.query(api.financialAudit.listAuditLog, { orgId });
    const entry = auditEntries.find((e: { actionType: string }) => e.actionType === "IGNORE_BANK_STATEMENT_LINE");
    expect(entry).toBeTruthy();
    expect(entry?.description).toMatch(/Duplicate import/);
  });
});
