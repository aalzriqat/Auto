import { expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { withFrozenScheduler, settleScheduledOnly } from "../test-utils/outboxWork";

// Dormant, non-pilot accounting capability: only the deployment switch is overridden.
// The unmocked CURRENT pilot refusal is measured in partnerDistributionPilot.test.ts.
vi.mock("./utils/partnerDistributionContainment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/partnerDistributionContainment")>()),
  PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED: false,
}));

// Synthetic balances only; no classification of the owner's unmatched amount.
async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST partner opening", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "partner-opening-owner", email: "owner@example.test" });
    const approverId = await ctx.db.insert("users", { clerkId: "partner-opening-approver", email: "approver@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const financeRole = await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["view:finance", "manage:finance", "approve:requests"] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("memberships", { orgId, userId: approverId, roleId: financeRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return orgId;
  });
  const owner = t.withIdentity({ subject: "partner-opening-owner" });
  const approver = t.withIdentity({ subject: "partner-opening-approver" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  await owner.mutation(api.accountingPeriods.create, { orgId, startDate: asOfDate,
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  if (!period) throw new Error("Missing synthetic period");
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const partners = await Promise.all(["A", "B"].map((name) => owner.mutation(api.partnerEquity.add, {
    orgId, partnerName: `Synthetic ${name}`, idempotencyKey: `synthetic-partner-${name}`,
  })));
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
  const cash = accounts.find((account) => account.systemKey === "CASH_ON_HAND");
  const capital = accounts.find((account) => account.systemKey === "PARTNER_CAPITAL");
  if (!cash || !capital) throw new Error("Missing synthetic accounts");
  const custom = await owner.mutation(api.chartOfAccounts.create, {
    orgId, code: "QA-CAPITAL-EXPLICIT", name: "Synthetic additional capital", type: "EQUITY", normalBalance: "CREDIT",
  });
  const payload = { orgId, expectedCurrency: "JOD", asOfDate,
    lines: [{ accountId: cash._id, debitMinor: 300_000, creditMinor: 0 },
      { accountId: capital._id, debitMinor: 0, creditMinor: 200_000 },
      { accountId: custom, debitMinor: 0, creditMinor: 100_000 }],
    allocations: [
      { kind: "PARTNER_CAPITAL" as const, rowKey: "a-base", accountId: capital._id, partnerId: partners[0], amountMinor: 100_000 },
      { kind: "PARTNER_CAPITAL" as const, rowKey: "b-base", accountId: capital._id, partnerId: partners[1], amountMinor: 100_000 },
      { kind: "PARTNER_CAPITAL" as const, rowKey: "a-additional", accountId: custom, partnerId: partners[0], amountMinor: 100_000 },
    ] };
  return { t, owner, approver, orgId, partners, capital, custom, asOfDate, payload };
}

async function state(seed: Awaited<ReturnType<typeof fixture>>) {
  return seed.t.run(async (ctx) => ({
    partners: await ctx.db.query("partnerEquity").collect(), movements: await ctx.db.query("partnerEquityTransactions").collect(),
    drafts: await ctx.db.query("openingBalanceDrafts").collect(), journals: await ctx.db.query("journalEntries").collect(),
    lines: await ctx.db.query("journalLines").collect(), events: await ctx.db.query("accountingEvents").collect(),
    pending: await ctx.db.query("pendingAccountingEvents").collect(), snapshots: await ctx.db.query("accountBalanceSnapshots").collect(),
    commands: await ctx.db.query("commandIdempotency").collect(),
    accounts: await ctx.db.query("chartOfAccounts").collect(),
  }));
}

test("opening account options classify native and custom capital plus prepaid without enabling unsupported controls", async () => {
  const seed = await fixture();
  const options = await seed.owner.query(api.accountingCutover.listOpeningAccountPolicies, { orgId: seed.orgId });
  const byId = new Map(options.map((option) => [option.accountId, option.policy]));
  const accounts = await seed.owner.query(api.chartOfAccounts.list, { orgId: seed.orgId, activeOnly: true });
  const cash = accounts.find((account) => account.systemKey === "CASH_ON_HAND");
  const prepaid = accounts.find((account) => account.systemKey === "PREPAID_EXPENSES");
  if (!cash || !prepaid) throw new Error("Missing synthetic chart controls");
  expect(byId.get(cash._id)).toBe("LEDGER_ONLY");
  expect(byId.get(seed.capital._id)).toBe("PARTNER_CAPITAL");
  expect(byId.get(seed.custom)).toBe("PARTNER_CAPITAL_CANDIDATE");
  expect(byId.get(prepaid._id)).toBe("PREPAID_EXPENSE");
});

test("pending review names the allocated partner and shows when that identity becomes unavailable", async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
  const [visible] = await seed.approver.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: seed.orgId });
  expect(visible?.allocationDetails).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "PARTNER_CAPITAL", rowKey: "a-base", partyId: seed.partners[0],
      partyName: "Synthetic A", amountMinor: 100_000, partyAvailable: true }),
  ]));
  await seed.t.run((ctx) => ctx.db.patch(seed.partners[0], { isDeleted: true }));
  const [changed] = await seed.approver.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: seed.orgId });
  expect(changed?.allocationDetails?.find((row) => row.rowKey === "a-base")?.partyAvailable).toBe(false);
});

