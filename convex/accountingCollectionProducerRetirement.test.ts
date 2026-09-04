/**
 * SCRUM-223 — retirement of the legacy COLLECTION_PAYMENT migration producer.
 *
 * `migrateUnpostedTransactions` could mint a COLLECTION_PAYMENT accounting
 * event from a legacy `transactions` row. That producer is retired here.
 *
 * The evidence this file owes, per the owner-proxy implementation contract:
 *
 *  §1  RETIRED_COLLECTION and UNMAPPED are distinguishable dispositions, and
 *      the classification reason travels in its own channel rather than the
 *      action/error `reason` channel.
 *  §2  `migrateUnpostedTransactions` and `auditLegacyTransactions` report the
 *      same retirement truth, because they consume the same classifier.
 *  §5  Retirement is not migration proof and not sign-off proof.
 *  §6  Cross-ticket: a modern receipt from EITHER collection producer does not
 *      gain a second journal when the legacy migration subsequently runs.
 *  §7  Dry-run creates no migration/accounting economic effect. It is NOT
 *      claimed to write nothing — `requireTenantAuth` runs first and may
 *      legitimately write a security audit row.
 *  §9  The returned `retired` counter is truthful.
 *  §10 `migrationGapAnalysis.migrationProgress` moves, because retired rows
 *      never become POSTED events sourced from `transactions`.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:expenses", "create:expenses", "edit:expenses",
  "manage:finance", "view:finance",
  "view:customers", "create:customers",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "approve:requests",
];

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Retire ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: `${tag} User` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD",
      enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
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

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Customer" })
  );

  return { t, orgId, userId, asUser, customerId };
}

/** Legacy `transactions` row, inserted directly — the shape migration scans. */
async function seedLegacyRow(
  t: any,
  orgId: string,
  category: string,
  opts: { type?: "IN" | "OUT"; amount?: number; description?: string } = {}
) {
  return t.run((ctx: any) =>
    ctx.db.insert("transactions", {
      orgId,
      type: opts.type ?? "IN",
      amount: opts.amount ?? 200,
      date: Date.now(),
      category,
      description: opts.description ?? `Legacy ${category}`,
    })
  );
}

/** The migration result row for one transaction, or a loud failure. */
function rowFor(results: any[], transactionId: string) {
  const row = results.find((r: any) => r.transactionId === transactionId);
  if (!row) throw new Error(`no migration result row for transaction ${transactionId}`);
  return row;
}

async function journalCount(t: any, orgId: string) {
  const rows = await t.run((ctx: any) =>
    ctx.db.query("journalEntries").withIndex("by_org", (q: any) => q.eq("orgId", orgId)).collect()
  );
  return rows.length;
}

/** Accounting events minted from the legacy `transactions` table specifically. */
async function migratedEvents(t: any, orgId: string) {
  return t.run((ctx: any) =>
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q: any) => q.eq("orgId", orgId).eq("sourceType", "transactions"))
      .collect()
  );
}

// ─── §1 / §2 — classification truth, and both consumers agreeing on it ────────

describe("SCRUM-223 §1 — RETIRED_COLLECTION is distinguishable from UNMAPPED", () => {
  test("a retired collection row and an unmapped row carry different dispositions and reasons", async () => {
    const { t, orgId, asUser } = await seedDealer("cls");

    const retiredId = await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT");
    const unmappedId = await seedLegacyRow(t, orgId, "CLAIM_PAYMENT");

    const result = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });

    const retiredRow = rowFor(result.results, retiredId.toString());
    const unmappedRow = rowFor(result.results, unmappedId.toString());

    // The whole point of the ticket: these two must not collapse into one
    // generic bucket. r2 warned that reusing `no_rule_for_category` for the
    // retired category destroys the distinguishable reason this ticket owes.
    expect(retiredRow.disposition).toBe("RETIRED_COLLECTION");
    expect(unmappedRow.disposition).toBe("UNMAPPED");
    expect(retiredRow.classificationReason).not.toBe(unmappedRow.classificationReason);
    expect(unmappedRow.classificationReason).toBe("no_rule_for_category");

    // Neither may be posted.
    expect(retiredRow.action).toBe("SKIP");
    expect(unmappedRow.action).toBe("SKIP");
    expect(retiredRow.eventType).toBeNull();
  });

  test("classification reason does not travel in the action/error `reason` channel", async () => {
    const { t, orgId, asUser } = await seedDealer("chan");
    const retiredId = await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT");

    const result = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });
    const row = rowFor(result.results, retiredId.toString());

    // `reason` is reserved for action/error outcomes (already_posted, error
    // messages). Classification truth lives in its own field so the two cannot
    // drift into each other.
    expect(row.classificationReason).toBe("collection_producer_retired");
    expect(row.reason).toBeUndefined();
  });
});

