import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * SCRUM-121 — PRIORITY-1 PATH × INPUT-SHAPE MATRIX (round 2). Measurement only.
 *
 * Authorized by AF30-D009 (SCRUM-121 c12522), which supersedes AF30-D007 for
 * this file. TESTS ONLY — no production code, no schema, no `convex/subledger.ts`.
 * Run against clean `main` @ 4e357587818f16c2a4be8e83028ca795fa71b053 so every
 * cell measures the BASE, never a fix. Do not extend into a fix.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY ROUND 2 EXISTS — the round-1 defect, named
 * ─────────────────────────────────────────────────────────────────────────────
 * Round 1 asserted OUTCOMES on cells whose contract clause is a REFUSAL. A cell
 * like "the unrelated sale is not stamped on the payment record" goes green
 * under a fix that silently discards the caller's contradictory `saleId` and
 * moves the money anyway — which is precisely what §3 forbids. An outcome
 * assertion cannot evidence a fail-closed rule. Round 2 asserts ATOMIC REFUSAL
 * on every contradictory shape: the mutation throws and NOTHING survives.
 *
 * Round 1 also wrote "either location is acceptable, just not both" (old A6).
 * An assertion that admits two outcomes cannot distinguish them, and on `main`
 * it certifies the duplicate authority SCRUM-56 exists to retire. Round 2 names
 * the exact permitted target for every shape.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT v2 (owner rules as amended by AF30-D009 §1–§2)
 * ─────────────────────────────────────────────────────────────────────────────
 * R1  Every DEBT-DIRECTED movement resolves exactly ONE canonical debt target
 *     before it allocates money or updates an operational mirror. The
 *     unallocated receipt (R6) is an explicit NON-DEBT variant of the movement
 *     result — not an exception carved out of R1.
 *
 * R2  The one permitted target, by shape. No "either location" anywhere:
 *
 *       standalone row only        -> that row's own canonical document
 *       sale only                  -> the sale's canonical invoice
 *       sale-linked row only       -> the sale's canonical invoice
 *       correlated row + sale      -> the sale's canonical invoice
 *                                     (the row is SOURCE LINEAGE / mirror
 *                                      context only, never a second target)
 *
 * R3  Contradictory target candidates FAIL CLOSED, ATOMICALLY. Silently
 *     discarding one reference is not a resolution — a contradictory pair is
 *     refused, never reconciled by preference.
 *
 * R4  Provenance (sale, customer, vehicle) derives from the VERIFIED TARGET.
 *     Independent fallback expressions are the named anti-pattern:
 *       `receivable?.saleId ?? args.saleId`   collections.ts:850  (cash)
 *       `receivable?.saleId ?? args.saleId`   collections.ts:986  (cheque)
 *
 * R5  ALL supplied target candidates AND payer identity must resolve to one
 *     org-scoped canonical debt and one payer, or fail closed AT THE BOUNDARY
 *     THAT ACCEPTS THEM. Failing later — after a provider has confirmed funds —
 *     is not fail-closed.
 *
 * R6  S1 (no debt named) is an UNALLOCATED RECEIPT:
 *       targetDocumentId = null · appliedMinor = 0 ·
 *       unappliedMinor = requestedMinor · no allocation ·
 *       no receivable/status/aging mutation · no invented sale or receivable
 *       provenance · visible to cash/bank reconciliation ·
 *       NEVER presented as paying AR.
 *     Building a later-application workflow is explicitly out of scope here.
 *
 * EXPLICIT NON-DEPENDENCY (AF30-D009 §1): SCRUM-121 does NOT rely on
 * `cancelSaleReceivableIfSafe` refusing a sale cancellation. That refusal is not
 * a property of clean `main` — see SCRUM-123 and cell X6a below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INPUT SHAPES (axis extended per AF30-D009 §5)
 * ─────────────────────────────────────────────────────────────────────────────
 *   S1   neither receivableId nor saleId
 *   S2   saleId only
 *   S3   STANDALONE receivableId only (the row carries no saleId)
 *   S4   SALE-LINKED receivableId only (the row carries a saleId; caller does not)
 *   S5   correlated receivableId + saleId
 *   S6   UNRELATED receivableId + saleId          <- the shape that fired the breaker
 *   S7   receivableDocumentId only                <- direct canonical target
 *   S8   receivableDocumentId + MISMATCHING receivableId
 *   S9   receivableDocumentId + MISMATCHING saleId
 *   S10  all three, mutually CONSISTENT
 *   S11  receivableDocumentId belonging to a DIFFERENT PAYER (same org)
 *   S12  receivableDocumentId belonging to a DIFFERENT ORG (cross-tenant)
 *   S13  DANGLING receivableDocumentId (target deleted)
 *   S14  CANCELLED receivableDocumentId
 *
 * S7–S14 exist because of ChatGPT DESIGN finding F3, which corrected my own
 * scope analysis: I had recorded `paymentIntents.create` as taking `receivableId`
 * and `saleId` as independent optionals and MISSED `receivableDocumentId`
 * entirely — a third, DIRECT target candidate that bypasses both the row and the
 * sale. `customerId` is also REQUIRED there, so every call supplies a payer and
 * nothing proves the payer matches the resolved debt. Round 1 used one customer
 * throughout, so payer mismatch was never exercised at all.
 *
 * PATHS
 *   P1   collections.recordPayment            (cash)
 *   P2a  collections.registerCheque           (cheque, register-time)
 *   P2b  collections.clearCheque              (cheque, clear-time revalidation)
 *   P3a  paymentIntents.create                (payment link, create-time)
 *   P3b  paymentIntents.markSettled           (payment link, settlement-time)
 *   P8   sales.update -> CANCELLED            (cancellation interaction)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BASE-STATE ASSUMPTIONS (AF30-D009 §1, final bullet)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every cell below carries a `BASE:` note naming the state of `main` its meaning
 * depends on. This requirement came out of two cells that each meant something
 * other than they appeared to:
 *
 *   X6a was measured on a PATCHED branch (#241) and reported a refusal that was
 *       the patch's routing, not the path's behaviour.
 *   A6  was measured ON TOP OF AN UNPATCHED DEFECT (SCRUM-109: every hand-keyed
 *       receivable raises a canonical twin unconditionally). Its whole
 *       two-representation premise IS that defect's shape.
 *
 * Same lesson running both directions: a cell whose meaning rests on a state
 * nobody wrote down is not evidence. So it gets written down.
 *
 * NOT ASSERTED ANYWHERE HERE: any verdict about a path or shape this file does
 * not measure. Priority 2–4 remain explicitly UNMEASURED and are not filled
 * speculatively.
 *
 * NO MUTATION TESTING IN THIS ROUND, and the reason is a constraint not an
 * omission: mutation testing proves a fixture can fail by breaking the source,
 * and D009 prohibits touching production code. Non-vacuity is instead argued
 * per green cell from the observed values (a green that reports
 * `allocationCount: 1` and an exact minor amount cannot have passed on an empty
 * world). Real mutation testing belongs to the implementation round.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:sales", "edit:sales", "view:sales", "edit:vehicles", "view:vehicles",
  "approve:requests", "manage:finance", "view:finance",
  "register:vehicle_handover", "register:expected_payment",
  // Deliberate: `notifyManagers` only dispatches to roles holding manage:users.
  // Without it the "no notification survived" assertions below would pass
  // vacuously — a fixture that cannot fail is worse than no fixture.
  "manage:users",
];

