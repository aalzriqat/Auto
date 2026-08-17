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
 * WHY ROUND 3 EXISTS — two more defects, both mine
 * ─────────────────────────────────────────────────────────────────────────────
 * F5. Round 2's A1b and A3b were NOT VALID REVALIDATION FIXTURES. Each began
 * from an already-contradictory request that the corrected creation boundary is
 * REQUIRED to reject: A1b created a contradictory intent, A3b registered a
 * contradictory cheque. Once A1a/A3a land, those starting states are
 * unconstructable. **A fixture whose precondition the design forbids cannot
 * evidence the design's second boundary.** Replaced, not repaired.
 *
 * The sharper half is that I had ALREADY WRITTEN A3b's weakness down — "green on
 * the amount check, not target revalidation" — and kept the cell anyway.
 * **Labelling a limitation accurately is not the same as the cell being valid
 * evidence.** An honest caveat on a cell that cannot exist is still a cell that
 * cannot exist.
 *
 * F6. The round-2 matrix constrained REFUSAL and nothing constrained
 * ACCEPTANCE. A resolver that over-refuses unless all three references are
 * present would satisfy every red mismatch cell and still break every
 * legitimate caller. That is the exact mirror of round 1's defect. The C-series
 * below are ACCEPTANCE controls, built to fail against that resolver.
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
 * R3  Contradictory target candidates FAIL CLOSED, ATOMICALLY — but WHICH
 *     failure is correct depends on whether the money exists yet. See the
 *     binding table below. Silently discarding one reference is never a
 *     resolution: a contradictory pair is refused, not reconciled by preference.
 *
 * R4  Provenance (sale, customer, vehicle) derives from the VERIFIED TARGET.
 *     Independent fallback expressions are the named anti-pattern:
 *       `receivable?.saleId ?? args.saleId`   collections.ts:850  (cash)
 *       `receivable?.saleId ?? args.saleId`   collections.ts:986  (cheque)
 *
 * R5  ALL supplied target candidates AND payer identity must resolve to one
 *     org-scoped canonical debt and one payer AT THE BOUNDARY THAT ACCEPTS
 *     THEM, and must be RE-PROVEN at every later boundary that moves money.
 *     Re-proving means the TARGET and the PAYER, never merely the amount.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BINDING TABLE (owner-proxy ruling, AF30-D013) — R3/R5 resolved by boundary
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   contradictory / foreign / dangling / terminal / payer-mismatched candidate
 *     BEFORE funds exist  (create · register · manual cash)
 *       -> HARD-FAIL ATOMICALLY. Nothing survives.
 *
 *   target no longer proven
 *     AFTER funds confirmed  (intent settlement · cheque clearing)
 *       -> DO NOT ALLOCATE, DO NOT LOSE THE RECEIPT. The receipt takes R6's
 *          form exactly (see R6 — referenced, deliberately not restated here),
 *          and the driver record reaches a TERMINAL state so the provider or
 *          cheque event does NOT keep retrying as if no funds had arrived.
 *
 *   target still proven, owes less than requested
 *     AT settlement
 *       -> allocate the LIVE outstanding; the remainder stays unapplied.
 *
 * This is NOT a new unapplied-payment product. It is the S1 compatibility form
 * the owner already approved, reused as the post-confirmation safe harbour.
 *
 * ⚠️ ASSERT BOTH HALVES OF THE SAFE HARBOUR. The receipt EXISTS and is
 * reconcilable, AND allocation, AR status/aging and debt provenance are
 * UNTOUCHED. Either half alone proves half of it: "a receipt was recorded" is
 * satisfied by an implementation that also allocated, and "nothing was
 * allocated" is satisfied by one that threw the money away.
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
  // A1c injects payer drift through `customers.softDelete`.
  "delete:customers",
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
 * BOTH HALVES of the post-confirmation safe harbour, in one reading.
 *
 * PRESENCE — a receipt was recorded for the confirmed funds, carries the whole
 * amount as unapplied, and the driver record reached a TERMINAL state so the
 * provider / cheque event stops retrying.
 * ABSENCE — no allocation, no legacy mirror row, and the legacy row's balance,
 * status and aging fields are byte-identical to before.
 *
 * Asserting only presence passes for an implementation that ALSO allocated;
 * asserting only absence passes for one that threw the money away.
 */
type Driver = { kind: "intent"; id: any } | { kind: "cheque"; id: any };

/**
 * ⚠️ THE RECEIPT IS RESOLVED BY OWNERSHIP, NEVER BY POSITION.
 *
 * The first version of this helper selected the receipt as
 * `payments[payments.length - 1]` — newest-first inference. Contract v3 R5
 * forbids exactly that: "No inference by newest-first, amount matching,
 * cheque-number text, or a guessed idempotency key — anywhere, INCLUDING IN
 * TEST HELPERS." Being in a test file is not an exemption. A helper that guesses
 * which payment it is looking at cannot evidence a contract whose entire subject
 * is that identity must be proven; it would also keep passing under an
 * implementation that wrote the right row for the wrong movement.
 *
 * So the receipt is reached through the DRIVER'S OWN LINK:
 *   intent  ->  paymentIntents.canonicalPaymentId
 *   cheque  ->  collectionPayments.by_cheque -> canonicalPaymentId
 * and the traversal FAILING is itself reportable, not silently substituted.
 */