describe("SCRUM-223 §2 — migration and audit report the same retirement truth", () => {
  test("auditLegacyTransactions reports the retired row as retired, not as migratable", async () => {
    const { t, orgId, asUser } = await seedDealer("aud");
    await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT");

    const audit = await asUser.query(api.accountingMigration.auditLegacyTransactions, {
      orgId, onlyUnposted: true,
    });

    expect(audit.unpostedCount).toBe(1);
    const row = audit.rows[0];

    // Before retirement the audit advertised eventType "COLLECTION_PAYMENT",
    // i.e. "this row is migratable". That was the same authority-bearing claim
    // the migration acted on.
    expect(row.disposition).toBe("RETIRED_COLLECTION");
    expect(row.classificationReason).toBe("collection_producer_retired");
    expect(row.eventType).toBeNull();
    expect(row.hasJournalEntry).toBe(false);
  });

  test("audit and migration agree row-for-row on disposition", async () => {
    const { t, orgId, asUser } = await seedDealer("agree");
    await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT");
    await seedLegacyRow(t, orgId, "CLAIM_PAYMENT");
    await seedLegacyRow(t, orgId, "EXPENSE", { type: "OUT", amount: 50 });

    const audit = await asUser.query(api.accountingMigration.auditLegacyTransactions, { orgId });
    const migration = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: true, limit: 10,
    });

    const auditByTx = new Map(audit.rows.map((r: any) => [r.id, r.disposition]));
    expect(auditByTx.size).toBe(3);
    for (const r of migration.results) {
      expect(auditByTx.get(r.transactionId)).toBe(r.disposition);
    }
  });
});

// ─── §3 — the producer cannot construct a COLLECTION_PAYMENT event ────────────

describe("SCRUM-223 §3 — the retired producer mints no COLLECTION_PAYMENT authority", () => {
  test("live migration of a legacy collection row creates no accounting event and no journal", async () => {
    const { t, orgId, asUser } = await seedDealer("mint");
    await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT", { amount: 750 });

    const before = await journalCount(t, orgId);

    const result = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });

    expect(result.posted).toBe(0);
    expect(await journalCount(t, orgId)).toBe(before);

    const events = await migratedEvents(t, orgId);
    expect(events).toHaveLength(0);
  });
});

// ─── §9 — the returned retired counter is truthful ────────────────────────────

describe("SCRUM-223 §9 — the retired counter", () => {
  test("an all-retired scanned set reports retirement truthfully", async () => {
    const { t, orgId, asUser } = await seedDealer("cnt");
    await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT", { amount: 100 });
    await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT", { amount: 200 });
    await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT", { amount: 300 });

    const result = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });

    expect(result.retired).toBe(3);
    expect(result.posted).toBe(0);
    expect(result.wouldPost).toBe(0);
    expect(result.failed).toBe(0);
    // Retired rows are skipped, so they are counted in both — stated explicitly
    // rather than left ambiguous.
    expect(result.skipped).toBe(3);
    expect(result.results).toHaveLength(3);
  });

  test("the retired counter is derived from classification, not from a separate tally", async () => {
    const { t, orgId, asUser } = await seedDealer("drv");
    await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT");
    await seedLegacyRow(t, orgId, "EXPENSE", { type: "OUT", amount: 40 });
    await seedLegacyRow(t, orgId, "CLAIM_PAYMENT");

    const result = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });

    const retiredRows = result.results.filter((r: any) => r.disposition === "RETIRED_COLLECTION");
    expect(result.retired).toBe(retiredRows.length);
    expect(result.retired).toBe(1);
    expect(result.posted).toBe(1); // the EXPENSE row still migrates
  });
});

// ─── §7 — dry-run has no economic effect (NOT "writes nothing") ───────────────