const SALE_PRICE = 22000;
const MINOR = 1000; // JOD, scale 3
const PAY = 8000;

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Shape Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "sh_u", email: "u@t.com", name: "U" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "sh_a", email: "a@t.com", name: "A" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Nora", lastName: "Khaled" })
  );
  return {
    t, orgId, userId, approverId, customerId,
    asUser: t.withIdentity({ subject: "sh_u", clerkId: "sh_u" }),
    asApprover: t.withIdentity({ subject: "sh_a", clerkId: "sh_a" }),
  };
}

/** A second payer in the SAME org — for the S11 payer-mismatch shape. */
async function secondCustomer(t: any, orgId: any) {
  return await t.run((ctx: any) =>
    ctx.db.insert("customers", { orgId, firstName: "Omar", lastName: "Saeed" })
  );
}

/** A completed sale, and therefore a canonical sale invoice. */
async function completedSale(t: any, asUser: any, orgId: any, customerId: any, vin: string) {
  const vehicleId = await t.run((ctx: any) =>
    ctx.db.insert("vehicles", {
      orgId, vin, make: "Mazda", model: "CX-5", year: 2023, color: "Red",
      fuelType: "Gasoline", transmission: "Automatic", mileage: 500,
      sellingPrice: SALE_PRICE, status: "AVAILABLE",
    })
  );
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, customerId, vehicleId, vehiclePrice: SALE_PRICE, downPayment: 0, termMonths: 0,
  });
  const ids = await asUser.mutation(api.sales.completeFromQuote, { orgId, quoteId });
  const saleId = (Array.isArray(ids) ? ids[0] : ids) as Id<"sales">;
  const invoiceId = await t.run(async (ctx: any) => (await ctx.db.get(saleId)).canonicalReceivableDocumentId);
  return { saleId, invoiceId, vehicleId };
}

/**
 * A STANDALONE hand-keyed row — deliberately no saleId.
 *
 * `creditSystemKey` is REQUIRED here and is itself a measured fact about the
 * shape: `createReceivable:639` derives the credit account from `args.saleId`
 * when present, and otherwise demands an explicit key. So a standalone row is
 * constructable, but only by naming its own income/liability account — the
 * sale-linked shape never has to. Recorded because "the standalone shape is
 * harder to construct than the sale-linked one" is exactly the kind of asymmetry
 * that keeps a shape out of a fixture matrix. It cost round 1 five false reds.
 */
async function standaloneRow(asUser: any, orgId: any, customerId: any, amount = PAY) {
  return await asUser.mutation(api.collections.createReceivable, {
    orgId, customerId, sourceType: "INTERNAL_INSTALLMENT",
    title: "Standalone", amount, dueDate: Date.now() + 86_400_000,
    creditSystemKey: "MISCELLANEOUS_INCOME",
  });
}