test.each(["DIRECT", "TWO_PERSON"] as const)("%s explicitly allocated partner opening materializes native bases with no contribution", async (route) => {
  const seed = await fixture();
  const original = await state(seed);
  if (route === "DIRECT") await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  else {
    await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
    const pending = await seed.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
    if (!pending) throw new Error("Missing prepared opening");
    await seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: pending._id });
  }
  const after = await state(seed);
  expect(after.journals).toHaveLength(1);
  expect(after.lines).toHaveLength(3);
  expect(after.movements).toEqual(original.movements);
  expect(after.events).toEqual(original.events);
  expect(after.pending).toEqual(original.pending);
  expect(after.drafts).toHaveLength(1);
  expect(after.drafts[0]).toMatchObject({ status: "POSTED", allocations: seed.payload.allocations });
  const listed = await seed.owner.query(api.partnerEquity.list, { orgId: seed.orgId, paginationOpts: { cursor: null, numItems: 100 } });
  expect(listed.page.find((row) => row._id === seed.partners[0])).toMatchObject({ balanceMinor: 200_000, balanceStatus: "VERIFIED", transactionCount: 0 });
  expect(listed.page.find((row) => row._id === seed.partners[1])).toMatchObject({ balanceMinor: 100_000, balanceStatus: "VERIFIED", transactionCount: 0 });
  for (const partner of after.partners) expect(partner).toMatchObject({ openingBalanceDraftId: after.drafts[0]._id });
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload)).rejects.toThrow();
  expect(await state(seed)).toEqual(after);
});

test.each(["DIRECT", "PREPARE", "APPROVE"] as const)("unallocated legacy partner refuses at %s without writes", async (route) => {
  const seed = await fixture();
  let pending;
  if (route === "APPROVE") {
    await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
    pending = await seed.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
    if (!pending) throw new Error("Missing prepared opening");
  }
  await seed.t.run((ctx) => ctx.db.insert("partnerEquity", { orgId: seed.orgId, partnerName: "Synthetic omitted", currentBalance: 1 }));
  const before = await state(seed);
  const result = route === "DIRECT" ? seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload)
    : route === "PREPARE" ? seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload)
      : seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: pending!._id });
  await expect(result).rejects.toThrow("Existing partner balances require a finance review before an opening can be posted.");
  expect(await state(seed)).toEqual(before);
});

test("opposing debit and credit capital lines refuse instead of netting allocations", async () => {
  const seed = await fixture();
  const before = await state(seed);
  const payload = { ...seed.payload, lines: [
    { ...seed.payload.lines[0], debitMinor: 250_000 }, ...seed.payload.lines.slice(1),
    { accountId: seed.custom, debitMinor: 50_000, creditMinor: 0 },
  ] };
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, payload))
    .rejects.toThrow("Partner opening capital requires credit-only journal lines.");
  expect(await state(seed)).toEqual(before);
});

