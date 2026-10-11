/**
 * Shared fixture for the SCRUM-795 manual-journal pilot-switch suites.
 *
 * Both suites run the SAME seeded world: one with the switch as shipped (ON,
 * refusal expected) and one with the leaf module mocked to OFF (the same
 * fixture must succeed). That pairing is what makes the refusal a statement
 * about the switch rather than about a broken fixture (SCRUM-795 D3).
 *
 * Callers pass their own `import.meta.glob` result because Vite resolves the
 * glob relative to the file that contains it.
 */
import { convexTestWithComponents } from "./convexTest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

export async function seedManualJournalWorld(
  moduleGlob: Parameters<typeof convexTestWithComponents>[1],
  tag: string
) {
  const t = convexTestWithComponents(schema, moduleGlob);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `SCRUM-795 ${tag}`, createdAt: Date.now() })
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
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance",
      permissions: ["view:sales", "manage:finance", "view:finance"],
    })
  );
  const posterId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_poster`, email: `${tag}_poster@example.com`, name: "Poster" })
  );
  const reviewerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_reviewer`, email: `${tag}_reviewer@example.com`, name: "Reviewer" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: posterId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: reviewerId, roleId }));
  // A member with no finance authority, to prove the refusal sits behind auth.
  const salesRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "SalesOnly", permissions: ["view:sales"] })
  );
  const salesId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_sales`, email: `${tag}_sales@example.com`, name: "Sales" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: salesId, roleId: salesRoleId }));
  // The owner: the only role allowed to use postOpeningBalanceDirect.
  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: ["view:finance", "manage:finance"],
      isSystemOwnerRole: true,
    })
  );
  const ownerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_owner`, email: `${tag}_owner@example.com`, name: "Owner" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRoleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    })
  );

  const asPoster = t.withIdentity({ subject: `${tag}_poster`, clerkId: `${tag}_poster` });
  const asReviewer = t.withIdentity({ subject: `${tag}_reviewer`, clerkId: `${tag}_reviewer` });
  const asSales = t.withIdentity({ subject: `${tag}_sales`, clerkId: `${tag}_sales` });
  const asOwner = t.withIdentity({ subject: `${tag}_owner`, clerkId: `${tag}_owner` });

  await asPoster.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asPoster.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await asPoster.query(api.accountingPeriods.list, { orgId }))[0];
  await asPoster.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const accounts = await asPoster.query(api.chartOfAccounts.list, { orgId });
  const manualAccounts = accounts.filter((a) => a.allowManualPosting);
  const lines = [
    { accountId: manualAccounts[0]._id, debitMinor: 5000, creditMinor: 0 },
    { accountId: manualAccounts[1]._id, debitMinor: 0, creditMinor: 5000 },
  ];

  // An otherwise-approvable LEGACY draft: open period, created by the poster,
  // valid accounts, a declared accounting date. Written directly because the
  // create door is exactly what the switch closes.
  const legacyDraftId = await t.run((ctx) =>
    ctx.db.insert("manualJournalDrafts", {
      orgId,
      status: "PENDING_APPROVAL",
      memo: "Legacy pending draft",
      lines,
      accountingDate: Date.now(),
      idempotencyKey: `${tag}_legacy`,
      createdBy: posterId,
      createdAt: Date.now(),
    })
  );

  return {
    t,
    orgId,
    posterId,
    reviewerId,
    asPoster,
    asReviewer,
    asSales,
    asOwner,
    ownerId,
    period,
    manualAccounts,
    lines,
    legacyDraftId,
  };
}

export type ManualJournalWorld = Awaited<ReturnType<typeof seedManualJournalWorld>>;
