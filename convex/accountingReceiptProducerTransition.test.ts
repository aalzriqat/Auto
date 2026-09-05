/**
 * SCRUM-236 — evidence for the direct-collection producer transition.
 *
 * ## What this change actually is, and what that means for the evidence
 *
 * `recordPayment` and `clearCheque` no longer call the retired
 * `hookCollectionPayment`; they call `postReceiptOccurrence` with an identity
 * minted by `directCollectionReceipt`. The command that reaches `postOrEnqueue`
 * is UNCHANGED field for field — same event type, source type, source id,
 * occurrence version, accounting date, currency, payload and idempotency key
 * (`occurrenceIdempotencyKey` returns the legacy `collection_payment_<paymentId>`
 * bytes at occurrence 1). So the ledger effect of the happy path is identical,
 * deliberately: this ticket transfers OWNERSHIP of an occurrence identity, it
 * does not restate anything.
 *
 * ⚠️ THAT HAS A CONSEQUENCE FOR HOW THESE TESTS MAY BE READ. Because the posted
 * row is byte-identical, no assertion about that row can distinguish "the v2
 * producer wrote it" from "a legacy gross producer wrote it" — such a test would
 * pass against the defect, which is exactly the trap of an outcome-shaped
 * assertion. The defect SCRUM-236 closes is that TWO producers were
 * constructible for one identity, and that is a structural property. It is
 * therefore proved structurally:
 *
 *   - §5 asserts, from the source, that no second producer is constructible and
 *     that the identity is never cached at module scope;
 *   - the compile-time control is recorded in the PR/Jira as mutant M1 —
 *     restoring `makeCollectionHook("COLLECTION_PAYMENT", "collection_payment")`
 *     fails `tsc` with TS2345. A compile error cannot be a vitest assertion, so
 *     it is evidenced by execution rather than encoded here.
 *
 * §1–§3 are CHARACTERIZATION: they pin that the transition changed nothing
 * economically, and they would also have passed before it. They are not, and are
 * not presented as, proof that the change was made.
 *
 * §4 is the one genuinely new behavioural obligation (owner-proxy c17641
 * requirement 3), and it fails against the hazard it names — see the mutant note
 * on that block.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { directCollectionReceipt, occurrenceIdempotencyKey } from "./accounting/receiptOccurrence";
import { findPostedReceiptOccurrence } from "./accounting/workflowHooks";
import { SYSTEM_KEYS } from "./utils/defaultChart";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

type TestHarness = ReturnType<typeof convexTestWithComponents<typeof schema>>;

async function seedPostableOrg(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Producer ${suffix}`, createdAt: Date.now() })
  )) as Id<"organizations">;
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `pt_${suffix}`, email: `${suffix}@pt.com`, name: "Owner" })
  )) as Id<"users">;
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "OWNER", isSystemOwnerRole: true,
      permissions: ["view:finance", "manage:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "USD", currencySymbol: "$",
      enabledPaymentTypes: ["CASH", "CHEQUE", "BANK_TRANSFER"],
    })
  );
  const asAdmin = t.withIdentity({ subject: `pt_${suffix}`, clerkId: `pt_${suffix}` });
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });

  const year = new Date().getUTCFullYear();
  await asAdmin.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
  await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = (await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Cust", lastName: suffix, createdAt: Date.now() })
  )) as Id<"customers">;
  return { t, asAdmin, orgId, userId, customerId };
}

async function eventsFor(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
}

async function journalsFor(t: TestHarness, orgId: Id<"organizations">, sourceId: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("journalEntries")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", orgId).eq("sourceType", "collectionPayments").eq("sourceId", sourceId)
      )
      .collect()
  );
}

/**
 * Every assertion this file makes about the posted row, in one place.
 *
 * The load-bearing one is the last: `findPostedReceiptOccurrence` is the
 * CERTIFIED causal check, and it addresses the row exclusively through
 * `occurrenceIndexRange`. If the producer had drifted in any economic field, or
 * derived a different key, this resolves nothing while the row still exists —
 * which is the failure mode "one producer owns the identity" exists to prevent.
 */
