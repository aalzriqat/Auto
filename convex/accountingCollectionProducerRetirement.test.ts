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
 *  §3  The retired producer mints no COLLECTION_PAYMENT authority at all.
 *  §6  Cross-ticket: a modern receipt from EITHER collection producer does not
 *      gain a second journal when the legacy migration subsequently runs.
 *  §7  Dry-run creates no migration/accounting economic effect. It is NOT
 *      claimed to write nothing — `requireTenantAuth` runs first and may
 *      legitimately write a security audit row.
 *  §9  The returned `retired` counter is truthful.
 *  §10 `migrationGapAnalysis.migrationProgress` is depressed by a retired row.
 *
 * §5 of the contract — "retirement is not migration proof and not sign-off
 * proof" — is NOT evidenced in this file. It lives in
 * `accountingPhase17.test.ts:360`, which runs the migration to completion,
 * asserts `retired: 1 / posted: 0`, and then asserts `signOffCutover` still
 * refuses. An earlier revision of this header listed §5 here and omitted §3,
 * which described neither file accurately.
 *
 * ⚠️ On §10, precisely. `migrationGapAnalysis` does NOT filter on POSTED:
 * `glEventCount` counts events sourced from `transactions` at any status
 * (`accountingMigration.ts:275-282`), and `migrationProgress` rounds and is
 * capped at 100. So a retired row lowers the ratio but does not guarantee a
 * sub-100 reading — 999 migrated rows beside one retired row still round to
 * 100. The §10 test below pins the single-row case only, and must not be read
 * as proving a general "cannot reach 100%" property. `signOffCutover` is the
 * one that filters `status === "POSTED"` (`accountingCutover.ts:824-827`);
 * these two counts are deliberately different and only one is a gate.
 *
 * ⚠️ On the §6 tests specifically. An earlier revision asserted only that the
 * migration added no journal (a before/after delta). Codex refuted that as
 * vacuous: the delta also holds if the modern producer posts nothing, or if it
 * stops writing its legacy row so migration never scans it. A regression in the
 * precondition would have gone undetected. Each §6 test now proves the whole
 * causal chain — the named producer posted exactly one receipt event with a
 * journal, wrote exactly one legacy COLLECTION_PAYMENT row, and migration
 * classified THAT EXACT row as retired and added nothing.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

/** Resolves the harness generics concretely so no helper needs `any`. */
const makeHarness = () => convexTestWithComponents(schema, MODULE_GLOB);
type Harness = ReturnType<typeof makeHarness>;

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:expenses", "create:expenses", "edit:expenses",
  "manage:finance", "view:finance",
  "view:customers", "create:customers",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "approve:requests",
];