async function receiptOwnedBy(t: any, driver: Driver) {
  return await t.run(async (ctx: any) => {
    let paymentId: any = null;
    let lineage = "";
    if (driver.kind === "intent") {
      const intent = await ctx.db.get(driver.id);
      paymentId = intent?.canonicalPaymentId ?? null;
      lineage = "paymentIntents.canonicalPaymentId";
    } else {
      const mirror = await ctx.db
        .query("collectionPayments")
        .withIndex("by_cheque", (q: any) => q.eq("chequeId", driver.id))
        .first();
      paymentId = mirror?.canonicalPaymentId ?? null;
      lineage = "collectionPayments.by_cheque -> canonicalPaymentId";
    }
    if (!paymentId) return { unreachable: `no receipt reachable via ${lineage}` };
    const payment = await ctx.db.get(paymentId);
    if (!payment) return { unreachable: `${lineage} points at a missing payment` };
    const active = (await ctx.db.query("paymentAllocations").collect())
      .filter((a: any) => a.status === "ACTIVE" && String(a.paymentId) === String(paymentId));
    const applied = active.reduce((s: number, a: any) => s + a.amountMinor, 0);
    return {
      amountMinor: payment.amountMinor,
      status: payment.status,
      unappliedMinor: payment.amountMinor - applied,
    };
  });
}

async function safeHarbour(
  t: any,
  driver: Driver,
  before: any,
  after: any,
  driverStatus: string | null,
  threw: string | null
) {
  const receipt: any = await receiptOwnedBy(t, driver);
  const d = (table: string) => after.counts[table] - before.counts[table];
  return {
    threw,
    driverStatus,
    // presence — reached through the driver's own link, not guessed
    receiptReachable: receipt.unreachable ?? true,
    receiptAmountMinor: receipt.amountMinor ?? null,
    receiptUnappliedMinor: receipt.unappliedMinor ?? null,
    receiptSettled: receipt.status === "SETTLED",
    // absence — no AR movement of any kind
    newAllocations: d("paymentAllocations"),
    legacyRowMutated: JSON.stringify(before.row) !== JSON.stringify(after.row),
  };
}

/**
 * The safe harbour, spelled out once so every cell asserts the same thing.
 *
 * ⚠️ CORRECTED for CONTRACT v3 R7 — "AN AR MIRROR IS NOT A LINEAGE RECORD."
 * The earlier expectation asserted `newLegacyMirrors: 0`, i.e. that the safe
 * harbour writes NO `collectionPayments` row at all. On the cheque path that
 * would sever the only typed reversal lineage:
 *
 *   postDatedCheques.chequeId -> collectionPayments.chequeId
 *                             -> canonicalPaymentId / paymentAllocationId
 *
 * and `returnClearedCheque:1332` guards its ENTIRE reversal block on
 * `if (clearedPayment)`. The L-series below measures what that costs.
 *
 * So the count of mirror rows is NOT asserted here. What is asserted is what
 * the mirror must not do: no allocation, and no receivable balance / status /
 * aging movement. A retained row is permitted only as a zero-applied,
 * explicitly non-AR movement record.
 */