async function expectSingleOwnedOccurrence(
  t: TestHarness,
  orgId: Id<"organizations">,
  paymentId: Id<"collectionPayments">
) {
  const events = await eventsFor(t, orgId);
  expect(events).toHaveLength(1);
  const row = events[0];

  const identity = directCollectionReceipt({ orgId, paymentId });
  expect(row.eventType).toBe("COLLECTION_PAYMENT");
  expect(row.sourceType).toBe("collectionPayments");
  expect(row.sourceId).toBe(paymentId.toString());
  expect(row.eventVersion).toBe(1);
  expect(row.status).toBe("POSTED");
  // Byte-identical to what the retired hook stored, so already-POSTED
  // production rows still match their own replay check.
  expect(row.idempotencyKey).toBe(occurrenceIdempotencyKey(identity));
  expect(row.idempotencyKey).toBe(`collection_payment_${paymentId}`);

  const found = await t.run((ctx) => findPostedReceiptOccurrence(ctx, identity));
  expect(found?._id).toBe(row._id);

  expect(await journalsFor(t, orgId, paymentId.toString())).toHaveLength(1);
  // Nothing queued under THIS occurrence's derived key. Addressed by the key
  // rather than by a whole-org scan, so the assertion is about this receipt
  // rather than about the org happening to be quiet.
  const queued = await t.run(async (ctx) =>
    ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_idempotency", (q) =>
        q.eq("orgId", orgId).eq("idempotencyKey", occurrenceIdempotencyKey(identity))
      )
      .collect()
  );
  expect(queued).toHaveLength(0);
  return row;
}

describe("SCRUM-236 §1 — recordPayment owns the receipt occurrence", () => {
  test("P1 — one occurrence, addressed by the certified facade, one journal", async () => {
    const { t, asAdmin, orgId, customerId } = await seedPostableOrg("p1");
    const paymentId = (await asAdmin.mutation(api.collections.recordPayment, {
      orgId, customerId, amount: 250, method: "CASH", paymentDate: Date.now(),
    })) as Id<"collectionPayments">;

    const row = await expectSingleOwnedOccurrence(t, orgId, paymentId);
    // The payload is the v1 gross shape, unchanged. SCRUM-236 moves ownership of
    // the identity; the movement/authority payload is SCRUM-218-C's change and
    // is deliberately NOT made here.
    expect(row.payload).toMatchObject({
      paymentId: paymentId.toString(),
      amountMinor: 25000,
      currency: "USD",
      customerId: customerId.toString(),
      paymentMethod: "CASH",
    });

    // POSITIVE CONTROL for §4. That test asserts these four tables are EMPTY
    // after a refusal, and "empty" only means something once it is established
    // that a successful run fills them. Without this, a mistyped table name
    // would make §4 pass vacuously — which is exactly what happened here on the
    // first draft, and what `tsc` rather than the green run caught.
    const [payments, ledger, canonical, commands] = await t.run(async (ctx) => [
      await ctx.db.query("collectionPayments").collect(),
      await ctx.db.query("transactions").collect(),
      await ctx.db.query("canonicalPayments").collect(),
      await ctx.db.query("commandIdempotency").collect(),
    ]);
    expect(payments).toHaveLength(1);
    expect(ledger).toHaveLength(1);
    expect(canonical).toHaveLength(1);
    // No idempotency key was supplied on this call, so no command record is
    // expected; §3 covers the supplied-key case, where one IS written.
    expect(commands).toHaveLength(0);
  });
});