async function seedDealer(tag: string) {
  const t = makeHarness();
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

/** Derived from the schema so this test cannot drift from the real category set. */
type LegacyCategory = Doc<"transactions">["category"];

/** Legacy `transactions` row, inserted directly — the shape migration scans. */
async function seedLegacyRow(
  t: Harness,
  orgId: Id<"organizations">,
  category: LegacyCategory,
  opts: { type?: "IN" | "OUT"; amount?: number; description?: string } = {}
) {
  return t.run((ctx) =>
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
function rowFor<R extends { transactionId: string }>(results: R[], transactionId: string): R {
  const row = results.find((r) => r.transactionId === transactionId);
  if (!row) throw new Error(`no migration result row for transaction ${transactionId}`);
  return row;
}

async function journalCount(t: Harness, orgId: Id<"organizations">) {
  const rows = await t.run((ctx) =>
    ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
  return rows.length;
}

/** Accounting events minted from the legacy `transactions` table specifically. */
async function migratedEvents(t: Harness, orgId: Id<"organizations">) {
  return t.run((ctx) =>
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "transactions"))
      .collect()
  );
}

/** Every legacy `transactions` row in the org carrying the given category. */
async function legacyRowsWithCategory(t: Harness, orgId: Id<"organizations">, category: LegacyCategory) {
  const rows = await t.run((ctx) =>
    ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
  return rows.filter((r) => r.category === category);
}

/**
 * Proves the modern producer really did originate the receipt, and originated
 * it exactly once: one POSTED COLLECTION_PAYMENT event sourced from
 * `collectionPayments/<paymentId>`, and exactly ONE journal, which is the one
 * that event names.
 *
 * `journalsBefore` is the org's journal count captured immediately before the
 * producer ran. Asserting the +1 is what closes the last vacuity: checking only
 * that one *event* exists would still pass if the producer emitted a second
 * journal for the same receipt, because that duplicate would land in the
 * migration baseline and the later delta would stay flat.
 */
async function assertModernReceiptPosted(
  t: Harness,
  orgId: Id<"organizations">,
  paymentId: string,
  journalsBefore: number
) {
  const events = await t.run((ctx) =>
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", orgId).eq("sourceType", "collectionPayments").eq("sourceId", paymentId)
      )
      .collect()
  );
  expect(events).toHaveLength(1);
  const event = events[0];
  expect(event.eventType).toBe("COLLECTION_PAYMENT");
  expect(event.status).toBe("POSTED");
  expect(event.journalEntryId).toBeTruthy();

  // The producer added exactly one journal — not zero, and not two.
  expect(await journalCount(t, orgId)).toBe(journalsBefore + 1);

  // And exactly one journal is linked to that event, and it is the one the
  // event points at. `by_accounting_event` is not a unique index (Convex has
  // none), so this is a real assertion rather than a restatement of the schema.
  const linked = await t.run((ctx) =>
    ctx.db
      .query("journalEntries")
      .withIndex("by_accounting_event", (q) => q.eq("accountingEventId", event._id))
      .collect()
  );
  expect(linked).toHaveLength(1);
  expect(linked[0]._id).toBe(event.journalEntryId);
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

    const auditByTx = new Map(audit.rows.map((r) => [r.id, r.disposition]));
    expect(auditByTx.size).toBe(3);

    // Pin the disposition VALUES, not merely their agreement. Before
    // `disposition` existed on either side, the row-for-row loop below
    // compared `undefined` with `undefined` and passed — a parity assertion
    // inherits nothing if both sides are permitted to be empty. These three
    // values are exactly the three seeded categories: EXPENSE -> MAPPED,
    // CLAIM_PAYMENT -> UNMAPPED, COLLECTION_PAYMENT -> RETIRED_COLLECTION.
    expect([...auditByTx.values()].sort()).toEqual([
      "MAPPED",
      "RETIRED_COLLECTION",
      "UNMAPPED",
    ]);

    expect(migration.results).toHaveLength(3);
    for (const r of migration.results) {
      expect(r.disposition).toBeDefined();
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

    const retiredRows = result.results.filter((r) => r.disposition === "RETIRED_COLLECTION");
    expect(result.retired).toBe(retiredRows.length);
    expect(result.retired).toBe(1);
    expect(result.posted).toBe(1); // the EXPENSE row still migrates
  });

  test("a retired row already carrying a pre-fix event stays classified retired, and says why it was skipped", async () => {
    const { t, orgId, userId, asUser } = await seedDealer("hist");
    const txId = await seedLegacyRow(t, orgId, "COLLECTION_PAYMENT");

    // Simulates the historical artefact of the very defect this ticket fixes:
    // a legacy collection row that the PRE-FIX migration already posted.
    await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId,
        eventType: "COLLECTION_PAYMENT",
        sourceType: "transactions",
        sourceId: txId.toString(),
        eventVersion: 1,
        accountingDate: Date.now(),
        occurredAt: Date.now(),
        currency: "JOD",
        idempotencyKey: `migrate_${txId}`,
        payload: {},
        status: "POSTED",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    const result = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });
    const row = rowFor(result.results, txId.toString());

    // Classification is computed for every scanned row, so the disposition
    // stays truthful even when the row short-circuits on already_posted.
    // `retired` therefore counts "rows classified retired", which includes this
    // one — pinned here so the counter's meaning is evidence, not inference.
    expect(row.disposition).toBe("RETIRED_COLLECTION");
    expect(row.action).toBe("SKIP");
    expect(row.reason).toBe("already_posted");
    expect(result.retired).toBe(1);
    expect(result.posted).toBe(0);
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
    // `migrationProgress` counts events sourced from `transactions` at ANY
    // status — there is no POSTED filter (accountingMigration.ts:275-282).
    // A retired row never becomes one, so for this single-row org progress
    // stays at 0: the row is not migrated and must not be reported as if it
    // were.
    //
    // SCOPE — this pins the single-row case ONLY. `migrationProgress` rounds
    // and is capped at 100, so it is not a general detector of retired rows
    // and this test must not be cited as proving one. See the file header.
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

    // Captured before the producer runs so its journal cardinality can be
    // asserted exactly, not just its existence.
    const journalsBeforeProducer = await journalCount(t, orgId);

    const paymentId = await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId, amount: 400, method: "CASH",
      paymentDate: Date.now(), idempotencyKey: "rp_pay_1",
    });

    // PRECONDITION 1 — the modern producer really originated this receipt, and
    // originated it exactly once. Without this the delta below is vacuous: it
    // also holds when the producer posts nothing, and when it posts twice.
    await assertModernReceiptPosted(t, orgId, paymentId.toString(), journalsBeforeProducer);

    // PRECONDITION 2 — and it also wrote the legacy row that migration scans
    // (collections.ts, category COLLECTION_PAYMENT). Without this, migration
    // would have nothing to examine and the delta would hold for the wrong
    // reason.
    const legacyRows = await legacyRowsWithCategory(t, orgId, "COLLECTION_PAYMENT");
    expect(legacyRows).toHaveLength(1);
    const legacyId = legacyRows[0]._id.toString();

    const beforeMigration = await journalCount(t, orgId);

    const migration = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });

    // THE CLAIM — migration examined THAT EXACT row and retired it.
    const row = rowFor(migration.results, legacyId);
    expect(row.disposition).toBe("RETIRED_COLLECTION");
    expect(row.action).toBe("SKIP");
    expect(row.eventType).toBeNull();
    expect(migration.retired).toBe(1);
    expect(migration.posted).toBe(0);

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
    const journalsBeforeProducer = await journalCount(t, orgId);

    const paymentId = await asUser.mutation(api.collections.clearCheque, {
      orgId, chequeId, idempotencyKey: `clear_${chequeId}`,
    });

    // clearCheque carries the identical dual write to recordPayment, so it
    // carries the identical exposure — and therefore owes the identical
    // preconditions. Naming only one of the two producers is how this was
    // missed before.
    await assertModernReceiptPosted(t, orgId, paymentId.toString(), journalsBeforeProducer);

    const legacyRows = await legacyRowsWithCategory(t, orgId, "COLLECTION_PAYMENT");
    expect(legacyRows).toHaveLength(1);
    const legacyId = legacyRows[0]._id.toString();

    const beforeMigration = await journalCount(t, orgId);

    const migration = await asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, {
      orgId, dryRun: false, limit: 10,
    });

    const row = rowFor(migration.results, legacyId);
    expect(row.disposition).toBe("RETIRED_COLLECTION");
    expect(row.action).toBe("SKIP");
    expect(row.eventType).toBeNull();
    expect(migration.retired).toBe(1);
    expect(migration.posted).toBe(0);

    expect(await journalCount(t, orgId)).toBe(beforeMigration);
    expect(await migratedEvents(t, orgId)).toHaveLength(0);
  });
});