test.each(["MISSING_MARKER", "MISSING_PARENT", "UNPOSTED_PARENT", "MISSING_JOURNAL", "WRONG_BASE", "WRONG_CURRENCY"] as const)(
  "%s yields an unavailable balance for only the affected partner", async (damage) => {
    const seed = await fixture();
    await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
    await seed.t.run(async (ctx) => {
      const parent = await ctx.db.query("openingBalanceDrafts").unique();
      if (!parent?.journalEntryId) throw new Error("Missing posted opening");
      if (damage === "MISSING_MARKER") await ctx.db.patch(seed.partners[0], { openingBalanceDraftId: undefined });
      else if (damage === "WRONG_BASE") await ctx.db.patch(seed.partners[0], { openingBalanceMinor: 200_001 });
      else if (damage === "MISSING_PARENT") await ctx.db.delete(parent._id);
      else if (damage === "UNPOSTED_PARENT") await ctx.db.patch(parent._id, { status: "REJECTED" });
      else if (damage === "MISSING_JOURNAL") await ctx.db.delete(parent.journalEntryId);
      else await ctx.db.patch(parent._id, { currency: "USD" });
    });
    const listed = await seed.owner.query(api.partnerEquity.list, { orgId: seed.orgId, paginationOpts: { cursor: null, numItems: 100 } });
    expect(listed.page).toHaveLength(2);
    expect(listed.page.find((row) => row._id === seed.partners[0])).toMatchObject({ balanceStatus: "UNAVAILABLE", balanceMinor: null });
    if (damage === "MISSING_MARKER" || damage === "WRONG_BASE") {
      expect(listed.page.find((row) => row._id === seed.partners[1])).toMatchObject({ balanceStatus: "VERIFIED", balanceMinor: 100_000 });
    }
  });

test.each(["DRAW", "CONTRIBUTION", "PROFIT_DISTRIBUTION"] as const)("invalid opening provenance refuses a fresh %s without writes", async (type) => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  await seed.t.run((ctx) => ctx.db.patch(seed.partners[0], { openingBalanceMinor: 200_001 }));
  const before = await state(seed);
  await expect(seed.owner.mutation(api.partnerEquity.recordEquityMovement, {
    orgId: seed.orgId, partnerId: seed.partners[0], type, amountMinor: 1_000,
    ...(type === "PROFIT_DISTRIBUTION" ? {} : { paymentMethod: "CASH" as const }),
    occurredAt: seed.asOfDate, idempotencyKey: `invalid-basis-${type}`,
  })).rejects.toThrow("cannot be verified");
  expect(await state(seed)).toEqual(before);
});

test("a changed posted capital line makes the partner basis unavailable and refuses a fresh draw", async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const intact = await seed.owner.query(api.partnerEquity.list, { orgId: seed.orgId,
    paginationOpts: { cursor: null, numItems: 100 } });
  expect(intact.page.find((row) => row._id === seed.partners[0]))
    .toMatchObject({ balanceStatus: "VERIFIED", balanceMinor: 200_000 });
  await seed.t.run(async (ctx) => {
    const parent = await ctx.db.query("openingBalanceDrafts").unique();
    if (!parent?.journalEntryId) throw new Error("Missing posted opening");
    const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) =>
      q.eq("journalEntryId", parent.journalEntryId!)).collect();
    const capital = lines.find((line) => line.accountId === seed.capital._id);
    if (!capital) throw new Error("Missing posted capital line");
    await ctx.db.patch(capital._id, { creditMinor: capital.creditMinor - 1 });
  });
  const listed = await seed.owner.query(api.partnerEquity.list, { orgId: seed.orgId,
    paginationOpts: { cursor: null, numItems: 100 } });
  expect(listed.page.find((row) => row._id === seed.partners[0]))
    .toMatchObject({ balanceStatus: "UNAVAILABLE", balanceMinor: null });
  const before = await state(seed);
  await expect(seed.owner.mutation(api.partnerEquity.recordEquityMovement, {
    orgId: seed.orgId, partnerId: seed.partners[0], type: "DRAW", amountMinor: 1_000,
    paymentMethod: "CASH", occurredAt: seed.asOfDate, idempotencyKey: "corrupt-capital-line",
  })).rejects.toThrow("cannot be verified");
  expect(await state(seed)).toEqual(before);
});