describe("SCRUM-236 §2 — clearCheque owns the receipt occurrence", () => {
  test("P2 — a cleared cheque posts one occurrence through the same producer", async () => {
    const { t, asAdmin, orgId, customerId } = await seedPostableOrg("p2");
    const chequeId = (await asAdmin.mutation(api.collections.registerCheque, {
      orgId, customerId, bank: "Bank", chequeNumber: "C-1",
      chequeDate: Date.now(), amount: 400,
    })) as Id<"postDatedCheques">;
    const paymentId = (await asAdmin.mutation(api.collections.clearCheque, {
      orgId, chequeId,
    })) as Id<"collectionPayments">;

    const row = await expectSingleOwnedOccurrence(t, orgId, paymentId);
    // BANK_TRANSFER, not CHEQUE: a cleared cheque is money in the bank, and the
    // posting rule must resolve BANK_ACCOUNT rather than CHEQUES_IN_HAND. This
    // is carried over from the retired hook call verbatim — if the transition
    // had dropped it, the cheque would debit cheques-in-hand a second time.
    expect(row.payload).toMatchObject({
      paymentId: paymentId.toString(),
      amountMinor: 40000,
      currency: "USD",
      paymentMethod: "BANK_TRANSFER",
    });
  });
});

describe("SCRUM-236 §3 — an exact retry produces one economic occurrence", () => {
  test("P3 — replaying recordPayment under the same idempotency key posts once", async () => {
    const { t, asAdmin, orgId, customerId } = await seedPostableOrg("p3");
    const call = {
      orgId, customerId, amount: 250, method: "CASH" as const,
      paymentDate: Date.now(), idempotencyKey: "retry-me",
    };
    const first = (await asAdmin.mutation(api.collections.recordPayment, call)) as Id<"collectionPayments">;
    const second = (await asAdmin.mutation(api.collections.recordPayment, call)) as Id<"collectionPayments">;

    // The replay returns the stored result rather than minting a second receipt.
    expect(second).toBe(first);
    await expectSingleOwnedOccurrence(t, orgId, first);
    const payments = await t.run(async (ctx) => ctx.db.query("collectionPayments").collect());
    expect(payments).toHaveLength(1);
    // The other half of §4's positive control: a SUPPLIED idempotency key does
    // write a command record, and the replay reuses that one rather than
    // minting a second. So §4's "zero command records" is a real absence.
    const commands = await t.run(async (ctx) => ctx.db.query("commandIdempotency").collect());
    expect(commands).toHaveLength(1);
    expect(commands[0].status).toBe("COMPLETED");
  });
});