describe("SCRUM-223 §7 — dry-run economic effect", () => {
  test("dry-run over a retired row creates no accounting event, journal or GL effect", async () => {
    const { t, orgId, asUser } = await seedDealer("dry");
    await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT");

    const beforeJournals = await journalCount(t, orgId);

    const result = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: true, limit: 10,
    });

    expect(result.dryRun).toBe(true);
    expect(result.retired).toBe(1);
    expect(result.wouldPost).toBe(0); // a retired row is never a would-post

    expect(await journalCount(t, orgId)).toBe(beforeJournals);
    expect(await migratedEvents(t, orgId)).toHaveLength(0);
  });

  test("the live path is exercised with an explicit dryRun:false, since it defaults to true", async () => {
    const { t, orgId, asUser } = await seedDealer("expl");
    await seedLegacyRow(t, orgId, "EXPENSE", { type: "OUT", amount: 90 });

    const defaulted = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, limit: 10,
    });
    expect(defaulted.dryRun).toBe(true);
    expect(defaulted.posted).toBe(0);

    const live = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });
    expect(live.dryRun).toBe(false);
    expect(live.posted).toBe(1);
  });
});

// ─── §10 — migrationProgress moves, and that is correct ───────────────────────

describe("SCRUM-223 §10 — migrationGapAnalysis reflects retirement", () => {
  test("an org whose only legacy row is retired never reaches 100% progress", async () => {
    const { t, orgId, asUser } = await seedDealer("prog");
    await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT");

    await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });

    const gap = await asUser.query(api.accountingMigration.migrationGapAnalysis, { orgId });
    expect(gap.legacy.transactions).toBe(1);
    // migrationProgress counts POSTED events sourced from `transactions`.
    // A retired row never becomes one, so progress stays at 0 — this is the
    // honest reading, not a regression: the row is not migrated and must not
    // be reported as if it were.
    expect(gap.gl.events).toBe(0);
    expect(gap.migrationProgress).toBe(0);
  });
});

// ─── §6 — cross-ticket: no second journal from EITHER modern producer ─────────

describe("SCRUM-223 §6 — a modern receipt gains no second journal from legacy migration", () => {
  test("recordPayment: the legacy migration does not post a second journal", async () => {
    const { t, orgId, asUser, customerId } = await seedDealer("rp");

    const receivableId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, sourceType: "CHEQUE", title: "Receivable",
      amount: 1000, dueDate: Date.now() + 86_400_000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId, amount: 400, method: "CASH",
      paymentDate: Date.now(), idempotencyKey: "rp_pay_1",
    });

    // The modern producer posted this receipt to the GL and ALSO wrote a
    // legacy `transactions` row (collections.ts, category COLLECTION_PAYMENT).
    // The migration's dedupe probe looks for sourceType "transactions" and
    // therefore cannot see the hook's event.
    //
    // The invariant is a delta, not an absolute: the receivable lineage
    // legitimately posts its own journals, so what must be zero is the number
    // migration ADDS.
    const beforeMigration = await journalCount(t, orgId);

    await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });

    // Without retirement migration adds one: one economic receipt, two journals.
    expect(await journalCount(t, orgId)).toBe(beforeMigration);
    expect(await migratedEvents(t, orgId)).toHaveLength(0);
  });

  test("clearCheque: the legacy migration does not post a second journal", async () => {
    const { t, orgId, asUser, customerId } = await seedDealer("cc");

    const receivableId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, sourceType: "CHEQUE", title: "Cheque receivable",
      amount: 1000, dueDate: Date.now() + 86_400_000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId, customerId, bank: "ABC Bank", chequeNumber: "CHQ-223",
      chequeDate: Date.now(), amount: 1000,
    });
    await asUser.mutation(api.collections.clearCheque, {
      orgId, chequeId, idempotencyKey: `clear_${chequeId}`,
    });

    const beforeMigration = await journalCount(t, orgId);

    await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });

    // clearCheque carries the identical dual write to recordPayment, so it
    // carries the identical exposure. Both producers are covered because
    // naming only one of them is how this was missed before.
    expect(await journalCount(t, orgId)).toBe(beforeMigration);
    expect(await migratedEvents(t, orgId)).toHaveLength(0);
  });
});