test.each(["MARKED", "UNMARKED"] as const)("fresh movement before the opening date refuses for %s partner", async (kind) => {
  const seed = await fixture();
  const partnerId = kind === "MARKED" ? seed.partners[0] : await seed.owner.mutation(api.partnerEquity.add, {
    orgId: seed.orgId, partnerName: "Synthetic zero-base", idempotencyKey: "unmarked-zero-partner",
  });
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const before = await state(seed);
  await expect(seed.owner.mutation(api.partnerEquity.recordEquityMovement, {
    orgId: seed.orgId, partnerId, type: "CONTRIBUTION", amountMinor: 1_000, paymentMethod: "CASH",
    occurredAt: seed.asOfDate - 1, idempotencyKey: `backdated-${kind}`,
  })).rejects.toThrow("cannot precede the posted opening date");
  expect(await state(seed)).toEqual(before);
});

test("native movements add only their own postings and exhausted draw retry preserves the opening", async () => {
  await withFrozenScheduler(async () => {
    const seed = await fixture();
    await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
    const opening = await state(seed);
    const draw = { orgId: seed.orgId, partnerId: seed.partners[0], type: "DRAW" as const, amountMinor: 200_000,
      paymentMethod: "CASH" as const, occurredAt: seed.asOfDate, idempotencyKey: "opening-exhausted-draw" };
    const transactionId = await seed.owner.mutation(api.partnerEquity.recordEquityMovement, draw);
    await settleScheduledOnly(seed.t, seed.orgId);
    const exhausted = await state(seed);
    expect(exhausted.movements).toHaveLength(1);
    expect(exhausted.events).toHaveLength(1);
    expect(exhausted.journals).toHaveLength(2);
    expect(exhausted.lines).toHaveLength(5);
    expect(exhausted.drafts).toEqual(opening.drafts);
    expect(exhausted.lines.filter((line) => line.journalEntryId === opening.journals[0]._id)).toEqual(opening.lines);
    expect(await seed.owner.mutation(api.partnerEquity.recordEquityMovement, draw)).toBe(transactionId);
    expect(await state(seed)).toEqual(exhausted);
    await expect(seed.owner.mutation(api.partnerEquity.recordEquityMovement, { ...draw, amountMinor: 1, idempotencyKey: "overdraw-opening" }))
      .rejects.toThrow("Draw exceeds this partner's equity balance");
    expect(await state(seed)).toEqual(exhausted);
    await expect(seed.owner.mutation(api.partnerEquity.remove, { orgId: seed.orgId, equityId: seed.partners[0] }))
      .rejects.toThrow("belongs to the posted opening");
    expect(await state(seed)).toEqual(exhausted);
    for (const type of ["CONTRIBUTION", "PROFIT_DISTRIBUTION"] as const) {
      await seed.owner.mutation(api.partnerEquity.recordEquityMovement, {
        orgId: seed.orgId, partnerId: seed.partners[0], type, amountMinor: 10_000,
        ...(type === "CONTRIBUTION" ? { paymentMethod: "CASH" as const } : {}),
        occurredAt: seed.asOfDate, idempotencyKey: `opening-later-${type}`,
      });
      await settleScheduledOnly(seed.t, seed.orgId);
    }
    const after = await state(seed);
    expect(after.movements).toHaveLength(3);
    expect(after.events).toHaveLength(3);
    expect(after.journals).toHaveLength(4);
    expect(after.lines).toHaveLength(9);
    expect(after.drafts).toEqual(opening.drafts);
    const readback = await seed.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: seed.orgId });
    expect(readback?.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "PARTNER_CAPITAL", partyId: seed.partners[0],
        documentId: seed.partners[0], recordAvailable: true }),
    ]));
    const listed = await seed.owner.query(api.partnerEquity.list, { orgId: seed.orgId, paginationOpts: { cursor: null, numItems: 100 } });
    expect(listed.page.find((row) => row._id === seed.partners[0])).toMatchObject({ balanceMinor: 20_000, balanceStatus: "VERIFIED", transactionCount: 3 });
    const relevant = new Set([seed.capital._id, seed.custom]);
    const capitalMinor = after.lines.filter((line) => relevant.has(line.accountId)).reduce((sum, line) => sum + line.creditMinor - line.debitMinor, 0);
    const accounts = await seed.owner.query(api.chartOfAccounts.list, { orgId: seed.orgId });
    const drawings = accounts.find((account) => account.systemKey === "PARTNER_DRAWINGS");
    if (!drawings) throw new Error("Missing native drawings account");
    const drawingMinor = after.lines.filter((line) => line.accountId === drawings._id).reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0);
    expect(capitalMinor - drawingMinor).toBe(listed.page.reduce((sum, row) => sum + (row.balanceMinor ?? Number.NaN), 0));
  });
});