describe("SCRUM-236 §4 — a refusal from the receipt producer rolls the whole attempt back", () => {
  /**
   * ⚠️ THIS IS THE ONE TEST HERE THAT CAN FAIL FOR A REASON THIS TICKET
   * INTRODUCED, and it is the caller-side obligation of owner-proxy c17641
   * requirement 3 / c17631.
   *
   * `paymentId` IS the occurrence's `sourceId`, so the identity cannot exist
   * until after `ctx.db.insert("collectionPayments", …)`. "Refuse before any
   * write" is therefore structurally unavailable on the forward path, and the
   * only guarantee left is the other one the ruling allows: the refusal ESCAPES
   * the mutation. In Convex a CAUGHT exception commits the writes made before
   * it, so a try/catch around the producer call would leave the payment row, the
   * ledger transaction and the canonical payment committed while the accounting
   * refused — and report the refusal as handled.
   *
   * MUTANT M2 (run and recorded in Jira, not encoded here): wrapping the
   * `postReceiptOccurrence` call in `recordPayment` in `try { … } catch {}` makes
   * this test fail on the first four assertions below and nothing else. That is
   * what makes this a control on the hazard rather than a restatement of Convex's
   * documented behaviour.
   *
   * The lever is a realistic production cause rather than a synthetic throw: a
   * chart that is initialized but missing the CASH_ON_HAND mapping, which is
   * exactly the "System account … is not mapped" ConvexError that
   * `chartOfAccounts.ts` raises and that `workflowHooks` already documents as
   * rolling a whole completion back.
   */
  test("P4 — an unpostable chart leaves NO payment, ledger row, canonical payment or command record", async () => {
    const { t, asAdmin, orgId, customerId } = await seedPostableOrg("p4");

    // Break exactly one mapping, after the chart and period are live, so
    // `shouldPost` still says "post now" and the failure happens inside
    // postAccountingEvent — the moment the producer is reached.
    await t.run(async (ctx) => {
      const cash = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) =>
          q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.CASH_ON_HAND)
        )
        .collect();
      expect(cash.length).toBeGreaterThan(0);
      for (const account of cash) await ctx.db.delete(account._id);
    });

    await expect(
      asAdmin.mutation(api.collections.recordPayment, {
        orgId, customerId, amount: 250, method: "CASH",
        paymentDate: Date.now(), idempotencyKey: "rollback-probe",
      })
    ).rejects.toThrow(/is not mapped/);

    // Every write the handler made BEFORE reaching the producer must be gone.
    // Full scans, deliberately: this harness holds exactly one org, so a scan is
    // the exact population and cannot miss a row an index happens not to cover.
    const [payments, ledger, canonical, commands, events] = await t.run(async (ctx) => [
      await ctx.db.query("collectionPayments").collect(),
      await ctx.db.query("transactions").collect(),
      await ctx.db.query("canonicalPayments").collect(),
      await ctx.db.query("commandIdempotency").collect(),
      await ctx.db.query("accountingEvents").collect(),
    ]);
    expect(payments).toHaveLength(0);
    expect(ledger).toHaveLength(0);
    expect(canonical).toHaveLength(0);
    expect(commands).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe("SCRUM-236 §5 — structural: one constructible producer, no cached authority", () => {
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  test("S1 — no hookCollectionPayment instance survives, and the refund one does", () => {
    const hooks = read("./accounting/workflowHooks.ts");
    // The name may only appear inside comments explaining the retirement.
    expect(hooks).not.toMatch(/^\s*export const hookCollectionPayment\b/m);
    expect(hooks).toMatch(
      /^export const hookCollectionRefund = makeCollectionHook\("COLLECTION_REFUND", "collection_refund"\);/m
    );
    // The factory is preserved, and narrowed so the payment writer cannot be
    // rebuilt from it. Mutant M1 proves the narrowing is what fails the build.
    expect(hooks).toMatch(/function makeCollectionHook\(eventType: "COLLECTION_REFUND", keyPrefix: string\)/);
  });

  test("S2 — the receipt identity is built inside each handler and never cached at module scope", () => {
    const collections = read("./collections.ts");
    const constructions = collections.match(/directCollectionReceipt\(/g) ?? [];
    // Exactly the two producers this ticket rewires: recordPayment, clearCheque.
    expect(constructions).toHaveLength(2);

    // A module-scope binding would keep a trusted identity alive for the whole
    // module's lifetime — the WeakSet backing `assertTrustedOccurrence` is
    // module-lifetime, not invocation-lifetime — so a later invocation in the
    // same isolate could address an occurrence it never earned (c17641 req 1).
    // A top-level binding is one that starts at column 0.
    expect(collections).not.toMatch(/^(const|let|var)\s+\w+\s*=\s*directCollectionReceipt/m);

    // And no caller may hand an identity in from outside: neither mutation takes
    // one as an argument, so a forged value has no route to this boundary at all.
    expect(collections).not.toMatch(/identity:\s*v\./);
  });

  test("S3 — no OTHER site can address this occurrence identity as a forward producer", () => {
    // Enumeration by SPACE rather than by name: anything that writes this
    // occurrence must name `collectionPayments` as an accounting sourceType.
    // Two non-test sites do, and both are in the cheque-return REVERSAL path
    // (SCRUM-130's territory) rather than forward producers. The third is the
    // shared collection factory, which can now only mint COLLECTION_REFUND.
    const collections = read("./collections.ts");
    const forwardProducers = collections.match(/sourceType:\s*"collectionPayments"/g) ?? [];
    expect(forwardProducers).toHaveLength(1); // the deferred reversal enqueue
    expect(collections).toMatch(/enqueuePendingReversal\(ctx, \{[\s\S]{0,400}sourceType: "collectionPayments"/);
  });
});