// ─── Sonnet F2 — the retirement is enforced at the posting chokepoint too ─────

describe("SCRUM-223 — COLLECTION_PAYMENT from `transactions` is refused at the posting engine", () => {
  test("the forbidden (eventType, sourceType) pair cannot post, whatever calls it", async () => {
    const { orgId, asUser } = await seedDealer("choke");
    const now = Date.now();

    // The type narrowing in accountingMigration.ts protects one file's flow.
    // PostCommand.eventType is a bare `string`, so any other caller can still
    // construct this pair — `accountingLedger.post` takes arbitrary strings.
    // SCRUM-51 learned the same lesson the hard way and put its retirement at
    // the posting engine, which every ORIGINATING path reaches. (Reversal rows
    // are inserted directly by reversals.ts and deliberately bypass it, so a
    // historical migration-sourced event stays reversible.)
    await expect(
      asUser.mutation(internal.accountingLedger.post, {
        orgId,
        eventType: "COLLECTION_PAYMENT",
        sourceType: "transactions",
        sourceId: "forged_tx_1",
        eventVersion: 1,
        accountingDate: now,
        occurredAt: now,
        currency: "JOD",
        idempotencyKey: "forged_migrate_1",
        payload: { paymentId: "forged_tx_1", amountMinor: 10_000, currency: "JOD", paymentMethod: "CASH" },
      })
    ).rejects.toThrow(/retired/i);
  });

  test("the legitimate modern producer is untouched by that refusal", async () => {
    const { t, orgId, asUser, customerId } = await seedDealer("choke2");

    const receivableId = await asUser.mutation(api.collections.createReceivable, {
      orgId, customerId, sourceType: "CHEQUE", title: "Receivable",
      amount: 1000, dueDate: Date.now() + 86_400_000,
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const journalsBeforeProducer = await journalCount(t, orgId);

    const paymentId = await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId, amount: 250, method: "CASH",
      paymentDate: Date.now(), idempotencyKey: "choke2_pay",
    });

    // The guard is scoped to the (eventType, sourceType) PAIR, not the event
    // type alone — COLLECTION_PAYMENT sourced from `collectionPayments` is the
    // live, correct producer and must keep posting.
    await assertModernReceiptPosted(t, orgId, paymentId.toString(), journalsBeforeProducer);
  });
});