function safeHarbourExpectation(driverStatus: string) {
  return {
    threw: null,
    driverStatus,
    receiptReachable: true,
    receiptAmountMinor: PAY * MINOR,
    receiptUnappliedMinor: PAY * MINOR,
    receiptSettled: true,
    newAllocations: 0,
    legacyRowMutated: false,
  };
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

describe("SCRUM-121 Priority-1 round 5 — path × input shape, measured on clean main", () => {
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
   * A3b′ — REPLACES round-2 A3b, which sol's F5 correctly invalidated: it
   * registered an ALREADY-CONTRADICTORY cheque, a state the corrected
   * registration boundary (A3a) must reject, so it could never evidence the
   * clear-time boundary. It also refused on the AMOUNT rather than the target,
   * which I had written down and kept anyway.
   *
   * VALID AT THE FIRST BOUNDARY: a cheque against a sale-linked row, customer
   * matching, NO contradictory `saleId` — the A10 shape, which registers
   * cleanly.
   *
   * DRIFT INJECTED (target, post-registration): the SALE IS CANCELLED, so
   * `cancelSaleReceivableIfSafe:107` sets the sale's canonical invoice to
   * CANCELLED. Under R2 that invoice is the cheque's one permitted target, and
   * it is no longer provable.
   *
   * WHY THIS DRIFT AND NOT AN AMOUNT DRIFT: the legacy row's
   * `outstandingAmount` is UNCHANGED by the cancellation, so
   * `clearCheque:1109`'s amount comparison still passes. Only re-proving the
   * TARGET can catch this. That is the whole point of the replacement.
   *
   * BASE: the sale can be cancelled while a cheque is merely HELD because no
   * allocation exists yet — `cancelSaleReceivableIfSafe:82` only refuses over
   * already-applied payments. Also depends on SCRUM-109 raising the row's twin.
   *
   * CONSTRUCTION FINDING, per-shape: `registerCheque` has NO
   * `receivableDocumentId` argument at all, so the cheque path CANNOT express a
   * direct canonical target. Its stored target is therefore always the row's
   * twin, and the A1d isolation below — drifting the target the code itself
   * stores — is UNCONSTRUCTABLE on this path. That is a finding about the
   * cheque surface, not a gap in the fixture.
   */
  test("A3b′ · P2b · cheque clear after TARGET drift: safe harbour, not allocation", async () => {
    const { t, orgId, customerId, asUser, asApprover } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000003");
    const rowId = await saleLinkedRow(asUser, orgId, customerId, saleId);

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId,
      bank: "ABC", chequeNumber: "CQ-A3B", chequeDate: Date.now(), amount: PAY,
    });

    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    // A DRIFT FIXTURE THAT DOES NOT PROVE ITS DRIFT LANDED IS NOT EVIDENCE.
    const invoiceStatus = await t.run(async (ctx: any) => (await ctx.db.get(invoiceId)).status);
    expect(invoiceStatus).toBe("CANCELLED");

    const before = await worldSnapshot(t, rowId);
    const threw = await capture(() =>
      asUser.mutation(api.collections.clearCheque, { orgId, chequeId })
    );
    const after = await worldSnapshot(t, rowId);
    const chequeStatus = await t.run(async (ctx: any) => (await ctx.db.get(chequeId)).status);

    expect(await safeHarbour(t, { kind: "cheque", id: chequeId }, before, after, chequeStatus, threw)).toEqual(
      safeHarbourExpectation("CLEARED")
    );
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
   * A1b′ — REPLACES round-2 A1b (sol F5). The old cell created an
   * ALREADY-CONTRADICTORY intent, which the corrected create boundary (A1a)
   * must reject, so its precondition is unconstructable under the design it was
   * meant to evidence. It also asserted an atomic throw, which the owner-proxy
   * ruling has since replaced with the safe harbour — the design tension I
   * flagged there is now SETTLED, and settled against what I asserted.
   *
   * VALID AT THE FIRST BOUNDARY: a correlated pair — a sale-linked row and its
   * own sale (S5). Creation is clean.
   *
   * DRIFT INJECTED (target, post-creation): the SALE IS CANCELLED, taking its
   * canonical invoice — the one permitted target under R2 — to CANCELLED.
   *
   * NOT AN AMOUNT DRIFT: the row and its twin still carry the full outstanding,
   * so every amount comparison on this path still passes. Only re-proving the
   * target catches it.
   *
   * BASE: cancellation succeeds because the intent is still PENDING and nothing
   * is allocated yet. Depends on SCRUM-109 raising the row's twin.
   */
  test("A1b′ · P3b · settle after TARGET drift: safe harbour, not allocation", async () => {
    const { t, orgId, customerId, asUser, asApprover } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000005");
    const rowId = await saleLinkedRow(asUser, orgId, customerId, saleId);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId: rowId, saleId,
      amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a1b",
    });

    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    const invoiceStatus = await t.run(async (ctx: any) => (await ctx.db.get(invoiceId)).status);
    expect(invoiceStatus).toBe("CANCELLED");

    const before = await worldSnapshot(t, rowId);
    const threw = await capture(() =>
      asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId })
    );
    const after = await worldSnapshot(t, rowId);
    const intentStatus = await t.run(async (ctx: any) => (await ctx.db.get(intentId)).status);

    expect(await safeHarbour(t, { kind: "intent", id: intentId }, before, after, intentStatus, threw)).toEqual(
      safeHarbourExpectation("SETTLED")
    );
  });

  /**
   * A1d · TARGET drift, ISOLATED — and the reason it exists is a limit of A1b′
   * I am not going to paper over.
   *
   * In A1b′ the caller supplies `receivableId`, so `paymentIntents.ts:301`
   * overwrites the stored target with the ROW'S TWIN. Cancelling the sale kills
   * the SALE INVOICE — the target CONTRACT R2 names — but not the twin `main`
   * actually uses. So A1b′ is red for a real contract violation, yet it does
   * NOT show `main` allocating to a dead document, and reporting it that way
   * would overstate it. It re-measures the R2 routing defect under drift.
   *
   * A1d isolates one narrow question instead. The caller supplies ONLY
   * `receivableDocumentId` (the S7 shape A11 proves works), so `main`'s own
   * stored target IS the sale invoice. Cancelling the sale then kills the exact
   * document `main` will settle against.
   *
   * DRIFT INJECTED (target, post-creation): the sale is cancelled, taking the
   * intent's own stored target to CANCELLED.
   *
   * ⚠️⚠️ WHAT THIS CELL PROVES, AND THE OVERCLAIM I MADE FROM IT.
   *
   * A1d is GREEN. In SCRUM-121 c12585 I wrote from that one green cell:
   * "revalidation is NOT missing on main; the stored target is the wrong one."
   * **That was wrong, and CONTRACT v3 R3 now says so explicitly: revalidation
   * IS missing on `main` — do not scope it away.**
   *
   * A1d is green for one mechanical reason and no other:
   * `subledger.getReceivableOutstandingMinor:25` carries a specific
   * `status === "CANCELLED" -> return 0` branch. That is a single hard-coded
   * terminal status, not a revalidation step. **A1d therefore proves exactly
   * "CANCELLED-target safe harbour already present", and nothing broader.**
   * Per SCRUM-98 that branch covers ONLY CANCELLED — A1e and A1f below measure
   * WRITTEN_OFF and REVERSED rather than repeating the claim.
   *
   * ⚠️ AND THE COUNTEREXAMPLE WAS ALREADY IN THIS FILE. A1c is red: a
   * soft-deleted payer is not re-proven and the money is allocated anyway. I
   * generalised past a red cell I had measured in the same round. Hedging the
   * conclusion afterwards is not the same as not drawing it.
   *
   * BASE: no legacy row is involved at all, so this cell is independent of
   * SCRUM-109 — the only cell in the drift group that is.
   */
  test("A1d · P3b · settle after the STORED target itself is cancelled: safe harbour", async () => {
    const { t, orgId, customerId, asUser, asApprover } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000030");

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableDocumentId: invoiceId,
      amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a1d",
    });

    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    const invoiceStatus = await t.run(async (ctx: any) => (await ctx.db.get(invoiceId)).status);
    expect(invoiceStatus).toBe("CANCELLED");

    const before = await worldSnapshot(t);
    const threw = await capture(() =>
      asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId })
    );
    const after = await worldSnapshot(t);
    const intentStatus = await t.run(async (ctx: any) => (await ctx.db.get(intentId)).status);

    expect(await safeHarbour(t, { kind: "intent", id: intentId }, before, after, intentStatus, threw)).toEqual(
      safeHarbourExpectation("SETTLED")
    );
  });

  /**
   * A1e / A1f — the OTHER terminal statuses, measured rather than cited.
   *
   * CONTRACT v3 R3 states, per SCRUM-98, that
   * `getReceivableOutstandingMinor`'s terminal-status branch covers ONLY
   * CANCELLED, so WRITTEN_OFF and REVERSED still allocate. That is a claim, and
   * a claim I would otherwise be repeating from a description. These two cells
   * turn it into a measurement, which is the whole reason A1d's scope had to be
   * narrowed in the first place.
   *
   * Under R3 all three statuses are the same situation — a target that is no
   * longer proven, after funds are confirmed — so all three must reach the same
   * safe harbour. If A1d is green and these are red, the difference is not a
   * rule, it is a hard-coded status list.
   *
   * DRIFT INJECTED (target, post-creation): the stored document is moved to a
   * terminal status directly, matching the state a write-off or a reversal
   * leaves behind.
   *
   * BASE: independent of SCRUM-109 — no legacy row is involved.
   */
  for (const terminalStatus of ["WRITTEN_OFF", "REVERSED"] as const) {
    const label = terminalStatus === "WRITTEN_OFF" ? "A1e" : "A1f";
    test(`${label} · P3b · settle after the stored target becomes ${terminalStatus}: safe harbour`, async () => {
      const { t, orgId, customerId, asUser } = await setup();
      const vin = terminalStatus === "WRITTEN_OFF" ? "1HGCM82633A000031" : "1HGCM82633A000032";
      const { invoiceId } = await completedSale(t, asUser, orgId, customerId, vin);

      const intentId = await asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: invoiceId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe",
        externalId: `pi_${label.toLowerCase()}`,
      });

      await t.run(async (ctx: any) => await ctx.db.patch(invoiceId, { status: terminalStatus }));
      const driftedTo = await t.run(async (ctx: any) => (await ctx.db.get(invoiceId)).status);
      expect(driftedTo).toBe(terminalStatus);

      const before = await worldSnapshot(t);
      const threw = await capture(() =>
        asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId })
      );
      const after = await worldSnapshot(t);
      const intentStatus = await t.run(async (ctx: any) => (await ctx.db.get(intentId)).status);

      expect(await safeHarbour(t, { kind: "intent", id: intentId }, before, after, intentStatus, threw)).toEqual(
        safeHarbourExpectation("SETTLED")
      );
    });
  }

  /**
   * A1g · POST-CREATE DANGLING target — required by AF30-D014.
   *
   * A17 already measures a dangling reference supplied AT create, where the
   * binding table says hard-fail. This is the other side of the same table: the
   * reference was VALID when the caller supplied it, the funds are now
   * confirmed, and only then does the target disappear.
   *
   * **The required behaviour is the safe harbour, NOT a throw** — R3 is explicit
   * that a throw rolls back the confirmed receipt and the provider retries into
   * the same throw. This cell exists precisely because "not found" is the most
   * natural thing to write and the most expensive thing to ship.
   *
   * DRIFT INJECTED (target, post-creation): the stored document is deleted.
   *
   * BASE: independent of SCRUM-109. Deletion is the only way to hold a
   * syntactically valid id for a document that no longer exists.
   */
  test("A1g · P3b · settle after the stored target is DELETED: safe harbour, never a throw", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000033");

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableDocumentId: invoiceId,
      amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a1g",
    });

    await t.run(async (ctx: any) => await ctx.db.delete(invoiceId));
    const gone = await t.run(async (ctx: any) => (await ctx.db.get(invoiceId)) === null);
    expect(gone).toBe(true);

    const before = await worldSnapshot(t);
    const threw = await capture(() =>
      asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId })
    );
    const after = await worldSnapshot(t);
    const intentStatus = await t.run(async (ctx: any) => (await ctx.db.get(intentId)).status);

    expect(await safeHarbour(t, { kind: "intent", id: intentId }, before, after, intentStatus, threw)).toEqual(
      safeHarbourExpectation("SETTLED")
    );
  });

  /**
   * A1c · PAYER drift — the other half of "re-prove target AND payer". Round 2
   * never exercised payer identity at all.
   *
   * VALID AT THE FIRST BOUNDARY: a standalone row for its own customer (S3),
   * which creates cleanly (A4 is green).
   *
   * DRIFT INJECTED (payer, post-creation): the customer is SOFT-DELETED. The
   * intent still names a payer that no longer exists as a valid party.
   *
   * NOT AN AMOUNT DRIFT: nothing about the balance moves. And note that
   * `allocatePaymentToReceivable:211` compares payment.customerId to
   * receivable.customerId — both still hold the same now-deleted id, so an
   * identity COMPARISON still passes where a PROOF of a valid payer would not.
   *
   * CONSTRUCTION NOTE (per-shape difficulty, carried forward): payer drift is
   * only constructible on a STANDALONE row. `customers.softDelete:540/546`
   * refuses to delete a customer holding leads or sales, so the sale-linked and
   * correlated shapes cannot express this drift at all through the public API.
   * A drift that only one shape can express is exactly the kind of asymmetry
   * that keeps a scenario out of a matrix.
   *
   * MEASURED NON-FINDING, recorded so nobody re-derives it: `mergeCustomers` is
   * NOT a payer-drift vector. `CUSTOMER_REFERENCING_TABLES` repoints
   * `receivableDocuments`, `receivables`, `canonicalPayments` AND
   * `paymentIntents` together, so both sides move to the survivor and stay
   * consistent.
   *
   * BASE: depends on SCRUM-109 raising the standalone row's twin.
   */
  test("A1c · P3b · settle after PAYER drift: safe harbour, not allocation", async () => {
    const { t, orgId, asUser } = await setup();
    // A payer with no leads and no sales, so soft-delete is permitted.
    const payerId = await secondCustomer(t, orgId);
    const rowId = await standaloneRow(asUser, orgId, payerId);

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId: payerId, receivableId: rowId,
      amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_a1c",
    });

    await asUser.mutation(api.customers.softDelete, { orgId, customerId: payerId });

    const payerDeleted = await t.run(async (ctx: any) => (await ctx.db.get(payerId)).isDeleted);
    expect(payerDeleted).toBe(true);

    const before = await worldSnapshot(t, rowId);
    const threw = await capture(() =>
      asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId })
    );
    const after = await worldSnapshot(t, rowId);
    const intentStatus = await t.run(async (ctx: any) => (await ctx.db.get(intentId)).status);

    expect(await safeHarbour(t, { kind: "intent", id: intentId }, before, after, intentStatus, threw)).toEqual(
      safeHarbourExpectation("SETTLED")
    );
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
  // GROUP 4b — ACCEPTANCE CONTROLS (sol F6). The mirror of the round-1 defect.
  //
  // Every cell above constrains REFUSAL and nothing constrains ACCEPTANCE. A
  // resolver that over-refuses unless all three references are present would
  // satisfy every red mismatch cell and still break every legitimate caller.
  // These three pairwise controls are the evidence that must fail against that
  // hypothetical resolver — so each asserts NO refusal, the EXACT target, the
  // EXACT amount and exactly ONE allocation. An over-refuser fails all four.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * C1 — direct document + its MATCHING sale, no row.
   * BASE: the invoice comes from `sales.completeFromQuote`, not from SCRUM-109.
   */
  test("C1 · P3 · document + its matching sale is ACCEPTED and settles that document", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000026");

    const refusalMessage = await capture(async () => {
      const intentId = await asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: invoiceId, saleId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_c1",
      });
      await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });
    });

    const state = await targets(t, { invoiceId });
    expect({
      refusalMessage,
      onSaleInvoice: state.onSaleInvoiceMinor,
      allocationCount: state.allocationCount,
    }).toEqual({ refusalMessage: null, onSaleInvoice: PAY * MINOR, allocationCount: 1 });
  });

  /**
   * C2a — direct document + its MATCHING sale-linked row, no explicit sale,
   * where "matching" is read under CONTRACT R2: a sale-linked row's one
   * permitted target is the SALE'S CANONICAL INVOICE.
   *
   * ⚠️ THE PHRASE "matching document" IS AMBIGUOUS ON `main`, and I am not
   * resolving that ambiguity by picking the reading that suits me. `main`'s own
   * rule (`paymentIntents.ts:298`) treats the row's TWIN as the matching
   * document. C2b below measures that second reading, so this control does not
   * rest on my interpretation of the directive.
   *
   * BASE: depends on SCRUM-109 raising the row's twin, which is what makes the
   * invoice and the twin two distinct ids in the first place.
   */
  test("C2a · P3 · document(sale invoice) + its sale-linked row is ACCEPTED and settles the invoice", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId, invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000027");
    const rowId = await saleLinkedRow(asUser, orgId, customerId, saleId);

    const refusalMessage = await capture(async () => {
      const intentId = await asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: invoiceId, receivableId: rowId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_c2a",
      });
      await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });
    });

    const state = await targets(t, { invoiceId, rowId });
    expect({
      refusalMessage,
      onSaleInvoice: state.onSaleInvoiceMinor,
      onRowTwin: state.onRowTwinMinor,
      allocationCount: state.allocationCount,
    }).toEqual({
      refusalMessage: null, onSaleInvoice: PAY * MINOR, onRowTwin: 0, allocationCount: 1,
    });
  });

  /**
   * C2b — the SAME pair under `main`'S reading of "matching": the row's OWN
   * TWIN as the document. Measured so the C2 verdict does not rest on my
   * interpretation of the directive's wording.
   *
   * ⚠️ THIS IS NOT AN ACCEPTANCE CONTROL — it is its complement, and I had it
   * wrong on the first pass. Under contract R2 a sale-linked row's ONE
   * permitted target is the sale's invoice, so naming the row twin names a
   * document that is not a permitted target for this row. That is a
   * contradictory candidate arriving BEFORE funds exist, so the binding table
   * says hard-fail atomically. C2a and C2b therefore cannot both be green under
   * the finished design, and asserting acceptance for both would have been the
   * "either location is acceptable" defect wearing a new hat.
   *
   * BASE: as C2a — depends on SCRUM-109 making the twin and the invoice two
   * distinct documents. If SCRUM-109 is fixed and no twin exists, this cell
   * becomes unconstructable, which is the correct outcome.
   */
  test("C2b · P3 · document(row twin) + its sale-linked row is refused atomically", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { saleId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000028");
    const rowId = await saleLinkedRow(asUser, orgId, customerId, saleId);
    const twinId = await rowTwinOf(t, rowId);

    const before = await worldSnapshot(t, rowId);
    const refused = await capture(() =>
      asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: twinId, receivableId: rowId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_c2b",
      })
    );
    const after = await worldSnapshot(t, rowId);

    expect({ refused: refused !== null, delta: worldDelta(before, after) }).toEqual({
      refused: true, delta: {},
    });
  });

  /**
   * C3 — standalone row + its OWN direct canonical document, no sale.
   * BASE: the row's twin is SCRUM-109's twin, and under R2 it is also the one
   * permitted target for a standalone row, so this control survives unchanged
   * only while both remain true.
   */
  test("C3 · P3 · standalone row + its own document is ACCEPTED and settles that document", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const { invoiceId } = await completedSale(t, asUser, orgId, customerId, "1HGCM82633A000029");
    const rowId = await standaloneRow(asUser, orgId, customerId);
    const twinId = await rowTwinOf(t, rowId);

    const refusalMessage = await capture(async () => {
      const intentId = await asUser.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: twinId, receivableId: rowId,
        amountMinor: PAY * MINOR, currency: "JOD", provider: "stripe", externalId: "pi_c3",
      });
      await asUser.mutation(api.paymentIntents.markSettled, { orgId, intentId });
    });

    const state = await targets(t, { invoiceId, rowId });
    expect({
      refusalMessage,
      onRowTwin: state.onRowTwinMinor,
      onSaleInvoice: state.onSaleInvoiceMinor,
      allocationCount: state.allocationCount,
    }).toEqual({
      refusalMessage: null, onRowTwin: PAY * MINOR, onSaleInvoice: 0, allocationCount: 1,
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 4c — R7 LINEAGE. An AR mirror is not a lineage record.
  //
  // CONTRACT v3 R7 corrected an earlier "no legacy mirror" rule because the
  // cheque path's ONLY typed reversal lineage runs through that row:
  //
  //   postDatedCheques.chequeId -> collectionPayments.chequeId
  //                             -> canonicalPaymentId / paymentAllocationId
  //                             -> accountingEvents
  //
  // L1 pins the lineage working today. L2 is the FAILING-FIRST half: it removes
  // the row and measures what a "no legacy mirror" safe harbour would actually
  // cost, so R7 rests on a measurement rather than on a prediction.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * L1 — clear → return, lineage intact. The reversal must FIND ITS MONEY.
   *
   * BASE: measured on clean `main` with the mirror row present, which is what
   * `main` writes today. Depends on SCRUM-109 for the row's twin.
   */
  test("L1 · clear then return: the reversal reaches the money through chequeId", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId,
      bank: "ABC", chequeNumber: "CQ-L1", chequeDate: Date.now(), amount: PAY,
    });
    await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });

    const cleared = await targets(t, { rowId });
    expect(cleared.onRowTwinMinor).toBe(PAY * MINOR);

    const threw = await capture(() =>
      asUser.mutation(api.collections.returnClearedCheque, {
        orgId, chequeId, returnReason: "NSF",
      })
    );

    const after = await t.run(async (ctx: any) => {
      const mirror = await ctx.db
        .query("collectionPayments")
        .withIndex("by_cheque", (q: any) => q.eq("chequeId", chequeId))
        .first();
      const canonical = mirror?.canonicalPaymentId ? await ctx.db.get(mirror.canonicalPaymentId) : null;
      const activeAllocations = (await ctx.db.query("paymentAllocations").collect())
        .filter((a: any) => a.status === "ACTIVE");
      const row = await ctx.db.get(rowId);
      const twinAllocatedMinor = activeAllocations
        .filter((a: any) => String(a.receivableDocumentId) === String(row.canonicalReceivableDocumentId))
        .reduce((s: number, a: any) => s + a.amountMinor, 0);
      // Measured, not assumed: after the reversal, does the mirror row still
      // carry its allocation pointer? This decides whether presence-of-pointer
      // is a usable "this movement paid AR" discriminator for a reader — see
      // R10c and the R9 verdict.
      const pointer = mirror?.paymentAllocationId
        ? await ctx.db.get(mirror.paymentAllocationId)
        : null;
      return {
        mirrorStatus: mirror?.status ?? null,
        canonicalStatus: canonical?.status ?? null,
        activeAllocations: activeAllocations.length,
        rowOutstandingMinor: row.outstandingAmount * MINOR,
        twinAllocatedMinor,
        allocationPointerSurvivesVoid: Boolean(mirror?.paymentAllocationId),
        pointedAllocationStatus: pointer?.status ?? null,
      };
    });

    // The money is reversed, and the debt is owed once — not twice. The middle
    // two keys are the same debt read from the two stores: the legacy row says
    // it is owed again, and the canonical twin agrees nothing is paid against it.
    //
    // The last two keys are the R9 evidence: the pointer OUTLIVES the reversal
    // and points at a REVERSED allocation. So `paymentAllocationId != null` does
    // NOT mean "this movement currently pays AR" — a reader would have to
    // traverse to the allocation and read its status.
    expect({ threw, ...after }).toEqual({
      threw: null,
      mirrorStatus: "VOIDED",
      canonicalStatus: "VOIDED",
      activeAllocations: 0,
      rowOutstandingMinor: PAY * MINOR,
      twinAllocatedMinor: 0,
      allocationPointerSurvivesVoid: true,
      pointedAllocationStatus: "REVERSED",
    });
  });

  /**
   * L2 — MISSING LINEAGE FAILS CLOSED. Rewritten for sol F9 (ACCEPTED).
   *
   * ⚠️ WHAT THE PREVIOUS L2 GOT WRONG, AND IT WAS MY ERROR, NOT THE REVIEWER'S.
   *
   * The round-4 L2 deleted the only typed `collectionPayments.by_cheque` link and
   * then asserted that `returnClearedCheque` must "still find its money". But
   * once that row is gone there is NO approved alternative link, and schema
   * expansion is prohibited — so recovering the money would require inferring
   * identity from recency, amount, cheque-number text or a guessed idempotency
   * key, every one of which R5 forbids. **My fixture was demanding the exact
   * inference the contract exists to prevent.** R8 is unambiguous: missing or
   * contradictory lineage FAILS CLOSED before marking a cheque returned or
   * changing balances.
   *
   * This is the third round in which I asserted a clause the contract does not
   * contain — outcomes where the clause was a refusal (round 1), acceptance for
   * two mutually exclusive shapes (round 3), and recovery where the clause is
   * fail-closed (round 4). The pattern is writing the behaviour I would want
   * rather than the clause that binds.
   *
   * THE CONTRACT ASSERTION IS ATOMIC REFUSAL: the mutation throws, and the whole
   * pre-return state survives intact — cheque still CLEARED, canonical payment
   * still SETTLED, allocation still ACTIVE, legacy row untouched, and no GL
   * reversal, outbox reversal, payment void, debt reopening or RETURNED status
   * anywhere.
   *
   * THE MEASURED `main` BEHAVIOUR IS STILL REAL AND IS FILED SEPARATELY AS
   * SCRUM-130: `returnClearedCheque:1332` guards its ENTIRE reversal block on
   * `if (clearedPayment)` while `:1391` reopens the legacy receivable
   * UNCONDITIONALLY — so the debt is re-inflated on top of an allocation that
   * was never reversed, and the cheque is marked RETURNED either way. That is a
   * pre-existing defect this branch does not fix; it is not the SCRUM-121
   * contract assertion, and conflating the two is what F9 caught.
   *
   * BASE: as L1, plus the deliberate deletion — verified below before the return
   * runs. Depends on SCRUM-109 for the row's twin.
   */
  test("L2 · clear then return with lineage missing: atomic refusal, nothing survives", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId,
      bank: "ABC", chequeNumber: "CQ-L2", chequeDate: Date.now(), amount: PAY,
    });
    await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });

    // Sever the lineage, and prove it is severed before the return runs.
    const severed = await t.run(async (ctx: any) => {
      const mirror = await ctx.db
        .query("collectionPayments")
        .withIndex("by_cheque", (q: any) => q.eq("chequeId", chequeId))
        .first();
      await ctx.db.delete(mirror._id);
      const gone = await ctx.db
        .query("collectionPayments")
        .withIndex("by_cheque", (q: any) => q.eq("chequeId", chequeId))
        .first();
      return gone === null;
    });
    expect(severed).toBe(true);

    const threw = await capture(() =>
      asUser.mutation(api.collections.returnClearedCheque, {
        orgId, chequeId, returnReason: "NSF",
      })
    );

    const after = await t.run(async (ctx: any) => {
      const cheque = await ctx.db.get(chequeId);
      const activeAllocations = (await ctx.db.query("paymentAllocations").collect())
        .filter((a: any) => a.status === "ACTIVE");
      const settledPayments = (await ctx.db.query("canonicalPayments").collect())
        .filter((p: any) => p.status === "SETTLED");
      const row = await ctx.db.get(rowId);
      const reversalEvents = (await ctx.db.query("accountingEvents").collect())
        .filter((e: any) => e.status === "REVERSED" || e.eventType?.includes("REVERS"));
      const queuedReversals = (await ctx.db.query("pendingAccountingEvents").collect())
        .filter((e: any) => e.kind === "REVERSE");
      return {
        chequeStatus: cheque.status,
        activeAllocations: activeAllocations.length,
        settledPayments: settledPayments.length,
        rowOutstandingMinor: row.outstandingAmount * MINOR,
        rowStatus: row.status,
        reversalEvents: reversalEvents.length,
        queuedReversals: queuedReversals.length,
      };
    });

    // R8 — the pre-return world survives untouched. `rowOutstandingMinor: 0`
    // and `rowStatus: "PAID"` are the CLEARED state: the debt must NOT be
    // reopened, because reopening it without reversing the money is exactly the
    // second AR balance R7 exists to prevent.
    expect({ refused: threw !== null, ...after }).toEqual({
      refused: true,
      chequeStatus: "CLEARED",
      activeAllocations: 1,
      settledPayments: 1,
      rowOutstandingMinor: 0,
      rowStatus: "PAID",
      reversalEvents: 0,
      queuedReversals: 0,
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // GROUP 4d — F10: the safe harbour proved END TO END, not just in storage.
  //
  // A canonical payment with no allocation is NECESSARY and NOT SUFFICIENT. The
  // confirmed money must also be captured exactly once by cash/bank
  // reconciliation and by the GL (posted with a journal, or durably queued), and
  // the retained movement row must be DISTINGUISHABLE BY READERS as an
  // unapplied/non-AR movement rather than a debt payment.
  //
  // R1 below is the one that decides R9: it asks the actual Collections readers
  // what they make of the retained row, rather than asserting the row exists.
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * R10a — the retained lineage row is the EXACT driver-owned row.
   *
   * Reached only through `collectionPayments.by_cheque`, never by recency or by
   * amount. Asserts the row's own identity fields, that it points at the same
   * canonical payment the driver does, and that it carries NO allocation link.
   *
   * Measured on a CLEARED cheque, which is the closest thing `main` has to the
   * retained movement row R7 approves — the difference being that `main`'s row
   * DOES carry an allocation. That difference is the finding, not a fixture gap.
   *
   * BASE: depends on SCRUM-109 for the row's twin.
   */
  test("R10a · the retained cheque movement row is the exact driver-owned row, with no AR allocation", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId,
      bank: "ABC", chequeNumber: "CQ-R10A", chequeDate: Date.now(), amount: PAY,
    });
    await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });

    const lineage = await t.run(async (ctx: any) => {
      const rows = await ctx.db
        .query("collectionPayments")
        .withIndex("by_cheque", (q: any) => q.eq("chequeId", chequeId))
        .collect();
      const row = rows[0];
      const canonical = row?.canonicalPaymentId ? await ctx.db.get(row.canonicalPaymentId) : null;
      return {
        rowsForThisCheque: rows.length,
        carriesChequeId: String(row?.chequeId) === String(chequeId),
        carriesCanonicalPaymentId: Boolean(row?.canonicalPaymentId),
        canonicalIsSettled: canonical?.status === "SETTLED",
        canonicalAmountMinor: canonical?.amountMinor ?? null,
        hasAllocationLink: Boolean(row?.paymentAllocationId),
      };
    });

    expect(lineage).toEqual({
      rowsForThisCheque: 1,
      carriesChequeId: true,
      carriesCanonicalPaymentId: true,
      canonicalIsSettled: true,
      canonicalAmountMinor: PAY * MINOR,
      // The safe harbour requires NO allocation link on the retained row.
      hasAllocationLink: false,
    });
  });

  /**
   * R10b — the confirmed money is captured EXACTLY ONCE by reconciliation and by
   * the GL.
   *
   * "Exactly once" is asserted as a count, not a boolean, because the failure
   * this guards against is double-capture as much as no capture. The GL half
   * accepts EITHER a POSTED accounting event with a journal OR a durably
   * queued `pendingAccountingEvents` row — R7/F10 name both as acceptable, and
   * which one occurs depends on whether a period and chart exist.
   *
   * The event is located by the driver's SOURCE IDENTITY
   * (`sourceType: "collectionPayments"`, `sourceId` = the driver-owned row) —
   * the same traversal `returnClearedCheque:1333-1341` uses. No idempotency-key
   * guessing.
   *
   * BASE: this fixture's org has no chart of accounts or open period, so the
   * durable-outbox branch is the one expected to carry it. Recorded because a
   * green here means "captured somewhere durable", not "posted to a journal".
   */
  test("R10b · the confirmed money is captured exactly once by reconciliation and the GL", async () => {
    const { t, orgId, customerId, asUser } = await setup();
    const rowId = await standaloneRow(asUser, orgId, customerId);

    const chequeId = await asUser.mutation(api.collections.registerCheque, {
      orgId, receivableId: rowId, customerId,
      bank: "ABC", chequeNumber: "CQ-R10B", chequeDate: Date.now(), amount: PAY,
    });
    await asUser.mutation(api.collections.clearCheque, { orgId, chequeId });

    const capture = await t.run(async (ctx: any) => {
      const row = await ctx.db
        .query("collectionPayments")
        .withIndex("by_cheque", (q: any) => q.eq("chequeId", chequeId))
        .first();
      const sourceId = row._id.toString();
      const events = (await ctx.db.query("accountingEvents").collect())
        .filter((e: any) => e.sourceType === "collectionPayments" && e.sourceId === sourceId);
      const queued = (await ctx.db.query("pendingAccountingEvents").collect())
        .filter((e: any) => e.sourceType === "collectionPayments" && e.sourceId === sourceId);
      const postedWithJournal = [];
      for (const e of events.filter((e: any) => e.status === "POSTED")) {
        const entries = (await ctx.db.query("journalEntries").collect())
          .filter((j: any) => String(j.accountingEventId) === String(e._id));
        if (entries.length > 0) postedWithJournal.push(e);
      }
      // The cashbook side: how many movement rows represent this one receipt.
      const cashbookRows = (await ctx.db.query("transactions").collect())
        .filter((tx: any) => tx.category === "COLLECTION_PAYMENT" && tx.type === "IN");
      return {
        glCapturedOnce: postedWithJournal.length + queued.filter((q: any) => q.status === "PENDING").length,
        cashbookRowsForThisReceipt: cashbookRows.length,
      };
    });

    expect(capture).toEqual({ glCapturedOnce: 1, cashbookRowsForThisReceipt: 1 });
  });

  /**
   * R10c — THE R9 QUESTION. Is the retained row DISTINGUISHABLE BY READERS as an
   * unapplied/non-AR movement, or is it presented as money collected against AR?
   *
   * This is deliberately not a storage assertion. It asks the two real
   * Collections readers what they make of a movement row that carries confirmed
   * money and NO allocation:
   *
   *   `collections.summary`            -> `collectedToday`
   *   `collections.getReconciliationDraft` -> `expectedCash`
   *
   * CONSTRUCTION: a CASH payment recorded with no receivable (the S1 shape,
   * green at A7a) is the only way `main` produces a `collectionPayments` row
   * that carries the full confirmed amount and no allocation — which is exactly
   * the shape of the retained safe-harbour row R7 approves. So it stands in for
   * that row, and what the readers do with it is what they would do with it.
   *
   * THE CONTRACT: R6 says the receipt is "visible to cash/bank reconciliation"
   * and "NEVER presented as paying AR". Those two together require the readers
   * to separate it — visible in the cash figure, absent from the collected-
   * against-debt figure. This cell asserts exactly that separation.
   *
   * BASE: measured on clean `main` with no chart/period, and independent of
   * SCRUM-109 — no legacy row is involved.
   */
  test("R10c · a confirmed unapplied receipt must be visible to reconciliation and absent from AR collections", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    await asUser.mutation(api.collections.recordPayment, {
      orgId, customerId, amount: PAY, method: "CASH", paymentDate: Date.now(),
    });

    const allocated = await t.run(async (ctx: any) =>
      (await ctx.db.query("paymentAllocations").collect()).filter((a: any) => a.status === "ACTIVE").length
    );
    expect(allocated).toBe(0); // it really is an unapplied receipt

    const summary = await asUser.query(api.collections.summary, { orgId });
    const draft = await asUser.query(api.collections.getReconciliationDraft, {
      orgId, businessDate: Date.now(),
    });

    expect({
      // R6: visible to cash/bank reconciliation.
      visibleToReconciliation: draft.expectedCash,
      // R6: never presented as paying AR. `collectedToday` is the Collections
      // "money collected against debt" figure.
      presentedAsCollectedAgainstDebt: summary.collectedToday,
    }).toEqual({
      visibleToReconciliation: PAY,
      presentedAsCollectedAgainstDebt: 0,
    });
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