/** A hand-keyed row CORRELATED to a sale (carries that sale's id). */
async function saleLinkedRow(asUser: any, orgId: any, customerId: any, saleId: any, amount = PAY) {
  return await asUser.mutation(api.collections.createReceivable, {
    orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
    title: "Correlated", amount, dueDate: Date.now() + 86_400_000,
  });
}

const rowTwinOf = (t: any, rowId: any) =>
  t.run(async (ctx: any) => (await ctx.db.get(rowId))?.canonicalReceivableDocumentId ?? null);

/**
 * Exact-target reading: how much ACTIVE allocation sits on each named document,
 * plus the provenance the operational mirror claims.
 */
async function targets(t: any, opts: { invoiceId?: any; rowId?: any }) {
  return await t.run(async (ctx: any) => {
    const allocations = (await ctx.db.query("paymentAllocations").collect())
      .filter((a: any) => a.status === "ACTIVE");
    const row = opts.rowId ? await ctx.db.get(opts.rowId) : null;
    const rowTwinId = row?.canonicalReceivableDocumentId ?? null;
    const payments = await ctx.db.query("collectionPayments").collect();
    const onDoc = (docId: any) =>
      docId
        ? allocations
            .filter((a: any) => String(a.receivableDocumentId) === String(docId))
            .reduce((s: number, a: any) => s + a.amountMinor, 0)
        : 0;
    return {
      onSaleInvoiceMinor: onDoc(opts.invoiceId),
      onRowTwinMinor: onDoc(rowTwinId),
      allocationCount: allocations.length,
      rowOutstanding: row?.outstandingAmount ?? null,
      rowStatus: row?.status ?? null,
      mirrorSaleIds: payments.map((p: any) => (p.saleId ? String(p.saleId) : null)),
      mirrorAmounts: payments.map((p: any) => p.amount),
      mirrorCount: payments.length,
    };
  });
}

/**
 * Every table a money movement writes. R3 says a contradictory shape is refused
 * ATOMICALLY, so the assertion is a whole-world delta of exactly zero — not
 * "the wrong sale was not stamped", which a silent-discard fix would satisfy
 * while still moving the money.
 */
const TOUCHED_TABLES = [
  "collectionPayments", "canonicalPayments", "paymentAllocations",
  "transactions", "notifications", "postDatedCheques", "paymentIntents",
  "accountingEvents", "journalEntries", "journalLines", "receivableDocuments",
] as const;

async function worldSnapshot(t: any, rowId?: any) {
  return await t.run(async (ctx: any) => {
    const counts: Record<string, number> = {};
    for (const table of TOUCHED_TABLES) {
      counts[table] = (await ctx.db.query(table as any).collect()).length;
    }
    const row = rowId ? await ctx.db.get(rowId) : null;
    return {
      counts,
      row: row
        ? {
            outstandingAmount: row.outstandingAmount,
            status: row.status,
            lastPaymentAt: row.lastPaymentAt ?? null,
            updatedAt: row.updatedAt ?? null,
          }
        : null,
    };
  });
}

/** Only what actually moved — an empty object is the atomicity proof. */
function worldDelta(before: any, after: any) {
  const delta: Record<string, unknown> = {};
  for (const table of TOUCHED_TABLES) {
    if (before.counts[table] !== after.counts[table]) {
      delta[table] = `${before.counts[table]} -> ${after.counts[table]}`;
    }
  }
  if (JSON.stringify(before.row) !== JSON.stringify(after.row)) {
    delta.legacyRow = { before: before.row, after: after.row };
  }
  return delta;
}

async function capture(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e: any) {
    return String(e?.data ?? e?.message ?? e);
  }
}

/**
 * R5 says a bad reference fails closed AT THE BOUNDARY THAT ACCEPTS IT. When a
 * cell asserts create-time refusal, "settlement is unreachable" is part of the
 * assertion — so if create DOES accept, this measures what settlement then does
 * rather than leaving it as a claim. Round 1's lesson applies to my own prose as
 * much as to a reviewer's: an unmeasured consequence is not a finding.
 */
async function settleAndDescribe(t: any, asUser: any, orgId: any, intentId: any) {
  if (!intentId) return "unreachable";
  const threw = await capture(() =>
    asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId })
  );
  if (threw) return `create ACCEPTED, settlement THREW: ${threw}`;
  const observed = await t.run(async (ctx: any) => {
    const intent = await ctx.db.get(intentId);
    const active = (await ctx.db.query("paymentAllocations").collect())
      .filter((a: any) => a.status === "ACTIVE");
    const canonical = await ctx.db.query("canonicalPayments").collect();
    return {
      status: intent?.status,
      activeAllocations: active.length,
      canonicalPayments: canonical.length,
    };
  });
  return `create ACCEPTED, settlement SUCCEEDED: status=${observed.status} activeAllocations=${observed.activeAllocations} canonicalPayments=${observed.canonicalPayments}`;
}