test.each(["CONTRIBUTION", "DRAW", "PROFIT_DISTRIBUTION"] as const)("generic reversal cannot detach a %s from its native partner movement", async (type) => {
  await withFrozenScheduler(async () => {
    const seed = await fixture();
    await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
    const transactionId = await seed.owner.mutation(api.partnerEquity.recordEquityMovement, {
      orgId: seed.orgId, partnerId: seed.partners[0], type, amountMinor: 1_000,
      ...(type === "PROFIT_DISTRIBUTION" ? {} : { paymentMethod: "CASH" as const }),
      occurredAt: seed.asOfDate, idempotencyKey: `reversal-source-${type}`,
    });
    await settleScheduledOnly(seed.t, seed.orgId);
    const before = await state(seed);
    const event = before.events.find((row) => row.sourceId === String(transactionId));
    if (!event || event.status !== "POSTED") throw new Error("Native partner event did not post");
    await expect(seed.owner.mutation(internal.accountingLedger.reverse, {
      orgId: seed.orgId, originalEventId: event._id, reversalDate: seed.asOfDate,
      reason: "Synthetic unsupported reversal", idempotencyKey: `unsupported-partner-reversal-${type}`,
    })).rejects.toThrow("Partner movements cannot be reversed through the generic ledger.");
    expect(await state(seed)).toEqual(before);
  });
});

for (const route of ["DIRECT", "PREPARE", "APPROVE"] as const) {
  test.each(["CURRENCY", "INACTIVE"] as const)(`${route} refuses a %s partner account without financial writes`, async (damage) => {
    const seed = await fixture();
    let pending;
    if (route === "APPROVE") {
      await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
      pending = await seed.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
      if (!pending) throw new Error("Missing prepared opening");
    }
    await seed.owner.mutation(api.chartOfAccounts.update, { orgId: seed.orgId, accountId: seed.custom,
      ...(damage === "CURRENCY" ? { currencyRestriction: "USD" } : { active: false }) });
    const before = await state(seed);
    const result = route === "DIRECT" ? seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload)
      : route === "PREPARE" ? seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload)
        : seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: pending!._id });
    const refusal = damage === "CURRENCY" ? "An opening account uses a different currency."
      : route === "DIRECT" ? "An opening account is inactive."
        : 'Account "Synthetic additional capital" is inactive and cannot carry an opening balance. Reactivate it first or use a different account.';
    await expect(result).rejects.toThrow(refusal);
    expect(await state(seed)).toEqual(before);
  });
}

test.each(["DIRECT", "PREPARE", "APPROVE"] as const)("retired allocated partner refuses at %s without financial writes", async (route) => {
  const seed = await fixture();
  let pending;
  if (route === "APPROVE") {
    await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
    pending = await seed.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
    if (!pending) throw new Error("Missing prepared opening");
  }
  await seed.owner.mutation(api.partnerEquity.remove, { orgId: seed.orgId, equityId: seed.partners[0] });
  const before = await state(seed);
  const result = route === "DIRECT" ? seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload)
    : route === "PREPARE" ? seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload)
      : seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: pending!._id });
  await expect(result).rejects.toThrow("Opening partner is unavailable.");
  expect(await state(seed)).toEqual(before);
});
