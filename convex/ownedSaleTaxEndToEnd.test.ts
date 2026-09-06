/**
 * A taxed owned sale, from `sales.create` through to both books (SCRUM-22).
 *
 * The unit tests in `accounting/ownedSaleTaxPosting.test.ts` pin what
 * `ruleSaleCompleted` returns. They cannot catch the other half of the defect:
 * the canonical `receivableDocuments` row is sized by `customerBillableMinor`
 * in `utils/saleCompletion.ts`, a completely separate expression. Before this
 * change both omitted the tax, so they agreed with each other while both
 * understated what the customer owed — and after fixing only one of them they
 * would have disagreed by exactly the tax, which is worse.
 *
 * So the assertion that matters is not either number on its own. It is that the
 * GL's AR debit and the subledger document are the SAME number, and that the
 * number is what the invoice says.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { settleOutbox } from "../test-utils/outboxWork";
import { api } from "./_generated/api";
import { SYSTEM_KEYS } from "./utils/defaultChart";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

/** JOD is scale 3, so a major unit is 1000 minor. */
const jod = (major: number): number => Math.round(major * 1000);

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const now = Date.now();

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Tax Dealer ${tag}`, createdAt: now })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: `${tag} User` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: [
        "view:sales", "create:sales", "edit:sales",
        "view:vehicles", "create:vehicles", "edit:vehicles",
        "view:customers", "create:customers",
        "manage:finance", "view:finance",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });

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
    ctx.db.insert("customers", { orgId, firstName: "Taxed", lastName: "Buyer" })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `VIN_TAX_${tag}`,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 0,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      purchasePrice: 17000,
      sellingPrice: 20000,
      status: "AVAILABLE",
    })
  );

  return { t, orgId, userId, customerId, vehicleId, asUser };
}

/** Net movement on one system account across the sale's journal entry. */
async function netOnAccount(
  t: Awaited<ReturnType<typeof seedDealer>>["t"],
  orgId: string,
  systemKey: string
): Promise<number> {
  return await t.run(async (ctx) => {
    const account = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) =>
        q.eq("orgId", orgId as never).eq("systemKey", systemKey)
      )
      .unique();
    if (!account) throw new Error(`No account for ${systemKey}`);

    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_org_account", (q) =>
        q.eq("orgId", orgId as never).eq("accountId", account._id)
      )
      .collect();
    return lines.reduce((sum, l) => sum + (l.debitMinor ?? 0) - (l.creditMinor ?? 0), 0);
  });
}

describe("a taxed owned sale reaches both books with the same amount", () => {
  test("the GL receivable, the subledger document and the invoice all agree", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await seedDealer("agree");

    const saleId = await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 20_000,
      taxAmount: 3_200,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    // What the invoice says: SaleDialog bills salePrice + taxAmount.
    const invoiceMinor = jod(23_200);

    const arDebitMinor = await netOnAccount(t, orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS);
    expect(arDebitMinor).toBe(invoiceMinor);

    const receivable = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      const id = sale?.canonicalReceivableDocumentId;
      return id ? await ctx.db.get(id) : null;
    });
    // ANTI-VACUITY: a missing document would make the comparison below pass for
    // the trivial reason.
    expect(receivable).toBeTruthy();
    expect(receivable!.originalAmountMinor).toBe(invoiceMinor);

    // Stated as its own assertion because this is the invariant, not the two
    // amounts: one customer, one bill, two books.
    expect(receivable!.originalAmountMinor).toBe(arDebitMinor);

    // And the tax never became revenue.
    expect(await netOnAccount(t, orgId, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
    expect(await netOnAccount(t, orgId, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(-jod(3_200));
  });

  test("a tax larger than the price is refused, and nothing reaches either book", async () => {
    // Before SCRUM-22 this was refused by accident: revenue was
    // `salePrice - tax`, which went negative, and `validateBalance` rejects a
    // negative journal line, so the whole mutation rolled back. Making revenue
    // the full price removed that side effect and nothing replaced it —
    // `validations/sales.ts` bounds `taxAmount` at `min(0)` with no ceiling, so
    // a mistyped 32,000 instead of 3,200 posted a balanced, valid journal
    // debiting AR 52,000 and crediting a 32,000 tax liability. `sales.update`
    // then locks financial fields, so the only repair is cancel-and-recreate.
    //
    // `expenses.ts` already refuses `taxAmount > amount` on the sibling path.
    // The sales path now says so explicitly rather than relying on arithmetic
    // that no longer produces it.
    const { t, orgId, userId, customerId, vehicleId, asUser } = await seedDealer("overtax");

    await expect(
      asUser.mutation(api.sales.create, {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 20_000,
        taxAmount: 32_000,
        saleDate: Date.now(),
        status: "COMPLETED",
        financingType: "CASH",
      })
    ).rejects.toThrow(/tax/i);

    // The refusal must be total. A mutation that threw after writing the
    // receivable would leave a 52,000 invoice with no journal behind it, which
    // is a worse failure than the one being closed.
    expect(await netOnAccount(t, orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(0);
    const receivables = await t.run((ctx) => ctx.db.query("receivableDocuments").collect());
    expect(receivables).toHaveLength(0);
  });

  test("a tax equal to the price is still allowed — the bound is a ceiling, not a ban", async () => {
    // ANTI-VACUITY for the refusal above: without this, a guard that rejected
    // every taxed sale outright would pass it while breaking the ordinary case
    // the whole ticket exists to make work.
    const { t, orgId, userId, customerId, vehicleId, asUser } = await seedDealer("edgetax");

    await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 20_000,
      taxAmount: 20_000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    expect(await netOnAccount(t, orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(40_000));
  });

  test("a PENDING draft may carry no agreed price, and stays editable", async () => {
    // The backend explicitly permits this — `CreateDraftSaleSchema` bounds
    // `salePrice` at min(0) and the sale form submits a zero default. A draft is
    // a deal in progress; the price is often the last thing agreed. An earlier
    // attempt at the completion invariant lived in `prepareSaleCompletion`,
    // which draft creation also passes through, and refused this outright.
    const s = await seedDealer("draftzero");
    const draftId = await s.asUser.mutation(api.sales.createDraft, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: 0,
      saleDate: Date.now(),
      financingType: "CASH",
    });
    const draft = await s.t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.status).toBe("PENDING");
    // Nothing financial happened: a draft posts no journal and raises no bill.
    expect(await netOnAccount(s.t, s.orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(0);
    expect(await s.t.run((ctx) => ctx.db.query("receivableDocuments").collect())).toHaveLength(0);

    // ...and completing it while still unpriced is refused, without the draft
    // being consumed. It remains a draft that can be repriced.
    await expect(
      s.asUser.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId: draftId })
    ).rejects.toThrow(/price/i);
    expect((await s.t.run((ctx) => ctx.db.get(draftId)))?.status).toBe("PENDING");
    expect(
      await s.t.run(async (ctx) => (await ctx.db.get(s.vehicleId))?.status)
    ).not.toBe("SOLD");
  });

  test("a price that rounds to nothing is refused BEFORE anything financial is written", async () => {
    // The HIGH regression. 0.0004 JOD is positive in the caller's major units
    // and 0 in the ledger's minor units, so a major-unit floor waves it through.
    // With a dealer fee to balance the journal it posted Dr AR 500 / Cr Dealer
    // Fee 500 plus a full-cost COGS relief against ZERO revenue, and marked the
    // vehicle SOLD — an input `main` refuses.
    const s = await seedDealer("subprec");
    await expect(
      s.asUser.mutation(api.sales.create, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 0.0004,
        dealerFees: 500,
        saleDate: Date.now(),
        status: "COMPLETED",
        financingType: "CASH",
      })
    ).rejects.toThrow(/rounds to nothing/i);

    // The refusal must be TOTAL — this is the half a posting-rule-only fix
    // cannot deliver.
    expect(await netOnAccount(s.t, s.orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(0);
    expect(await netOnAccount(s.t, s.orgId, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD)).toBe(0);
    expect(await s.t.run((ctx) => ctx.db.query("sales").collect())).toHaveLength(0);
    expect(await s.t.run((ctx) => ctx.db.query("receivableDocuments").collect())).toHaveLength(0);
    expect(await s.t.run(async (ctx) => (await ctx.db.get(s.vehicleId))?.status)).toBe("AVAILABLE");
  });

  test("the smallest representable price gets past the invariant — it is not 'refuse small numbers'", async () => {
    // ANTI-VACUITY for the case above. 0.001 JOD is 1 minor unit: the smallest
    // thing the currency can express. A guard that refused it would be rejecting
    // by magnitude rather than by representability, and the sub-precision test
    // would still pass.
    const s = await seedDealer("minprice");
    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: 0.001,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });
    expect(await netOnAccount(s.t, s.orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(1);
  });

  test("the invariant refuses BEFORE the outbox, even when accounting would be deferred", async () => {
    // THE ANTI-VACUITY PROOF THAT MATTERS. `postOrEnqueue` defers to the outbox
    // whenever the chart is uninitialized or no period is open, so a refusal
    // that lives in `ruleSaleCompleted` would arrive at DRAIN time — long after
    // the sale row, the vehicle status and the receivable were committed. A
    // control that only fires when accounting happens to post immediately is
    // not a control.
    //
    // Dating the sale into a year with no period reaches the deferred branch.
    const s = await seedDealer("deferredzero");
    const priorYear = new Date().getUTCFullYear() - 1;

    await expect(
      s.asUser.mutation(api.sales.create, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 0.0004,
        dealerFees: 500,
        saleDate: Date.UTC(priorYear, 5, 15),
        status: "COMPLETED",
        financingType: "CASH",
      })
    ).rejects.toThrow(/rounds to nothing/i);

    // No queued accounting event, and no sale to queue one for.
    expect(await s.t.run((ctx) => ctx.db.query("pendingAccountingEvents").collect())).toHaveLength(0);
    expect(await s.t.run((ctx) => ctx.db.query("sales").collect())).toHaveLength(0);
    expect(await s.t.run(async (ctx) => (await ctx.db.get(s.vehicleId))?.status)).toBe("AVAILABLE");
  });

  test("a zero-price sale is refused whether or not it carries add-ons", async () => {
    // Emitting the revenue line only when there IS revenue removed a SECOND
    // accidental fail-closed, and this pins the replacement.
    //
    // Before, a `salePrice: 0` sale threw "A journal line must have either a
    // debit or credit amount" on the empty revenue line and the whole mutation
    // rolled back. Once that line is omitted, the same sale with a dealer fee
    // posts a perfectly balanced entry — Dr AR 500 / Cr Dealer Fee Income 500,
    // plus a full-cost COGS relief against zero revenue — and marks the vehicle
    // SOLD. Whether a mistyped price failed closed would then depend on whether
    // an unrelated fee field happened to be set, which is not a rule anyone
    // could reason about.
    //
    // `completeSalesForLineItems` has refused `unitPrice <= 0` all along. The
    // single-vehicle door simply never had the same floor, and nothing noticed
    // while the arithmetic was refusing these by accident.
    const withFees = await seedDealer("zeroprice");
    await expect(
      withFees.asUser.mutation(api.sales.create, {
        orgId: withFees.orgId,
        vehicleId: withFees.vehicleId,
        customerId: withFees.customerId,
        salespersonId: withFees.userId,
        salePrice: 0,
        dealerFees: 500,
        saleDate: Date.now(),
        status: "COMPLETED",
        financingType: "CASH",
      })
    ).rejects.toThrow(/price/i);
    expect(
      await netOnAccount(withFees.t, withFees.orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)
    ).toBe(0);

    // The same refusal without add-ons. Previously this one failed closed and
    // the one above did not; the point of the floor is that they agree.
    const bare = await seedDealer("zeroprice2");
    await expect(
      bare.asUser.mutation(api.sales.create, {
        orgId: bare.orgId,
        vehicleId: bare.vehicleId,
        customerId: bare.customerId,
        salespersonId: bare.userId,
        salePrice: 0,
        saleDate: Date.now(),
        status: "COMPLETED",
        financingType: "CASH",
      })
    ).rejects.toThrow(/price/i);
  });

  test("a sale queued against a closed period carries the convention marker and drains to the same number", async () => {
    // The marker is only load-bearing on the DEFERRED path, and every other
    // test here posts immediately against an open period — so nothing proved
    // the marker survives `pendingAccountingEvents`. It is stored as
    // `v.optional(v.any())` today, but a later hardening of that validator, or
    // any payload-normalising layer, would drop it silently: the immediate path
    // would stay correct while every deferred taxed sale quietly reverted to
    // the old convention, against a receivable sized under the new one. The
    // journal would still balance, which is the exact blindness SCRUM-22 exists
    // to close.
    const { t, orgId, userId, customerId, vehicleId, asUser } = await seedDealer("deferred");

    // Deferral is driven by `shouldPost` → `getOpenPeriodForDate`. Dating the
    // sale into a year the seed created no period for is the cleanest way to
    // reach that branch; closing the seeded period instead runs an unrelated
    // close checklist that has nothing to do with this invariant.
    const priorYear = new Date().getUTCFullYear() - 1;
    const saleId = await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 20_000,
      taxAmount: 3_200,
      saleDate: Date.UTC(priorYear, 5, 15),
      status: "COMPLETED",
      financingType: "CASH",
    });

    // Nothing posted yet — the event is queued, not journalled.
    expect(await netOnAccount(t, orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(0);

    const queued = await t.run(async (ctx) =>
      (await ctx.db.query("pendingAccountingEvents").collect()).find(
        (p) => p.eventType === "SALE_COMPLETED"
      )
    );
    // ANTI-VACUITY: if the sale had posted immediately, or the outbox row were
    // missing, every assertion below would pass for the wrong reason.
    expect(queued).toBeTruthy();
    expect((queued!.payload as { taxConventionExclusive?: boolean }).taxConventionExclusive).toBe(true);

    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(priorYear, 0, 1),
      endDate: Date.UTC(priorYear, 11, 31, 23, 59, 59, 999),
      fiscalYear: priorYear,
      periodNumber: 1,
    });
    const priorPeriod = (await asUser.query(api.accountingPeriods.list, { orgId })).find(
      (p) => p.fiscalYear === priorYear
    );
    expect(priorPeriod).toBeTruthy();
    await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: priorPeriod!._id });
    await asUser.mutation(api.accountingOutbox.redrive, { orgId });
    // The redrive queues the work; the worker performs it in its own
    // transaction, which is what makes a failure roll back (SCRUM-222).
    await settleOutbox(t, orgId);

    const invoiceMinor = jod(23_200);
    const arDebitMinor = await netOnAccount(t, orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS);
    expect(arDebitMinor).toBe(invoiceMinor);

    const receivable = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      const id = sale?.canonicalReceivableDocumentId;
      return id ? await ctx.db.get(id) : null;
    });
    expect(receivable).toBeTruthy();
    // The invariant, on the deferred path this time: one customer, one bill,
    // two books.
    expect(receivable!.originalAmountMinor).toBe(arDebitMinor);
    expect(await netOnAccount(t, orgId, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
    expect(await netOnAccount(t, orgId, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(-jod(3_200));
  });

  test("an untaxed sale is unchanged in both books", async () => {
    // The common case. A fix that shifted this would restate every sale ever
    // recorded, so it is pinned at the same level as the taxed one.
    const { t, orgId, userId, customerId, vehicleId, asUser } = await seedDealer("plain");

    const saleId = await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 20_000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    const arDebitMinor = await netOnAccount(t, orgId, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS);
    expect(arDebitMinor).toBe(jod(20_000));

    const receivable = await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      const id = sale?.canonicalReceivableDocumentId;
      return id ? await ctx.db.get(id) : null;
    });
    expect(receivable).toBeTruthy();
    expect(receivable!.originalAmountMinor).toBe(jod(20_000));
    expect(await netOnAccount(t, orgId, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
  });
});

