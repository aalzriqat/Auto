/**
 * Control accounts refuse manual posting.
 *
 * A manual journal is an arbitrary, unrestricted GL entry. The subledgers —
 * customer AR, finance-company AR, bank — are reconciled against their control
 * accounts, so a hand-written line against one of those accounts moves the GL
 * without moving the subledger and breaks the reconciliation the control exists
 * to provide. `resolveManualJournalCurrency` refuses it.
 *
 * Written for SCRUM-51: `accountingPhase14` relaxes `allowManualPosting` in its
 * own seed to get two-currency lines onto Bank and AR, and its comment claimed
 * the control was "covered by financialAudit's own tests". It was not — no such
 * test existed. A comment asserting a safety net that does not exist is worse
 * than no comment, because it suppresses the next reviewer's diligence. This is
 * that net.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedDealer() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Control Accounts Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      isSystemOwnerRole: true,
    })
  );
  for (const clerkId of ["mjc_owner", "mjc_approver"]) {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId, email: `${clerkId}@example.com`, name: clerkId })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  }
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asOwner = t.withIdentity({ subject: "mjc_owner", clerkId: "mjc_owner" });

  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const accountId = async (systemKey: string) => {
    const account = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
        .unique()
    );
    if (!account) throw new Error(`No account for ${systemKey}`);
    return account;
  };

  return { t, orgId: orgId as Id<"organizations">, asOwner, accountId };
}

describe("manual journals and control accounts", () => {
  test.each([
    ["BANK_ACCOUNT"],
    ["ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES"],
    ["ACCOUNTS_RECEIVABLE_CUSTOMERS"],
  ])("refuses a manual journal touching %s", async (systemKey) => {
    const { orgId, asOwner, accountId } = await seedDealer();
    const control = await accountId(systemKey);
    // A counter-account that DOES allow manual posting, so the control account
    // is the only possible cause of the refusal — otherwise this test could
    // pass on the wrong line and prove nothing.
    const counter = await accountId("GENERAL_EXPENSE");

    expect(control.allowManualPosting).not.toBe(true);
    expect(counter.allowManualPosting).toBe(true);

    await expect(
      asOwner.mutation(api.financialAudit.createManualJournal, {
        orgId,
        memo: "hand-written line against a control account",
        idempotencyKey: `control_${systemKey}`,
        lines: [
          { accountId: control._id, debitMinor: 100_000, creditMinor: 0 },
          { accountId: counter._id, debitMinor: 0, creditMinor: 100_000 },
        ],
      })
    ).rejects.toThrow(new RegExp(`${control.name}.*does not allow manual posting`, "i"));
  });

  test("accepts a journal between accounts that do allow manual posting", async () => {
    const { orgId, asOwner, accountId } = await seedDealer();
    const expense = await accountId("GENERAL_EXPENSE");
    const other = await accountId("MISCELLANEOUS_INCOME");

    // The refusal above must be about the control account, not about manual
    // journals in general — otherwise the test above would pass for the wrong
    // reason and prove nothing.
    const draft = await asOwner.mutation(api.financialAudit.createManualJournal, {
      orgId,
      memo: "ordinary reclass",
      idempotencyKey: "ordinary_reclass",
      lines: [
        { accountId: expense._id, debitMinor: 25_000, creditMinor: 0 },
        { accountId: other._id, debitMinor: 0, creditMinor: 25_000 },
      ],
    });
    expect(draft.draftId).toBeTruthy();
  });
});