/**
 * R6 reading for an unallocated receipt: what the canonical layer holds for a
 * movement that named no debt. `unappliedMinor` is derived, exactly as
 * `subledger.getPaymentUnappliedMinor` derives it.
 */
async function receiptShape(t: any) {
  return await t.run(async (ctx: any) => {
    const payments = await ctx.db.query("canonicalPayments").collect();
    const allocations = (await ctx.db.query("paymentAllocations").collect())
      .filter((a: any) => a.status === "ACTIVE");
    const mirrors = await ctx.db.query("collectionPayments").collect();
    const applied = allocations.reduce((s: number, a: any) => s + a.amountMinor, 0);
    const received = payments.reduce((s: number, p: any) => s + p.amountMinor, 0);
    return {
      canonicalPaymentCount: payments.length,
      receivedMinor: received,
      appliedMinor: applied,
      unappliedMinor: received - applied,
      allocationCount: allocations.length,
      // R6: no invented provenance.
      inventedSaleIds: mirrors.filter((m: any) => m.saleId).length,
      inventedReceivableIds: mirrors.filter((m: any) => m.receivableId).length,
      // R6: visible to cash/bank reconciliation.
      cashflowRows: (await ctx.db.query("transactions").collect()).length,
    };
  });
}

describe("SCRUM-121 Priority-1 round 2 — path × input shape, measured on clean main", () => {
  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 1 — R3 fail-closed cells. ATOMIC REFUSAL is the assertion.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * BASE: a standalone row's canonical twin exists because SCRUM-109 raises one
   * unconditionally. The refusal asserted here is a property of the CALL SHAPE,
   * not of the twin, so this cell survives a SCRUM-109 fix.
   */
  test("A2 · P1×S6 · cash: contradictory row+sale is refused atomically", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000001");
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const before = await worldSnapshot(t, rowId);
    const refused = await capture(() =>
      asUser.mutation(api.collections.recordPayment, {
        orgId, receivableId: rowId, saleId, amount: PAY,
        method: "CASH", paymentDate: Date.now(),
      })
    );
    const after = await worldSnapshot(t, rowId);

    // R3 — nothing survives: no mirror row, no canonical payment, no allocation,
    // no GL transaction, no notification, and the legacy row is untouched.
    expect({ refused: refused !== null, delta: worldDelta(before, after) }).toEqual({
      refused: true, delta: {},
    });
  });

  /**
   * BASE: as A2. `registerChequeCore:964` already refuses a customer mismatch,
   * so a refusal here would be a SHAPE refusal, not a payer refusal.
   */
  test("A3a · P2a×S6 · cheque register: contradictory row+sale is refused atomically", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000002");
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const before = await worldSnapshot(t, rowId);
    const refused = await capture(() =>
      asUser.mutation(api.collections.registerCheque, {
        orgId, receivableId: rowId, customerId, saleId,
        bank: "ABC", chequeNumber: "CQ-A3A", chequeDate: Date.now(), amount: PAY,
      })
    );
    const after = await worldSnapshot(t, rowId);

    expect({ refused: refused !== null, delta: worldDelta(before, after) }).toEqual({
      refused: true, delta: {},
    });
  });

  /**
   * Clear-time REVALIDATION after post-registration drift (AF30-D009 §3).
   *
   * BASE: registration is assumed to succeed — which is only true because A3a
   * is red on `main`. If A3a is ever fixed, THIS cell becomes unconstructable
   * and that is the correct outcome, not a regression.
   *
   * READ THE REASON, NOT THE COLOUR: `clearCheque:1109` refuses because
   * `cheque.amount > receivable.outstandingAmount` — an AMOUNT check. Nothing
   * here re-resolves the TARGET. A green cell means the observable the contract
   * asks for happens to hold; it does not mean clear-time target revalidation
   * exists. Constructing a drift that moves the target without moving the
   * amount would very likely go red, and is NOT measured here.
   */
  test("A3b · P2b×S6 · cheque clear: revalidated after drift, refused atomically", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000003");
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId, saleId,
      bank: "ABC", chequeNumber: "CQ-A3B", chequeDate: Date.now(), amount: PAY,
    });

    // DRIFT: the row is settled through another channel between register and clear.
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowId, amount: PAY, method: "CASH", paymentDate: Date.now(),
    });

    const before = await worldSnapshot(t, rowId);
    const refused = await capture(() =>
      asUser.mutation(api.collections.clearCheque, { orgId, chequeId })
    );
    const after = await worldSnapshot(t, rowId);
    const chequeStatus = await t.run(async (ctx: any) => (await ctx.db.get(chequeId)).status);

    expect({
      refused: refused !== null,
      delta: worldDelta(before, after),
      chequeStatus,
    }).toEqual({ refused: true, delta: {}, chequeStatus: "HELD" });
  });

  /** BASE: as A2. */
  test("A1a · P3a×S6 · payment link create: contradictory row+sale is refused atomically", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000004");
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const before = await worldSnapshot(t, rowId);
    const refused = await capture(() =>
      asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableId: rowId, saleId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a1a",
      })
    );
    const after = await worldSnapshot(t, rowId);

    expect({ refused: refused !== null, delta: worldDelta(before, after) }).toEqual({
      refused: true, delta: {},
    });
  });

  /**
   * Settlement-time REVALIDATION after drift (AF30-D009 §3).
   *
   * BASE: creation is assumed to succeed — only true because A1a is red.
   *
   * DESIGN TENSION, recorded not resolved: `paymentIntents.ts:107-114` argues
   * the opposite of an atomic throw here — the provider has already confirmed
   * the funds, so a throw rolls back the settlement AND the canonical payment,
   * and the provider's retries hit the same throw, losing the money outright.
   * D009 §3 directs "both atomic", so atomic refusal is what this cell asserts.
   * Whether atomic refusal or an explicit unallocated receipt is the right
   * answer at THIS boundary is a DESIGN question, not mine to settle in a
   * fixture. Flagged for the DESIGN review.
   */
  test("A1b · P3b×S6 · payment link settle: revalidated after drift, refused atomically", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000005");
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId: rowId, saleId,
      amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a1b",
    });

    // DRIFT: the row is settled through another channel before the link settles.
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowId, amount: PAY, method: "CASH", paymentDate: Date.now(),
    });

    const before = await worldSnapshot(t, rowId);
    const refused = await capture(() =>
      asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId })
    );
    const after = await worldSnapshot(t, rowId);
    const intentStatus = await t.run(async (ctx: any) => (await ctx.db.get(intentId)).status);

    expect({
      refused: refused !== null,
      delta: worldDelta(before, after),
      intentStatus,
    }).toEqual({ refused: true, delta: {}, intentStatus: "PENDING" });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 2 — R2 exact-target cells. The ONE permitted target, named.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * BASE: the row's own canonical twin is SCRUM-109's unconditional twin. Under
   * R2 a standalone row's target IS that twin, so a SCRUM-109 fix that stops
   * raising twins would change what "the row's own document" means and this
   * cell would need re-deriving.
   */
  test("A4 · P3×S3 · standalone row only settles that row's own document, exactly", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000006");
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId: rowId,
      amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a4",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const state = await targets(t, { invoiceId, rowId });
    expect({
      onRowTwin: state.onRowTwinMinor,
      onSaleInvoice: state.onSaleInvoiceMinor,
      allocationCount: state.allocationCount,
    }).toEqual({ onRowTwin: PAY * MINOR, onSaleInvoice: 0, allocationCount: 1 });
  });

  /**
   * BASE: an INDEPENDENT RERUN, per AF30-D009 §6. Round 1 reported this cell
   * red; AF-30 confirmed the assertion is well-formed by reading it, and noted
   * that an assertion read is not a run observed. So it is re-run here rather
   * than carried forward by inference.
   */
  test("A5 · P3×S2 · sale only settles that sale's canonical invoice, exactly", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000007");

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, saleId,
      amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a5",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const state = await targets(t, { invoiceId });
    expect({
      onSaleInvoice: state.onSaleInvoiceMinor,
      allocationCount: state.allocationCount,
    }).toEqual({ onSaleInvoice: PAY * MINOR, allocationCount: 1 });
  });

  /**
   * REPLACES round-1 A6, which asserted "either location, just not both" and
   * therefore certified the duplicate authority SCRUM-56 exists to retire.
   *
   * BASE: this cell's two-representation premise IS SCRUM-109's shape — the
   * hand-keyed sale-linked row raises a canonical twin unconditionally, so the
   * sale has both an invoice and a row twin. If SCRUM-109 is fixed, the premise
   * changes underneath this cell.
   */
  test("A6 · P3×S5 · a correlated pair settles the SALE INVOICE, never the row twin", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000008");
    const rowId = await saleLinkedRow(asUser, orgId, customerId, saleId);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId: rowId, saleId,
      amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a6",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const state = await targets(t, { invoiceId, rowId });
    expect({
      onSaleInvoice: state.onSaleInvoiceMinor,
      onRowTwin: state.onRowTwinMinor,
      allocationCount: state.allocationCount,
    }).toEqual({ onSaleInvoice: PAY * MINOR, onRowTwin: 0, allocationCount: 1 });
  });

  // ---- S4: sale-linked row only, across the money-in paths (D009 §4) -------

  /** BASE: as A6 — the sale-linked row's twin is SCRUM-109's twin. */
  test("A8 · P3×S4 · a sale-linked row alone settles the SALE INVOICE", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000009");
    const rowId = await saleLinkedRow(asUser, orgId, customerId, saleId);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId: rowId, // caller names NO sale
      amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a8",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const state = await targets(t, { invoiceId, rowId });
    expect({
      onSaleInvoice: state.onSaleInvoiceMinor,
      onRowTwin: state.onRowTwinMinor,
    }).toEqual({ onSaleInvoice: PAY * MINOR, onRowTwin: 0 });
  });

  /** BASE: as A6. */
  test("A9 · P1×S4 · cash on a sale-linked row alone settles the SALE INVOICE", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000010");
    const rowId = await saleLinkedRow(asUser, orgId, customerId, saleId);

    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowId, amount: PAY, method: "CASH", paymentDate: Date.now(),
    });

    const state = await targets(t, { invoiceId, rowId });
    expect({
      onSaleInvoice: state.onSaleInvoiceMinor,
      onRowTwin: state.onRowTwinMinor,
    }).toEqual({ onSaleInvoice: PAY * MINOR, onRowTwin: 0 });
  });

  /** BASE: as A6. */
  test("A10 · P2×S4 · a cleared cheque on a sale-linked row alone settles the SALE INVOICE", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000011");
    const rowId = await saleLinkedRow(asUser, orgId, customerId, saleId);

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId,
      bank: "ABC", chequeNumber: "CQ-A10", chequeDate: Date.now(), amount: PAY,
    });
    await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });

    const state = await targets(t, { invoiceId, rowId });
    expect({
      onSaleInvoice: state.onSaleInvoiceMinor,
      onRowTwin: state.onRowTwinMinor,
    }).toEqual({ onSaleInvoice: PAY * MINOR, onRowTwin: 0 });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 3 — R6 unallocated receipt. S1 split into P1 / P2 / P3 (D009 §2).
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * BASE: a completed sale exists in the org, so "did not invent provenance" is
   * falsifiable — there IS a sale and an invoice available to be wrongly
   * attached. Without one this cell would pass for the wrong reason.
   */
  test("A7a · P1×S1 · cash naming no debt is an unallocated receipt", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000012");

    const refused = await capture(() =>
      asUser.mutation(api.collections.recordPayment, {
        orgId, customerId, amount: PAY, method: "CASH", paymentDate: Date.now(),
      })
    );

    const shape = await receiptShape(t);
    expect({
      refused: refused !== null,
      canonicalPaymentCount: shape.canonicalPaymentCount,
      appliedMinor: shape.appliedMinor,
      unappliedMinor: shape.unappliedMinor,
      allocationCount: shape.allocationCount,
      inventedSaleIds: shape.inventedSaleIds,
      inventedReceivableIds: shape.inventedReceivableIds,
      visibleToCashReconciliation: shape.cashflowRows > 0,
    }).toEqual({
      refused: false,
      canonicalPaymentCount: 1,
      appliedMinor: 0,
      unappliedMinor: PAY * MINOR,
      allocationCount: 0,
      inventedSaleIds: 0,
      inventedReceivableIds: 0,
      visibleToCashReconciliation: true,
    });
  });

  /** BASE: as A7a. */
  test("A7b · P2×S1 · a cleared cheque naming no debt is an unallocated receipt", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000013");

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, customerId, bank: "ABC", chequeNumber: "CQ-A7B",
      chequeDate: Date.now(), amount: PAY,
    });
    const refused = await capture(() =>
      asUser.mutation(api.collections.clearCheque, { orgId, chequeId })
    );

    const shape = await receiptShape(t);
    expect({
      refused: refused !== null,
      appliedMinor: shape.appliedMinor,
      unappliedMinor: shape.unappliedMinor,
      allocationCount: shape.allocationCount,
      inventedSaleIds: shape.inventedSaleIds,
      inventedReceivableIds: shape.inventedReceivableIds,
      visibleToCashReconciliation: shape.cashflowRows > 0,
    }).toEqual({
      refused: false,
      appliedMinor: 0,
      unappliedMinor: PAY * MINOR,
      allocationCount: 0,
      inventedSaleIds: 0,
      inventedReceivableIds: 0,
      visibleToCashReconciliation: true,
    });
  });

  /** BASE: as A7a. */
  test("A7c · P3×S1 · a settled payment link naming no debt is an unallocated receipt", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000014");

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId,
      amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a7c",
    });
    const refused = await capture(() =>
      asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId })
    );

    const shape = await receiptShape(t);
    expect({
      refused: refused !== null,
      appliedMinor: shape.appliedMinor,
      unappliedMinor: shape.unappliedMinor,
      allocationCount: shape.allocationCount,
      inventedSaleIds: shape.inventedSaleIds,
      inventedReceivableIds: shape.inventedReceivableIds,
    }).toEqual({
      refused: false,
      appliedMinor: 0,
      unappliedMinor: PAY * MINOR,
      allocationCount: 0,
      inventedSaleIds: 0,
      inventedReceivableIds: 0,
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 4 — axis extension (D009 §5). The surface F3 caught me missing.
  //
  // `paymentIntents.create:231-247` is a PUBLIC mutation carrying FOUR
  // independent target-or-identity references — orgId, customerId (REQUIRED),
  // receivableId?, receivableDocumentId?, saleId? — with no correlation check
  // among them. R5 says every one of them resolves to one org-scoped debt and
  // one payer AT THIS BOUNDARY, or fails closed here.
  // ══════════════════════════════════════════════════════════════════════════

  /** BASE: the sale invoice is created by `sales.completeFromQuote`, not by SCRUM-109. */
  test("A11 · P3×S7 · a direct canonical document alone settles that document", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000015");

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableDocumentId: invoiceId,
      amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a11",
    });
    await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const state = await targets(t, { invoiceId });
    expect({
      onSaleInvoice: state.onSaleInvoiceMinor,
      allocationCount: state.allocationCount,
    }).toEqual({ onSaleInvoice: PAY * MINOR, allocationCount: 1 });
  });

  /** BASE: as A11. `paymentIntents.ts:298-300` already compares these two. */
  test("A12 · P3×S8 · document + MISMATCHING row is refused atomically", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000016");
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const before = await worldSnapshot(t, rowId);
    const refused = await capture(() =>
      asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: invoiceId, receivableId: rowId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a12",
      })
    );
    const after = await worldSnapshot(t, rowId);

    expect({ refused: refused !== null, delta: worldDelta(before, after) }).toEqual({
      refused: true, delta: {},
    });
  });

  /** BASE: two independent completed sales; neither document comes from SCRUM-109. */
  test("A13 · P3×S9 · document + MISMATCHING sale is refused atomically", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const saleA = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000017");
    const saleB = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000018");

    const before = await worldSnapshot(t);
    const refused = await capture(() =>
      asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: saleA.invoiceId, saleId: saleB.saleId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a13",
      })
    );
    const after = await worldSnapshot(t);

    expect({ refused: refused !== null, delta: worldDelta(before, after) }).toEqual({
      refused: true, delta: {},
    });
  });

  /**
   * The CONSISTENT control for group 4: all three references name the same sale.
   * Under R2 the one permitted target is the sale's canonical invoice, and
   * naming it explicitly agrees with that. A refusal here is a refusal of a
   * correct request.
   *
   * BASE: the sale-linked row's twin is SCRUM-109's twin, so `main` sees the
   * document (sale invoice) and the row's twin as different ids.
   */
  test("A14 · P3×S10 · a mutually consistent triple settles the sale invoice", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000019");
    const rowId = await saleLinkedRow(asUser, orgId, customerId, saleId);

    const refusalMessage = await capture(async () => {
      const intentId = await asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: invoiceId, receivableId: rowId, saleId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a14",
      });
      await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });
    });

    // The message is carried into the assertion, not asserted against a guess:
    // if `main` refuses a correct request, WHICH check refused it is the finding.
    const state = await targets(t, { invoiceId, rowId });
    expect({
      refusalMessage,
      onSaleInvoice: state.onSaleInvoiceMinor,
      onRowTwin: state.onRowTwinMinor,
    }).toEqual({ refusalMessage: null, onSaleInvoice: PAY * MINOR, onRowTwin: 0 });
  });

  /**
   * PAYER MISMATCH — the half of F3 round 1 never exercised, because every
   * round-1 fixture used one customer throughout.
   *
   * BASE: `subledger.allocatePaymentToReceivable:211-213` DOES reject a customer
   * mismatch — but at SETTLEMENT, not at create. R5 requires the refusal at the
   * boundary that accepts the reference: a refusal that arrives after the
   * provider confirmed funds is not fail-closed, it is a lost payment.
   */
  test("A15 · P3×S11 · a document belonging to a DIFFERENT payer is refused atomically at create", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000020");
    const otherCustomerId = await secondCustomer(t, orgId);
    const otherRowId = await standaloneRow(asUser, orgId, otherCustomerId);
    const otherDocId = await rowTwinOf(t, otherRowId);

    const before = await worldSnapshot(t);
    let intentId: any = null;
    const refused = await capture(async () => {
      intentId = await asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: otherDocId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a15",
      });
    });
    const after = await worldSnapshot(t);
    const settlement = await settleAndDescribe(t, asUser, orgId, intentId);

    expect({
      refused: refused !== null,
      delta: worldDelta(before, after),
      settlement,
    }).toEqual({ refused: true, delta: {}, settlement: "unreachable" });
  });

  /**
   * CROSS-TENANT document reference.
   *
   * BASE: the foreign document is raw-inserted rather than created through a
   * mutation, because building a second fully-provisioned org is not needed to
   * measure whether `create` reads the reference at all — and it demonstrably
   * does not (`paymentIntents.ts:290` assigns `args.receivableDocumentId`
   * straight through when `receivableId` is absent).
   */
  test("A16 · P3×S12 · a CROSS-TENANT document reference is refused atomically at create", async () => {
    const { t, orgId, userId, customerId, asUser } = await setup();
    await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000021");

    const foreignDocId = await t.run(async (ctx: any) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() });
      const otherCustomerId = await ctx.db.insert("customers", {
        orgId: otherOrgId, firstName: "Foreign", lastName: "Payer",
      });
      return await ctx.db.insert("receivableDocuments", {
        orgId: otherOrgId, documentType: "INVOICE", documentNumber: "FOREIGN-1",
        payerType: "CUSTOMER", customerId: otherCustomerId,
        sourceType: "MANUAL", sourceId: "foreign",
        originalAmountMinor: PAY * MINOR, currency: "JOD", scale: 3,
        issueDate: Date.now(), dueDate: Date.now() + 86_400_000,
        status: "OPEN", createdAt: Date.now(), createdBy: userId,
      });
    });

    const before = await worldSnapshot(t);
    let intentId: any = null;
    const refused = await capture(async () => {
      intentId = await asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: foreignDocId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a16",
      });
    });
    const after = await worldSnapshot(t);
    const settlement = await settleAndDescribe(t, asUser, orgId, intentId);

    expect({
      refused: refused !== null,
      delta: worldDelta(before, after),
      settlement,
    }).toEqual({ refused: true, delta: {}, settlement: "unreachable" });
  });

  /**
   * DANGLING document reference.
   *
   * BASE: the target is deleted after the row is created, which is the only way
   * to hold a syntactically valid id for a document that no longer exists.
   */
  test("A17 · P3×S13 · a DANGLING document reference is refused atomically at create", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000022");
    const rowId = await standaloneRow(asUser, orgId, customerId);
    const docId = await rowTwinOf(t, rowId);
    await t.run(async (ctx: any) => await ctx.db.delete(docId));

    const before = await worldSnapshot(t);
    let intentId: any = null;
    const refused = await capture(async () => {
      intentId = await asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: docId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a17",
      });
    });
    const after = await worldSnapshot(t);
    const settlement = await settleAndDescribe(t, asUser, orgId, intentId);

    expect({
      refused: refused !== null,
      delta: worldDelta(before, after),
      settlement,
    }).toEqual({ refused: true, delta: {}, settlement: "unreachable" });
  });

  /**
   * CANCELLED document reference — the quietest of the group 4 shapes.
   *
   * BASE: the document is patched to CANCELLED directly, matching the terminal
   * state `saleCancellation.ts` leaves behind. `getReceivableOutstandingMinor:25`
   * returns 0 for a CANCELLED document, so settlement allocates nothing and
   * raises no error — the money is received and lands nowhere.
   */
  test("A18 · P3×S14 · a CANCELLED document reference is refused atomically at create", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000023");
    const rowId = await standaloneRow(asUser, orgId, customerId);
    const docId = await rowTwinOf(t, rowId);
    await t.run(async (ctx: any) => await ctx.db.patch(docId, { status: "CANCELLED" }));

    const before = await worldSnapshot(t, rowId);
    let intentId: any = null;
    const refused = await capture(async () => {
      intentId = await asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: docId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a18",
      });
    });
    const after = await worldSnapshot(t, rowId);
    const settlement = await settleAndDescribe(t, asUser, orgId, intentId);

    expect({
      refused: refused !== null,
      delta: worldDelta(before, after),
      settlement,
    }).toEqual({ refused: true, delta: {}, settlement: "unreachable" });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 5 — P8 cancellation interaction. Retained from round 1 with the
  // base-state notes that were missing.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * BASE — AND THIS IS THE CELL THAT TAUGHT THE RULE. At #241's head
   * `24176a6a7` I reported P8 as "safe by fail-closed refusal". That refusal was
   * an artifact of #241's OWN ROUTING: the patch sent the row's money to the
   * sale invoice, so cancellation saw allocations and refused. On clean `main`
   * the money goes to the row's own twin, cancellation sees nothing, and it
   * proceeds. The property belonged to the patch, not to the path — SCRUM-123.
   *
   * D009 §1 records the consequence as an explicit non-dependency: SCRUM-121
   * does NOT rely on `cancelSaleReceivableIfSafe` refusing.
   *
   * SCOPE: this cell measures SCRUM-123's defect. It is NOT a clause of the
   * SCRUM-121 contract and nothing in that contract may be built on it going
   * green. It stays here so the defect keeps a live, running witness on `main`
   * instead of surviving only as a sentence in a Jira comment.
   */
  test("X6a · P8 · sale cancellation with a CORRELATED paid row must refuse", async () => {
    const { t, orgId, customerId, asUser, asApprover } = await setup();
    const { saleId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000024");
    const rowId = await saleLinkedRow(asUser, orgId, customerId, saleId);
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowId, amount: PAY, method: "CASH", paymentDate: Date.now(),
    });

    const refused = await capture(() =>
      asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" })
    );
    expect({ refusedCancellation: refused !== null }).toEqual({ refusedCancellation: true });
  });

  /**
   * BASE: the standalone row's money sits on its own twin, which is SCRUM-109's
   * twin. The assertion is that cancelling an UNRELATED sale does not disturb
   * it — a property that must hold whether or not SCRUM-109 is fixed.
   */
  test("X6b · P8 · sale cancellation must not disturb an unrelated standalone row's money", async () => {
    const { t, orgId, customerId, asUser, asApprover } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000025");
    const rowId = await standaloneRow(asUser, orgId, customerId);
    await asUser.mutation(api.collections.recordPayment, {
      orgId, receivableId: rowId, amount: PAY, method: "CASH", paymentDate: Date.now(),
    });

    const refused = await capture(() =>
      asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" })
    );

    const state = await targets(t, { invoiceId, rowId });
    expect({
      onRowTwin: state.onRowTwinMinor,
      refusedCancellation: refused !== null,
    }).toEqual({ onRowTwin: PAY * MINOR, refusedCancellation: false });
  });
});
