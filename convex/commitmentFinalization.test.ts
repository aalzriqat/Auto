/**
 * SCRUM-195 PHASE 2 (M3) — ROOT-LOCAL FINALIZATION, SPECIFIED BEFORE IT EXISTS.
 *
 * ROUND 3. The round-2 specification at `53f62ebfc` was BLOCKED by both review
 * seats. This is a rebuild, not a patch: the defect was in what it left out, and
 * the omission was structural rather than incidental.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY ROUND 2 WAS BLOCKED, IN ONE SENTENCE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * IT SPECIFIED THE RELEASE SIDE FROM A SINGLE DOOR, AND THAT DOOR IS UNUSABLE
 * FOR THE COMMONEST CASE IN THE PRODUCT.
 *
 * `deposits.releaseVehicleAllocation` operates on a `depositVehicleHolds` row.
 * Those rows are written only when a quote carries more than one vehicle —
 * `deposits.ts:176`, "Only multi-vehicle deposits need a join row per vehicle",
 * guarded by `if (depositVehicleItems.length > 1)`. A walk-in who puts a deposit
 * on ONE car has no hold row at all, so that mutation throws
 * (`deposits.ts:1143`, "That vehicle holds no active share of this quote's
 * deposit."). G.7 below pins that fact so it can never be assumed away again.
 *
 * Built to the round-2 contracts, the natural M3 would have put the RELEASE
 * write in the only door under test. Every car released through
 * `deposits.release`, `deposits.voidDeposit`, `vehicles.releaseReservation`,
 * `applications.updateStatus(REJECTED)` or `applications.cancelApplication`
 * would have kept a permanently OPEN root — refused forever, with no recovery
 * API anywhere in the specified surface. That is SCRUM-199 exactly, recreated by
 * the specification written to eliminate it.
 *
 * The method error underneath it: round 1 was blocked for exercising one
 * COMPLETION door of four, and round 2 fixed that by enumerating the completion
 * doors from call sites. It then specified the RELEASE side with the first door
 * it happened to find, and never enumerated that side at all. A correction
 * applied to one half of a symmetric lifecycle is not a correction. Both halves
 * are enumerated from call sites here, and both enumerations are stated below.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE MODEL — B+, ROOT-ONLY FINALIZATION (owner rulings c15676, c15683)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 writes EXACTLY TWO OUTCOMES, both on `commitmentRoots`:
 *
 *      a sale completes for a committed car  ->  status OPEN -> CONSUMED
 *                                                consumedBySaleId = that sale
 *      the last live basis lets the car go   ->  status OPEN -> RELEASED
 *
 * Phase 2 NEVER writes `vehicleCommitmentClaims.status`, that table's
 * `consumedBySaleId`, or `restoredFromClaimId`. Claim lifecycle is Phase 3's
 * entirely. F.1, F.12 and F.13 assert the claim rows are left BYTE-IDENTICAL,
 * from three different directions.
 *
 * WHY NOT CONSUME THE CLAIMS (rejected option A): a root legitimately carries
 * several live episodes at once, so "consume the live claims" has no structural
 * cardinality bound, and "consume the right subset" has no defensible definition
 * when a root holds two deposit instalments plus a FINANCE episode. G.2, G.3 and
 * G.13 pin that cardinality fact first, in this file.
 *
 * WHY THE ROOT STILL NEEDS `consumedBySaleId`: without it Phase 3 would have to
 * GUESS which root a cancelled sale belonged to. It gives an exact sale -> root
 * entry point without pretending the individual episodes were consumed.
 *
 * ⚠️ `commitmentRoots.consumedBySaleId` DOES NOT EXIST IN THE SCHEMA YET, and
 * neither does a root-level `by_consumed_sale` index — today that index exists
 * only on `vehicleCommitmentClaims` (`schema.ts:3001`). This commit is
 * tests-only and cannot add either. The contracts read the field through one
 * narrow cast (`rootSaleStamp`) so the file typechecks against today's schema
 * while still specifying tomorrow's behaviour.
 *
 * `commitmentRoots.status` ALREADY admits OPEN | RELEASED | CONSUMED
 * (`schema.ts:2911`), and the table already carries `closedAt` / `closedReason`.
 * The terminal states are representable today; nothing has ever written one.
 * G.5 proves that.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE COMPLETION DOORS — ENUMERATED FROM CALL SITES
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Walking upward from every call of `completeSale` / `completeSalesForLineItems`
 * / `completeExistingSale` gives exactly four public mutations:
 *
 *      sales.ts:372          ->  api.sales.create
 *      sales.ts:421          ->  api.sales.completeFromQuote
 *      sales.ts:523          ->  api.sales.completeDraft
 *      applications.ts:3130  ->  api.applications.finalizeDeal
 *
 * F.8a-F.8d exercise ALL FOUR, `finalizeDeal` included, through a real
 * financed lifecycle. F.9a-F.9e give each a negative ownership case — one test
 * per door, so an early failure cannot mask a later door.
 *
 * ⚠️ AND THE COMPLETION DOORS ARE NOT WIRED TO THE AUTHORITY YET. Phase 1 routes
 * only `deposits.create`, `applications.createFromQuote` and
 * `vehicles.createReservation` through `assertAcquirable` — `commitments.ts:958`
 * says so in terms: "Sale completion, trade-ins and inventory removal do NOT
 * come through here yet." F.3, F.4 and F.9a-F.9e verify that today a RIVAL's
 * `sales.completeFromQuote` on a held car SUCCEEDS.
 *
 * That refusal is Phase-2 scope, not a widening of it, because CONSUME is
 * otherwise undefined: if a rival may complete a sale on a car whose root
 * belongs to somebody else, then "the sale consumes the root" stamps the HELD
 * customer's root with the RIVAL's sale. The barrier that decides which root a
 * sale consumes is the same barrier that decides whether it may.
 *
 * ⚠️ ROUND 2 DECLARED THE FINANCED FIXTURE UNREACHABLE WITHOUT FAKING. That was
 * wrong. `registerHandover` (`test-utils/convexTest.ts:116`) is exported from
 * the module this file already imports, obtains the server-issued
 * `economicsStamp` by querying `applications.handoverStamp` exactly as a screen
 * does, and `financeLifecyclePhase1.test.ts:104` already drives the whole
 * financed lifecycle in seven lines with no `ctx.db` patching. Refusing to build
 * that fixture on the grounds that fixtures must reflect production, while the
 * same file fabricated 60 claim rows the real writer cannot produce, was not a
 * principle — it was an inconsistency. Both are fixed here: `financedSale()`
 * uses only product doors, and G.13/F.12 build their 61 episodes by real
 * repeated acquisition.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE RELEASE DOORS — ENUMERATED FROM CALL SITES
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Walking outward from every writer of `holdActive: false` and every
 * status-terminalizing write on `vehicleReservations` / `financeApplications`
 * gives these public doors. Each one ends a commitment basis WITHOUT a sale:
 *
 *   D1  api.deposits.release (REFUNDED)          -> releaseHeldDeposit          single or multi
 *   D2  api.deposits.release (FORFEITED)         -> releaseHeldDeposit          single or multi
 *   D3  api.deposits.voidDeposit                 -> deposits.ts:327             single or multi
 *   D4  api.deposits.releaseVehicleAllocation    -> per-vehicle hold row        MULTI-VEHICLE ONLY
 *   D5  api.vehicles.releaseReservation          -> vehicles.ts:1825            reservation basis
 *   D6  api.applications.updateStatus(REJECTED)  -> releaseHoldForApplicationQuote
 *   D7  api.applications.cancelApplication       -> releaseHoldForApplicationQuote
 *
 * Plus two paths in the same class driven by the CLOCK rather than an operator,
 * and specified here too (F.28, F.29, F.30):
 *
 *   D8  internal.vehicles.expireReservations     -> vehicles.ts:1856   (cron sweep)
 *   D9  the inline expiry sweep inside api.vehicles.createReservation -> vehicles.ts:1596
 *
 * ⚠️ D8/D9 WERE ORIGINALLY DECLARED A GAP, AND THAT WAS WRONG. A review seat
 * showed the gap is a PERMANENT LOCK, not a deferral: `releaseReservation`
 * requires `status === "ACTIVE"` (vehicles.ts:1813), so once a reservation
 * EXPIRES there is no door left that can release its root — the car is refused
 * forever. Declaring a gap records that something is uncovered; it does not
 * make the uncovered thing safe.
 *
 * G.6a-G.6g run every one of D1-D7 and assert each creates ZERO sales, so no
 * contract below can be satisfied by a completion path wearing a release name.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT "ANOTHER LIVE BASIS" MEANS — owner ruling c15683
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Releasing ONE piece of evidence does not automatically free the car, and it
 * does not silently kill another live workflow:
 *
 *      Remove the evidence that was explicitly released.
 *      Keep the root OPEN if another independent live basis still holds the car.
 *
 * So a refunded deposit on a car whose finance application is still APPROVED
 * leaves the money released, the application untouched, and the root OPEN — the
 * money operation succeeds without pretending the deal ended. F.23 and F.24.
 *
 * AND EXPLICIT VEHICLE RELEASE IS STRICTER. An operation whose actual meaning is
 * "take this car out of this deal" — `deposits.releaseVehicleAllocation` — must
 * REFUSE while a live FINANCE or RESERVATION basis still holds it. It does not
 * get to cancel a finance application because somebody clicked "remove vehicle";
 * the operator ends that workflow explicitly first. F.26.
 *
 * ⚠️⚠️ THE TRAP AN IMPLEMENTER WILL FALL INTO, STATED SO THEY DO NOT.
 *
 * `syncVehicleHoldStatus` (`utils/depositHelpers.ts:245`) already computes
 * something that LOOKS like this predicate:
 *
 *      hasHold = hasActiveDepositHold(...) || hasActiveReservationHold(...)
 *
 * IT IS A DIFFERENT QUESTION AND MUST NOT BE REUSED. It answers "should the
 * vehicle row read RESERVED", and FINANCE IS NOT IN IT — an application alone
 * never promotes a car to RESERVED. The canonical basis set under c15683 is
 * DEPOSIT | RESERVATION | FINANCE. Reusing `hasHold` would release a root while
 * an APPROVED finance application still held the car, which is the precise
 * outcome the ruling forbids. G.10 pins the divergence as ground truth.
 *
 * ⚠️ AND LIVENESS IS NOT A STATUS FIELD. The basis predicate must be derived
 * from the same conditions the product's own sweeps use:
 *
 *   DEPOSIT      live  <=>  deposit.holdActive === true && isDeleted !== true
 *                           (multi-vehicle: that vehicle's hold row still active)
 *   RESERVATION  live  <=>  status === "ACTIVE" AND expiresAt > now
 *                           — `expireReservations` (`vehicles.ts:1845`) is the
 *                           spec; an ACTIVE row past its expiry is NOT live, it
 *                           is merely unswept, and `.take(100)` means a backlog
 *                           can stretch that window well past the cron.
 *   FINANCE      live  <=>  status is in-flight — today's product answer is
 *                           `IN_FLIGHT_STATUSES` = DRAFT | PENDING_DOCS |
 *                           UNDER_REVIEW | APPROVED (`applications.ts:2050`).
 *
 * ⚠️ AND IT MUST NOT BE READ OFF THE CLAIM ROWS. Under B+ claims stay ACTIVE
 * forever, including on a CONSUMED root, so `claim.status === "ACTIVE"` is not
 * evidence that anything is still holding the car. F.12 makes this concrete: 61
 * ACTIVE episodes survive a completed sale untouched.
 *
 * ⚠️ `IN_FLIGHT_STATUSES` IS A LOCAL `const` INSIDE `createFromQuote`'s HANDLER,
 * not an exported constant. M3 must hoist and share it, not restate it. Two
 * independently-maintained lists of "which finance statuses hold a car" is the
 * distributed-inference defect SCRUM-195 exists to remove — the same shape as
 * the six acquisition writers that each decided evidence kind for themselves.
 * G.9 pins the acquisition side of that set behaviourally; F.25 pins that the
 * release side agrees with it.
 *
 * Owner ruling on finance states: REJECTED and CANCELLED no longer hold the car.
 * That already matches the product — both call `releaseHoldForApplicationQuote`.
 * DRAFT is unreachable through `createFromQuote` (it writes PENDING_DOCS,
 * `applications.ts:2181`) but is retained in the set because the existing guard
 * retains it, and a DRAFT row from legacy data holding the car is the
 * conservative reading.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * PART A / PART B
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *   PART G (G.*) — what is TRUE TODAY AND STAYS TRUE. Green now, green after
 *   M3. If any of these is red, the model behind Part B is wrong and Part B is
 *   built on sand. In round 2 this caught three fixture errors before they
 *   could be misread as missing behaviour.
 *
 *   PART X (also G.*, in its own block) — what is TRUE TODAY AND MUST BECOME
 *   FALSE. FIVE contracts, green today by design, every one of them DELETED by
 *   the M3 commit. The block header carries the rule for what belongs there.
 *
 *   PART B (F.*) — what M3 must do. Red now, each failing at its OWN
 *   finalization assertion and never in setup.
 *
 *   ⚠️ WHICH CONTRACTS DO NOT SURVIVE M3 IS ANSWERED IN ONE PLACE ONLY: the
 *   PART X block header, further down. It lists them, names the Part-B contract
 *   that falsifies each, and states the rule for what belongs there.
 *
 *   Deliberately not restated here. An earlier revision described the set in
 *   both places, the set grew from two to five, and only one copy was updated —
 *   so the file contradicted itself for two review rounds. A count kept in two
 *   places is a count that will disagree with itself.
 *
 * No contract imports a finalization function. Importing something unwritten is
 * a compile error that would turn the whole file red, PARTS G and X included,
 * destroy the only signal the split provides. Every contract asserts observable
 * state after a real product door has run.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * FIXTURE DISCIPLINE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * `ctx.db` seeds org / user / role / customer / vehicle scaffolding and is used
 * for READS. Every ACT under test goes through a real product mutation under a
 * real authenticated identity.
 *
 * ⚠️ ONE NARROW EXCEPTION, AND IT IS THE ONLY ONE: F.28/F.29/F.30 and the
 * retired G.12c patch `vehicleReservations.expiresAt` into the past on a row a
 * REAL door created. That simulates the CLOCK, not the state —
 * `createReservation` refuses a past expiry (vehicles.ts:1556), so an expired
 * reservation cannot be produced any other way without literally waiting, and
 * both sweeps compare the stored `expiresAt` against `Date.now()` with no
 * notion of how it got there. This is categorically unlike fabricating a row in
 * a shape no writer produces, which is what an earlier round was blocked for. There is no write-capable backdoor into quotes,
 * deposits, reservations, applications, sales or the commitment authority, and
 * no test mutation exists to provide one.
 *
 * TWO REAL IDENTITIES, because three separation-of-duties controls sit directly
 * across these paths and each one killed a contract IN SETUP in an earlier
 * round:
 *
 *   - `sales.ts:641` assertDifferentActors — a seller may not cancel their own sale
 *   - `depositHelpers.ts:946` — a deposit's creator may not refund or forfeit it
 *   - `applications.ts:2307` — a salesperson may not approve their own application
 */

import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:sales",
  "edit:sales",
  "view:sales",
  "delete:sales",
  "edit:vehicles",
  "view:vehicles",
  "delete:vehicles",
  "approve:requests",
  "manage:finance",
  "view:finance",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "finalize:financed_deal",
  "verify:finance_documents",
  "register:vehicle_handover",
  "register:expected_payment",
];

const PRICE = 30_000;

/**
 * `commitmentRoots.consumedBySaleId` is Phase-2 implementation work and is not
 * in the schema yet. Reading it through this cast lets a tests-only commit
 * specify the behaviour without the file failing to typecheck today.
 */
function rootSaleStamp(root: Doc<"commitmentRoots">): string | undefined {
  const stamped = (root as unknown as { consumedBySaleId?: Id<"sales"> }).consumedBySaleId;
  return stamped === undefined ? undefined : String(stamped);
}

// ── fixtures ────────────────────────────────────────────────────────────────

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Dealer ${suffix}`, createdAt: Date.now() })
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
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );

  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `user_${suffix}`,
      email: `${suffix}@test.com`,
      name: "Sales User",
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: `user_${suffix}`, clerkId: `user_${suffix}` });

  // The SECOND identity. Same permissions — the controls below are about WHO
  // acted, not about what they are allowed to do, so a permission grant cannot
  // stand in for a second person.
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `mgr_${suffix}`,
      email: `mgr-${suffix}@test.com`,
      name: "Manager",
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId }));
  const asManager = t.withIdentity({ subject: `mgr_${suffix}`, clerkId: `mgr_${suffix}` });

  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "A",
      phone: `+96279221${suffix.length}1`,
      createdAt: Date.now(),
    })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "B",
      phone: `+96279221${suffix.length}2`,
      createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, asUser, managerId, asManager, customerA, customerB };
}

type Seed = Awaited<ReturnType<typeof seedDealer>>;

let vinCounter = 0;
async function vehicle(seed: Seed) {
  vinCounter += 1;
  const vin = `3VWFA7AT${String(700000 + vinCounter).slice(0, 6)}ZZ`;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin,
      make: "Toyota",
      model: "RAV4",
      year: 2023,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 90,
      purchasePrice: 20_000,
      sellingPrice: PRICE,
      status: "AVAILABLE" as const,
      createdAt: Date.now(),
    })
  );
}

async function quoteFor(seed: Seed, customerId: Id<"customers">, vehicles: Array<Id<"vehicles">>) {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId: vehicles[0],
    vehicleItems: vehicles.map((vehicleId) => ({ vehicleId, unitPrice: PRICE })),
    mode: "CASH" as const,
    vehiclePrice: PRICE * vehicles.length,
    downPayment: 0,
    termMonths: 0,
  });
}

async function depositOn(seed: Seed, quoteId: Id<"quotes">, amount: number) {
  return await seed.asUser.mutation(api.deposits.create, {
    orgId: seed.orgId,
    quoteId,
    amount,
  });
}

async function allocate(
  seed: Seed,
  quoteId: Id<"quotes">,
  allocations: Array<{ vehicleId: Id<"vehicles">; amount: number }>
) {
  return await seed.asUser.mutation(api.deposits.allocateToVehicles, {
    orgId: seed.orgId,
    quoteId,
    allocations,
  });
}

async function completeQuote(seed: Seed, quoteId: Id<"quotes">) {
  // Returns one sale id PER LINE ITEM, not a single id.
  return (await seed.asUser.mutation(api.sales.completeFromQuote, {
    orgId: seed.orgId,
    quoteId,
  })) as Array<Id<"sales">>;
}

/**
 * COMPLETION DOOR 1 — a direct completed sale, no quote wizard. Real: the UI
 * uses it. `quoteId` is carried so the sale is tied to the deal whose deposit
 * holds the car.
 */
async function directSale(
  seed: Seed,
  quoteId: Id<"quotes">,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">
) {
  return (await seed.asUser.mutation(api.sales.create, {
    orgId: seed.orgId,
    vehicleId,
    customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
    quoteId,
  })) as Id<"sales">;
}

/**
 * COMPLETION DOOR 3, part one. `sales.createDraft` takes the sale's own fields
 * rather than a quote — `quoteId` is optional and carried so the draft is still
 * tied to the deal whose deposit holds the car. Writing it as `{orgId, quoteId}`
 * would not compile, let alone exercise the door.
 */
async function createDraftFor(
  seed: Seed,
  quoteId: Id<"quotes">,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">
) {
  return await seed.asUser.mutation(api.sales.createDraft, {
    orgId: seed.orgId,
    vehicleId,
    customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
    quoteId,
  });
}

/** The same door, for a single-car quote, with the cardinality asserted. */
async function completeQuoteOne(seed: Seed, quoteId: Id<"quotes">): Promise<Id<"sales">> {
  const ids = await completeQuote(seed, quoteId);
  expect(ids, "fixture: a one-car quote completes into exactly one sale").toHaveLength(1);
  return ids[0];
}

// ── the release doors, as callable product operations ───────────────────────

/** D1 / D2 — the whole deposit row is refunded or forfeited. */
async function releaseDeposit(
  seed: Seed,
  depositId: Id<"deposits">,
  resolution: "REFUNDED" | "FORFEITED"
) {
  // THROUGH THE MANAGER. `releaseHeldDeposit` calls `assertDifferentActors`
  // against `deposit.createdBy`, and the deposit was created by `asUser`.
  return await seed.asManager.mutation(api.deposits.release, {
    orgId: seed.orgId,
    depositId,
    resolution,
    ...(resolution === "REFUNDED" ? { refundMethod: "CASH" as const } : {}),
  });
}

/** D3 — the deposit was recorded in error. */
async function voidDeposit(seed: Seed, depositId: Id<"deposits">) {
  return await seed.asManager.mutation(api.deposits.voidDeposit, {
    orgId: seed.orgId,
    depositId,
    reason: "recorded against the wrong deal",
  });
}

/** D4 — this car leaves the deal. MULTI-VEHICLE QUOTES ONLY; see G.7. */
async function releaseVehicle(seed: Seed, quoteId: Id<"quotes">, vehicleId: Id<"vehicles">) {
  return await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
    orgId: seed.orgId,
    quoteId,
    vehicleId,
    reason: "customer dropped this car from the deal",
  });
}

/** D5 — the reservation is given up. */
async function releaseReservation(seed: Seed, reservationId: Id<"vehicleReservations">) {
  return await seed.asUser.mutation(api.vehicles.releaseReservation, {
    orgId: seed.orgId,
    reservationId,
  });
}

/** D6 — the finance application is turned down. */
async function rejectApplication(seed: Seed, applicationId: Id<"financeApplications">) {
  return await seed.asManager.mutation(api.applications.updateStatus, {
    orgId: seed.orgId,
    applicationId,
    status: "REJECTED" as const,
  });
}

/** D7 — the finance application is voided. */
async function cancelApplication(seed: Seed, applicationId: Id<"financeApplications">) {
  return await seed.asManager.mutation(api.applications.cancelApplication, {
    orgId: seed.orgId,
    applicationId,
    reason: "submitted against the wrong vehicle",
  });
}

// ── acquisition doors ───────────────────────────────────────────────────────

async function reserve(
  seed: Seed,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">,
  extra: Record<string, unknown> = {}
) {
  await seed.asUser.mutation(api.vehicles.createReservation, {
    orgId: seed.orgId,
    vehicleId,
    customerId,
    ...extra,
  });
  // `createReservation` returns the vehicleId, not the reservation. Reading the
  // row back is a READ, not a write backdoor.
  const reservation = await seed.t.run(async (ctx) =>
    (await ctx.db.query("vehicleReservations").collect()).find(
      (r) => r.vehicleId === vehicleId && r.status === "ACTIVE"
    )
  );
  if (!reservation) throw new Error("fixture: createReservation left no ACTIVE reservation");
  return reservation._id;
}

/** An application driven to APPROVED through real doors, approved by the manager. */
async function approvedApplication(seed: Seed, quoteId: Id<"quotes">) {
  const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
    orgId: seed.orgId,
    quoteId,
  });
  await seed.asUser.mutation(api.applications.updateStatus, {
    orgId: seed.orgId,
    applicationId,
    status: "UNDER_REVIEW" as const,
  });
  // A salesperson may not approve their own application (`applications.ts:2307`).
  await seed.asManager.mutation(api.applications.updateStatus, {
    orgId: seed.orgId,
    applicationId,
    status: "APPROVED" as const,
  });
  return applicationId;
}

/**
 * COMPLETION DOOR 4 — the real financed close, product doors only.
 *
 * Modelled on `financeLifecyclePhase1.test.ts:104`, which drives exactly this
 * sequence. `registerHandover` fetches the server-issued economics stamp via
 * `applications.handoverStamp` rather than rebuilding it, so a test cannot pass
 * against a stamp the cockpit never actually projected.
 */
async function financedSale(seed: Seed, applicationId: Id<"financeApplications">) {
  await registerHandover(seed.asUser, api, seed.orgId, applicationId);
  await seed.asUser.mutation(api.applications.registerExpectedPayment, {
    orgId: seed.orgId,
    applicationId,
    method: "CASH" as const,
    expectedDate: Date.now() + 86_400_000,
  });
  return (await seed.asUser.mutation(api.applications.finalizeDeal, {
    orgId: seed.orgId,
    applicationId,
  })) as Id<"sales">;
}

/** Cancellation goes through the MANAGER — the seller may not cancel their own sale. */
async function cancelSale(seed: Seed, saleId: Id<"sales">) {
  return await seed.asManager.mutation(api.sales.update, {
    orgId: seed.orgId,
    saleId,
    status: "CANCELLED" as const,
  });
}

// ── observation ─────────────────────────────────────────────────────────────

/**
 * The audit facts EVERY terminal root must carry, whichever door closed it.
 *
 * Shared so a door cannot be added without them: asserting `closedAt` in some
 * contracts and not others let a door-specific implementation satisfy every
 * contract in this file while leaving the canonical table with no record of
 * when or why a deal ended.
 *
 * (Deliberately no total here. A count written into prose is a fact that goes
 * stale the next time a contract is added, and this file has now shipped four
 * separate stale counts across three review rounds. Say "every", not a number.)
 */
function expectTerminalRoot(
  root: Doc<"commitmentRoots">,
  expected: { status: "CONSUMED" | "RELEASED"; saleId?: string; door: string }
) {
  expect(root.status, `${expected.door}: terminal status`).toBe(expected.status);
  expect(rootSaleStamp(root), `${expected.door}: sale provenance`).toBe(expected.saleId);
  expect(root.closedAt, `${expected.door}: records WHEN the deal ended`).toBeTruthy();
  expect(root.closedReason, `${expected.door}: records WHY`).toBeTruthy();
}

async function rootsOn(seed: Seed, v: Id<"vehicles">) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("commitmentRoots").collect()).filter((r) => r.vehicleId === v)
  );
}

async function claimsOn(seed: Seed, v: Id<"vehicles">) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("vehicleCommitmentClaims").collect()).filter((c) => c.vehicleId === v)
  );
}

async function holdsOn(seed: Seed, v: Id<"vehicles">) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("depositVehicleHolds").collect()).filter((h) => h.vehicleId === v)
  );
}

async function salesCount(seed: Seed) {
  return await seed.t.run(async (ctx) => (await ctx.db.query("sales").collect()).length);
}

async function salesByVehicle(seed: Seed): Promise<Record<string, string>> {
  return await seed.t.run(async (ctx) => {
    const rows = await ctx.db.query("sales").collect();
    return Object.fromEntries(rows.map((s) => [String(s.vehicleId), String(s._id)]));
  });
}

/**
 * A FULL, ORDER-STABLE SNAPSHOT OF EVERY CLAIM DOCUMENT ON A VEHICLE.
 *
 * Round 2 compared a hand-picked subset of six fields, which is a census of what
 * I already suspected might change — it could not have detected a write to
 * `rootId`, `episodeSeq`, `applicationId`, `reservationId`, `quoteId` or
 * `resolvedReason`. Phase 2 is forbidden to write ANY claim field, so the
 * comparison is the whole document or it does not test the prohibition.
 */
async function claimSnapshot(seed: Seed, v: Id<"vehicles">): Promise<string> {
  const claims = await claimsOn(seed, v);
  return JSON.stringify(
    claims
      .map((c) => {
        const entries = Object.entries(c as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        );
        return Object.fromEntries(entries);
      })
      .sort((a, b) => (String(a._id) < String(b._id) ? -1 : 1))
  );
}

/** Nothing at all was written for this vehicle. Used after every refusal. */
async function residueOn(seed: Seed, v: Id<"vehicles">) {
  return {
    roots: (await rootsOn(seed, v)).length,
    claims: (await claimsOn(seed, v)).length,
    sales: Object.prototype.hasOwnProperty.call(await salesByVehicle(seed), String(v)),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PART A — THE SYSTEM AS IT ACTUALLY IS
// ══════════════════════════════════════════════════════════════════════════════

describe("P2-G ground truth the M3 spec is built on", () => {
  test("G.1 a deposit opens exactly one OPEN root", async () => {
    const seed = await seedDealer("g1");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);

    const roots = await rootsOn(seed, v);
    expect(roots).toHaveLength(1);
    expect(roots[0].status, "a live deal holds the car").toBe("OPEN");
    expect(roots[0].customerId).toBe(seed.customerA);
  });

  test("G.2 ONE root carries SEVERAL live episodes — two instalments", async () => {
    const seed = await seedDealer("g2");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 3_000);
    await depositOn(seed, quoteId, 2_000);

    const roots = await rootsOn(seed, v);
    const claims = await claimsOn(seed, v);
    expect(roots, "one deal, one root").toHaveLength(1);
    expect(claims, "each instalment is its own episode").toHaveLength(2);
    expect(
      claims.filter((c) => c.status === "ACTIVE"),
      "AND BOTH ARE LIVE — this is what makes 'consume the live claims' undefinable"
    ).toHaveLength(2);
  });

  test("G.3 and it carries DIFFERENT EVIDENCE KINDS at once — DEPOSIT + FINANCE", async () => {
    const seed = await seedDealer("g3");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId });

    const claims = await claimsOn(seed, v);
    expect(await rootsOn(seed, v), "the application JOINS the deal already holding the car").toHaveLength(1);
    expect(new Set(claims.map((c) => c.evidenceKind))).toEqual(new Set(["DEPOSIT", "FINANCE"]));
    expect(claims.every((c) => c.status === "ACTIVE"), "both kinds live at once").toBe(true);
  });


  // ── D1-D7: every release door runs, and none of them is a sale ────────────
  test("G.6a D1 deposits.release REFUNDED runs on a SINGLE-car deal and creates no sale", async () => {
    const seed = await seedDealer("g6a");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const depositId = await depositOn(seed, quoteId, 5_000);

    await releaseDeposit(seed, depositId, "REFUNDED");

    const deposit = await seed.t.run((ctx) => ctx.db.get(depositId));
    expect(deposit?.status).toBe("REFUNDED");
    expect(deposit?.holdActive, "the operational hold is gone").toBe(false);
    expect(await salesCount(seed), "a release is not a sale").toBe(0);
  });

  test("G.6b D2 deposits.release FORFEITED runs on a SINGLE-car deal and creates no sale", async () => {
    const seed = await seedDealer("g6b");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const depositId = await depositOn(seed, quoteId, 5_000);

    await releaseDeposit(seed, depositId, "FORFEITED");

    const deposit = await seed.t.run((ctx) => ctx.db.get(depositId));
    expect(deposit?.status).toBe("FORFEITED");
    expect(deposit?.holdActive).toBe(false);
    expect(await salesCount(seed)).toBe(0);
  });

  test("G.6c D3 deposits.voidDeposit runs and creates no sale", async () => {
    const seed = await seedDealer("g6c");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const depositId = await depositOn(seed, quoteId, 5_000);

    await voidDeposit(seed, depositId);

    const deposit = await seed.t.run((ctx) => ctx.db.get(depositId));
    expect(deposit?.status).toBe("VOIDED");
    expect(deposit?.holdActive).toBe(false);
    expect(await salesCount(seed)).toBe(0);
  });

  test("G.6d D5 vehicles.releaseReservation runs and creates no sale", async () => {
    const seed = await seedDealer("g6d");
    const v = await vehicle(seed);
    const reservationId = await reserve(seed, v, seed.customerA, { depositAmount: 1_000 });

    await releaseReservation(seed, reservationId);

    const reservation = await seed.t.run((ctx) => ctx.db.get(reservationId));
    expect(reservation?.status).toBe("RELEASED");
    expect(await salesCount(seed)).toBe(0);
  });

  test("G.6e D6 applications.updateStatus(REJECTED) runs and creates no sale", async () => {
    const seed = await seedDealer("g6e");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });

    await rejectApplication(seed, applicationId);

    const app = await seed.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).toBe("REJECTED");
    expect(await salesCount(seed)).toBe(0);
  });

  test("G.6f D7 applications.cancelApplication runs and creates no sale", async () => {
    const seed = await seedDealer("g6f");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });

    await cancelApplication(seed, applicationId);

    const app = await seed.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).toBe("CANCELLED");
    expect(await salesCount(seed)).toBe(0);
  });

  test("G.6g D4 deposits.releaseVehicleAllocation runs on a MULTI-car deal and creates no sale", async () => {
    const seed = await seedDealer("g6g");
    const v1 = await vehicle(seed);
    const v2 = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v1, v2]);
    await depositOn(seed, quoteId, 6_000);
    await allocate(seed, quoteId, [
      { vehicleId: v1, amount: 3_000 },
      { vehicleId: v2, amount: 3_000 },
    ]);

    await releaseVehicle(seed, quoteId, v1);

    const holds = await holdsOn(seed, v1);
    expect(holds.some((h) => h.allocationStatus === "RELEASED_AWAITING_DECISION")).toBe(true);
    expect(await salesCount(seed), "the money is undecided and no sale exists").toBe(0);
  });

  test("G.7 D4 IS STRUCTURALLY UNUSABLE ON A SINGLE-CAR DEPOSIT — the fact that broke round 2", async () => {
    const seed = await seedDealer("g7");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);

    expect(
      await holdsOn(seed, v),
      "deposits.ts:176 — only MULTI-vehicle deposits get a join row per vehicle"
    ).toHaveLength(0);

    await expect(
      releaseVehicle(seed, quoteId, v),
      "so the door round 2 built its whole release side on refuses the commonest walk-in case"
    ).rejects.toThrow(/holds no active share/i);
  });

  test("G.8 a REJECTED application also clears the quote's DEPOSIT holds", async () => {
    const seed = await seedDealer("g8");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const depositId = await depositOn(seed, quoteId, 5_000);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });
    expect(
      (await seed.t.run((ctx) => ctx.db.get(depositId)))?.holdActive,
      "precondition: the deposit is holding the car before the rejection"
    ).toBe(true);

    await rejectApplication(seed, applicationId);

    const deposit = await seed.t.run((ctx) => ctx.db.get(depositId));
    expect(
      deposit?.holdActive,
      "releaseHoldForApplicationQuote releases EVERY deposit hold on the quote, not only the finance basis"
    ).toBe(false);
    expect(deposit?.status, "but the MONEY is untouched and still needs a human decision").toBe("HELD");
  });

  // ⚠️ The refusals below are pinned to the finance guard's own message on
  // purpose. A bare `.rejects.toThrow()` here would also have been satisfied by
  // the COMMITMENT authority refusing the same call, which would have made this
  // contract silently test something other than what it names. Verified
  // empirically: `IN_FLIGHT_STATUSES` (applications.ts:2050) answers first.
  // ⚠️ DRAFT IS DELIBERATELY NOT EXERCISED, AND THE TITLE IS NARROWED TO SAY SO.
  //
  // `createFromQuote` writes PENDING_DOCS (applications.ts:2182), so DRAFT is
  // unreachable through every product door. Pinning it would need a fabricated
  // row, which is the fixture dishonesty this file refuses everywhere else.
  //
  // DRAFT's coverage is therefore STRUCTURAL, not behavioural: the header
  // requires M3 to hoist and REUSE `IN_FLIGHT_STATUSES` rather than restate it,
  // and DRAFT comes with it. If M3 restates the list instead, that requirement
  // is already violated and this omission is the least of it.
  test("G.9 the finance in-flight set blocks a rival application at every REACHABLE in-flight status", async () => {
    const seed = await seedDealer("g9");
    const v = await vehicle(seed);
    const q1 = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId: q1,
    });
    const q2 = await quoteFor(seed, seed.customerB, [v]);
    const rivalBlocked = () =>
      expect(
        seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: q2 })
      ).rejects.toThrow(/already has an active finance application/i);

    await rivalBlocked(); // PENDING_DOCS

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "UNDER_REVIEW" as const,
    });
    await rivalBlocked(); // UNDER_REVIEW

    // APPROVED. Round 3 originally stopped before this, so the contract never
    // exercised the status that matters most to the release predicate.
    await seed.asManager.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "APPROVED" as const,
    });
    await rivalBlocked(); // APPROVED
  });

  test("G.10 a finance application alone does NOT make the vehicle RESERVED", async () => {
    const seed = await seedDealer("g10");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId });

    const vrow = await seed.t.run((ctx) => ctx.db.get(v));
    expect(
      vrow?.status,
      "syncVehicleHoldStatus computes hasHold from DEPOSIT|RESERVATION only — finance is not in it, " +
        "so M3 must NOT reuse it as the canonical basis predicate"
    ).toBe("AVAILABLE");
    expect(
      (await rootsOn(seed, v))[0]?.status,
      "while the CANONICAL root is OPEN — the two notions already diverge, and that is by design"
    ).toBe("OPEN");
  });

  test("G.11 a reservation opens a root carrying RESERVATION evidence", async () => {
    const seed = await seedDealer("g11");
    const v = await vehicle(seed);
    const reservationId = await reserve(seed, v, seed.customerA, { depositAmount: 1_000 });

    const roots = await rootsOn(seed, v);
    const claims = await claimsOn(seed, v);
    expect(roots).toHaveLength(1);
    expect(roots[0].status).toBe("OPEN");
    expect(roots[0].originReservationId, "the deal began life as a reservation").toBe(reservationId);
    expect(claims.map((c) => c.evidenceKind)).toEqual(["RESERVATION"]);
  });

  test("G.12 a cancelled sale leaves the canonical commitment history untouched", async () => {
    const seed = await seedDealer("g12");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    const saleId = await completeQuoteOne(seed, quoteId);
    const before = await claimSnapshot(seed, v);

    await cancelSale(seed, saleId);

    expect(
      await claimSnapshot(seed, v),
      "cancellation is Phase 3's; today it performs zero canonical commitment work"
    ).toBe(before);
  });

  test("G.13 a root carries 60+ live episodes built by REAL production acquisitions", async () => {
    const seed = await seedDealer("g13");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    // Real instalments through the real door. Round 2 fabricated these rows with
    // ctx.db and got the shape wrong: `CommitmentEvidence` REQUIRES `depositId`
    // for kind DEPOSIT (`commitments.ts:96`), so those 60 rows could not have
    // been produced by any writer in the system.
    for (let i = 0; i < 60; i += 1) {
      await depositOn(seed, quoteId, 100);
    }

    const claims = await claimsOn(seed, v);
    expect(claims.length, "sixty instalments, sixty episodes").toBe(60);
    expect(claims.every((c) => c.status === "ACTIVE")).toBe(true);
    expect(claims.every((c) => c.evidenceKind === "DEPOSIT")).toBe(true);
    expect(await rootsOn(seed, v), "all on ONE root").toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PART X — THE GAP AS IT EXISTS TODAY.
//
// ⚠️⚠️ DELETE THIS ENTIRE BLOCK IN THE M3 COMMIT. Every contract in it asserts
// behaviour that a CORRECT M3 makes false. They are here as evidence that the
// gap is real and reachable, not as invariants.
//
// THE RULE THAT PUTS A CONTRACT HERE, so the next author does not have to
// rediscover it:
//
//     A Part-A contract that pins today's BROKEN behaviour, whose Part-B
//     counterpart REQUIRES that behaviour to change, is BY CONSTRUCTION a
//     demolition marker. It belongs in PART X, not in PART G.
//
// This grouping exists because per-test markers did not survive contact with
// the next round. One seat found G.4/G.5 unmarked; the remediation marked them
// and then added THREE more unmarked ones (G.9b, G.12b, G.12c) in the same
// commit, because the fix addressed the instances and not the class. A block
// name cannot be forgotten the way a comment can.
//
//     G.4   completion leaves the root OPEN        -> falsified by F.1
//     G.5   release leaves the root OPEN           -> falsified by F.14-F.19
//     G.9b  ending the application leaves it locked-> falsified by F.34
//     G.12b a committed car can be soft-deleted    -> falsified by F.31
//     G.12c an expired reservation locks the car   -> falsified by F.28
// ══════════════════════════════════════════════════════════════════════════════

describe("P2-X the gap as it exists today — DELETE WITH THE M3 COMMIT", () => {

  test("G.4 a completed sale leaves the root OPEN and unstamped", async () => {
    const seed = await seedDealer("g4");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    await completeQuote(seed, quoteId);

    const roots = await rootsOn(seed, v);
    expect(roots).toHaveLength(1);
    expect(roots[0].status, "THE GAP: the sale happened and the canonical root never noticed").toBe("OPEN");
    expect(rootSaleStamp(roots[0]), "and nothing records which sale consumed it").toBeUndefined();
  });

  test("G.5 and NEITHER does a release: nothing has ever written a terminal root", async () => {
    const seed = await seedDealer("g5");
    const v1 = await vehicle(seed);
    const v2 = await vehicle(seed);
    const q1 = await quoteFor(seed, seed.customerA, [v1]);
    const q2 = await quoteFor(seed, seed.customerB, [v2]);
    await depositOn(seed, q1, 5_000);
    await depositOn(seed, q2, 5_000);
    await completeQuote(seed, q1);
    const dep2 = await seed.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).find((d) => d.quoteId === q2)
    );
    await releaseDeposit(seed, dep2!._id, "FORFEITED");

    const all = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    expect(all.length, "a sale on one car and a forfeit on another").toBeGreaterThanOrEqual(2);
    expect(
      all.map((r) => r.status),
      "the terminal states are representable in the schema and NOTHING writes them"
    ).toEqual(all.map(() => "OPEN"));
  });

  test("G.9b TODAY ending the application does NOT free the car — the finance guard yields but the root does not", async () => {
    const seed = await seedDealer("g9b");
    const v = await vehicle(seed);
    const q1 = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId: q1,
    });

    await cancelApplication(seed, applicationId);
    expect((await seed.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");

    const q2 = await quoteFor(seed, seed.customerB, [v]);
    await expect(
      seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: q2 }),
      "the CANCELLED row has left the in-flight set, so this refusal is the COMMITMENT authority's, " +
        "not the finance guard's — the car is still locked because nothing releases the root. " +
        "F.34 is the same scenario after M3"
    ).rejects.toThrow(/already committed to another deal/i);
  });

  test("G.12b TODAY a committed car can be SOFT-DELETED out of inventory", async () => {
    const seed = await seedDealer("g12b");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId });
    expect(
      (await seed.t.run((ctx) => ctx.db.get(v)))?.status,
      "precondition (G.10): a FINANCE-only commitment leaves the car AVAILABLE"
    ).toBe("AVAILABLE");

    await seed.asUser.mutation(api.vehicles.softDelete, { orgId: seed.orgId, vehicleId: v });

    expect(
      (await seed.t.run((ctx) => ctx.db.get(v)))?.isDeleted,
      "vehicles.ts:2070 refuses only SOLD and RESERVED, so a finance-held car sails through"
    ).toBe(true);
    expect(
      (await rootsOn(seed, v))[0].status,
      "leaving an OPEN root and a live application pointing at deleted inventory, " +
        "and the vehicle-centric workflow that would reach D1-D7 is gone with it. " +
        "The application-side doors stay callable by id, so this is a workflow dead-end " +
        "rather than an API-level one — which is enough to strand the car in practice"
    ).toBe("OPEN");
  });

  test("G.12c TODAY an EXPIRED reservation leaves its root OPEN with no door left to close it", async () => {
    const seed = await seedDealer("g12c");
    const v = await vehicle(seed);
    const reservationId = await reserve(seed, v, seed.customerA, { depositAmount: 1_000 });
    // Only the CLOCK is simulated — the row was written by the real door, and
    // expiry is the one thing a test cannot wait for. createReservation refuses
    // a past expiresAt, so it cannot be seeded this way in the first place.
    await seed.t.run((ctx) => ctx.db.patch(reservationId, { expiresAt: Date.now() - 60_000 }));

    await seed.t.mutation(internal.vehicles.expireReservations, {});

    expect(
      (await seed.t.run((ctx) => ctx.db.get(reservationId)))?.status,
      "the sweep expires it"
    ).toBe("EXPIRED");
    expect(
      (await rootsOn(seed, v))[0].status,
      "but the root stays OPEN — and releaseReservation requires status ACTIVE (vehicles.ts:1813), " +
        "so NO door can ever release this root. That is a permanent lock, which is why D8/D9 " +
        "could not remain a declared gap"
    ).toBe("OPEN");
  });

});

// ══════════════════════════════════════════════════════════════════════════════
// PART B — WHAT M3 MUST DO. RED UNTIL IT EXISTS.
// ══════════════════════════════════════════════════════════════════════════════

describe("P2-F M3 finalization barrier — CONSUME", () => {
  test("F.1 a completed sale CONSUMES the root, stamps the sale, and leaves every claim byte-identical", async () => {
    const seed = await seedDealer("f1");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    const before = await claimSnapshot(seed, v);

    const saleId = await completeQuoteOne(seed, quoteId);

    const roots = await rootsOn(seed, v);
    expect(roots).toHaveLength(1);
    expect(roots[0].status, "the deal completed into a sale").toBe("CONSUMED");
    expect(rootSaleStamp(roots[0]), "and the root names the exact sale that consumed it").toBe(String(saleId));
    expect(
      roots[0].closedAt,
      "and it records WHEN the deal ended. Without this every contract here is satisfied by an " +
        "implementation that never sets closedAt, and the field exists on the table for exactly this"
    ).toBeTruthy();
    expect(
      roots[0].closedReason,
      "and WHY — every comparable terminal transition in this lifecycle records a reason " +
        "(reservations releasedBy, deposits resolutionReason, applications cancellationReason)"
    ).toBeTruthy();
    expect(await claimSnapshot(seed, v), "B+: Phase 2 writes NO claim field at all").toBe(before);
  });

  test("F.2 a genuinely FREE walk-in car sells without inventing a deal to close", async () => {
    const seed = await seedDealer("f2");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    expect((await rootsOn(seed, v)).length, "precondition: nobody committed this car").toBe(0);

    const saleIds = await completeQuote(seed, quoteId);

    // ⚠️ THE CARDINALITY ASSERTION IS THE CONTROL. Round 2 had it; the round-3
    // rebuild dropped it, which left this "deliberate control" satisfied by an
    // implementation that returns [] and sells nothing at all.
    expect(saleIds.length, "the walk-in sale actually completes").toBe(1);
    const sale = await seed.t.run((ctx) => ctx.db.get(saleIds[0]));
    expect(sale?.vehicleId, "for this car").toBe(v);
    expect(sale?.customerId, "and this customer").toBe(seed.customerA);
    expect(
      (await seed.t.run((ctx) => ctx.db.get(v)))?.status,
      "and the car really left inventory"
    ).toBe("SOLD");
    expect(
      (await rootsOn(seed, v)).length,
      "and no root was invented to give finalization something to close"
    ).toBe(0);
  });

  test("F.3 a RIVAL customer's sale on a held car is REFUSED, with zero residue", async () => {
    const seed = await seedDealer("f3");
    const v = await vehicle(seed);
    const held = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, held, 5_000);
    const rival = await quoteFor(seed, seed.customerB, [v]);

    await expect(completeQuote(seed, rival)).rejects.toThrow();

    const roots = await rootsOn(seed, v);
    expect(roots, "still exactly one root").toHaveLength(1);
    expect(roots[0].status, "and the refusal changed nothing about it").toBe("OPEN");
    expect(roots[0].customerId).toBe(seed.customerA);
    expect((await residueOn(seed, v)).sales, "no sale row was left behind").toBe(false);
  });

  test("F.4 the SAME customer on a DIFFERENT deal is refused too — identity is the root, not the person", async () => {
    const seed = await seedDealer("f4");
    const v = await vehicle(seed);
    const held = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, held, 5_000);
    const other = await quoteFor(seed, seed.customerA, [v]);

    await expect(completeQuote(seed, other)).rejects.toThrow();

    expect((await rootsOn(seed, v))[0].status).toBe("OPEN");
    expect((await residueOn(seed, v)).sales).toBe(false);
  });

  test("F.5 a 2-car deal terminalizes each root against ITS OWN sale", async () => {
    const seed = await seedDealer("f5");
    const v1 = await vehicle(seed);
    const v2 = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v1, v2]);
    await depositOn(seed, quoteId, 6_000);
    await allocate(seed, quoteId, [
      { vehicleId: v1, amount: 3_000 },
      { vehicleId: v2, amount: 3_000 },
    ]);

    await completeQuote(seed, quoteId);

    const sales = await salesByVehicle(seed);
    for (const v of [v1, v2]) {
      const root = (await rootsOn(seed, v))[0];
      expect(root.status).toBe("CONSUMED");
      expect(rootSaleStamp(root), "each car's root names the sale for THAT car").toBe(sales[String(v)]);
    }
  });

  test("F.6 a 3-car deal does the same, with three distinct stamps", async () => {
    const seed = await seedDealer("f6");
    const vs = [await vehicle(seed), await vehicle(seed), await vehicle(seed)];
    const quoteId = await quoteFor(seed, seed.customerA, vs);
    await depositOn(seed, quoteId, 9_000);
    await allocate(seed, quoteId, vs.map((vehicleId) => ({ vehicleId, amount: 3_000 })));

    await completeQuote(seed, quoteId);

    const sales = await salesByVehicle(seed);
    const stamps: string[] = [];
    for (const v of vs) {
      const root = (await rootsOn(seed, v))[0];
      expect(root.status).toBe("CONSUMED");
      expect(rootSaleStamp(root)).toBe(sales[String(v)]);
      stamps.push(rootSaleStamp(root)!);
    }
    expect(new Set(stamps).size, "three cars, three DISTINCT sales").toBe(3);
  });

  test("F.7 completion order does not change any car's outcome — including WHICH sale stamped it", async () => {
    async function run(order: 0 | 1) {
      const seed = await seedDealer(`f7-${order}`);
      const a = await vehicle(seed);
      const b = await vehicle(seed);
      const first = order === 0 ? a : b;
      const second = order === 0 ? b : a;
      const q1 = await quoteFor(seed, seed.customerA, [first]);
      const q2 = await quoteFor(seed, seed.customerB, [second]);
      await depositOn(seed, q1, 5_000);
      await depositOn(seed, q2, 5_000);
      await completeQuote(seed, q1);
      await completeQuote(seed, q2);

      const sales = await salesByVehicle(seed);
      const out: Record<string, { status: string; ownSale: boolean }> = {};
      for (const [label, v] of [["first", first], ["second", second]] as const) {
        const root = (await rootsOn(seed, v))[0];
        out[label] = {
          status: root.status,
          // Compared against THIS car's OWN sale id, not a shared literal — a
          // cross-stamped root would otherwise pass.
          ownSale: rootSaleStamp(root) === sales[String(v)],
        };
      }
      return out;
    }

    const forwards = await run(0);
    const backwards = await run(1);
    expect(forwards).toEqual({
      first: { status: "CONSUMED", ownSale: true },
      second: { status: "CONSUMED", ownSale: true },
    });
    expect(backwards).toEqual(forwards);
  });

  test("F.8a DOOR 1 sales.create — a direct completed sale terminalizes the root", async () => {
    const seed = await seedDealer("f8a");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    expect((await rootsOn(seed, v))[0]?.status, "precondition: the car is held").toBe("OPEN");

    const saleId = await directSale(seed, quoteId, v, seed.customerA);

    const root = (await rootsOn(seed, v))[0];
    expectTerminalRoot(root, { status: "CONSUMED", saleId: String(saleId), door: "sales.create" });
  });

  test("F.8b DOOR 2 sales.completeFromQuote terminalizes the root", async () => {
    const seed = await seedDealer("f8b");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    expect((await rootsOn(seed, v))[0]?.status, "precondition: the car is held").toBe("OPEN");

    const saleId = await completeQuoteOne(seed, quoteId);

    const root = (await rootsOn(seed, v))[0];
    expectTerminalRoot(root, { status: "CONSUMED", saleId: String(saleId), door: "completeFromQuote" });
  });

  test("F.8c DOOR 3 sales.completeDraft terminalizes the root", async () => {
    const seed = await seedDealer("f8c");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    const draftId = await createDraftFor(seed, quoteId, v, seed.customerA);
    expect(
      (await rootsOn(seed, v))[0]?.status,
      "precondition: a DRAFT is not a completion — the root is still open"
    ).toBe("OPEN");

    await seed.asUser.mutation(api.sales.completeDraft, { orgId: seed.orgId, saleId: draftId });

    expectTerminalRoot((await rootsOn(seed, v))[0], {
      status: "CONSUMED",
      saleId: (await salesByVehicle(seed))[String(v)],
      door: "completeDraft",
    });
  });

  test("F.8d DOOR 4 applications.finalizeDeal — the real financed close — terminalizes the root", async () => {
    const seed = await seedDealer("f8d");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    const applicationId = await approvedApplication(seed, quoteId);
    expect(
      (await rootsOn(seed, v))[0]?.status,
      "precondition: DEPOSIT and FINANCE evidence on ONE open root"
    ).toBe("OPEN");

    const saleId = await financedSale(seed, applicationId);

    expectTerminalRoot((await rootsOn(seed, v))[0], {
      status: "CONSUMED",
      saleId: String(saleId),
      door: "finalizeDeal",
    });
  });

  test("F.9a DOOR 1 sales.create refuses a rival, with zero residue", async () => {
    const seed = await seedDealer("f9a");
    const v = await vehicle(seed);
    await depositOn(seed, await quoteFor(seed, seed.customerA, [v]), 5_000);
    const rival = await quoteFor(seed, seed.customerB, [v]);

    await expect(
      directSale(seed, rival, v, seed.customerB),
      "a direct sale must not be able to sell a car another deal holds"
    ).rejects.toThrow();

    expect((await residueOn(seed, v)).sales, "no sale row was left behind").toBe(false);
    expect((await rootsOn(seed, v))[0].customerId, "the holder is unchanged").toBe(seed.customerA);
    expect((await rootsOn(seed, v))[0].status).toBe("OPEN");
  });

  test("F.9a2 DOOR 1 with NO LINEAGE AT ALL is refused on a held car", async () => {
    const seed = await seedDealer("f9a2");
    const v = await vehicle(seed);
    await depositOn(seed, await quoteFor(seed, seed.customerA, [v]), 5_000);

    // ⚠️ A SHAPE NO OTHER DOOR CAN PRODUCE. `quoteId` is OPTIONAL on
    // sales.create (sales.ts:333), so a manual "Add Sale" can complete with no
    // lineage proof whatsoever — and prepareSaleCompletion refuses only SOLD and
    // ARCHIVED, never a held car. The authority's existing rule is the
    // consistent answer: no lineage on a held car means REFUSE.
    await expect(
      seed.asUser.mutation(api.sales.create, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerB,
        salespersonId: seed.userId,
        salePrice: PRICE,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
      }),
      "an unlineaged manual sale must not be able to take a car a deal holds"
    ).rejects.toThrow();

    expect((await residueOn(seed, v)).sales).toBe(false);
    expect((await rootsOn(seed, v))[0].customerId).toBe(seed.customerA);
  });

  test("F.9b DOOR 2 sales.completeFromQuote refuses a rival, with zero residue", async () => {
    const seed = await seedDealer("f9b");
    const v = await vehicle(seed);
    await depositOn(seed, await quoteFor(seed, seed.customerA, [v]), 5_000);
    const rival = await quoteFor(seed, seed.customerB, [v]);

    await expect(completeQuote(seed, rival)).rejects.toThrow();

    expect((await residueOn(seed, v)).sales).toBe(false);
    expect((await rootsOn(seed, v))[0].customerId).toBe(seed.customerA);
  });

  test("F.9c DOOR 3 sales.completeDraft refuses a rival no later than completion", async () => {
    const seed = await seedDealer("f9c");
    const v = await vehicle(seed);
    await depositOn(seed, await quoteFor(seed, seed.customerA, [v]), 5_000);
    const rival = await quoteFor(seed, seed.customerB, [v]);

    // A draft may legitimately be created — it commits nothing. The barrier is
    // required no later than completion, so the whole sequence is the assertion.
    await expect(
      (async () => {
        const draftId = await createDraftFor(seed, rival, v, seed.customerB);
        return await seed.asUser.mutation(api.sales.completeDraft, {
          orgId: seed.orgId,
          saleId: draftId,
        });
      })()
    ).rejects.toThrow();

    expect((await rootsOn(seed, v))[0].customerId).toBe(seed.customerA);
    expect((await rootsOn(seed, v))[0].status).toBe("OPEN");
  });

  test("F.9d DOOR 4 the financed path refuses a rival at the door that acquires", async () => {
    const seed = await seedDealer("f9d");
    const v = await vehicle(seed);
    await depositOn(seed, await quoteFor(seed, seed.customerA, [v]), 5_000);
    const rival = await quoteFor(seed, seed.customerB, [v]);

    // ⚠️ THIS IS A CONTROL, NOT AN M3 CONTRACT, AND IT IS GREEN TODAY.
    //
    // On the ORDINARY rival path a competitor never reaches finalizeDeal at
    // all: `createFromQuote` acquires, and the Phase-1 authority refuses there.
    // This contract pins that, and that the refusal leaves nothing behind.
    //
    // ⚠️ IT IS NOT A CLAIM THAT COMPLETION-TIME OWNERSHIP CANNOT BREAK. An
    // earlier round argued exactly that — "an APPROVED application IS a live
    // FINANCE basis, so its car cannot belong to another root" — and it was
    // WRONG. A sale through a different door followed by a cancellation leaves
    // the root CONSUMED and the application still APPROVED, so the two fall out
    // of correspondence. F.9e drives that sequence and requires finalizeDeal to
    // refuse. Read the two together: F.9d is the ordinary path, F.9e is the
    // exception that disproves the tempting invariant.
    await expect(
      seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: rival })
    ).rejects.toThrow();

    expect((await residueOn(seed, v)).sales).toBe(false);
    expect(
      (await seed.t.run((ctx) => ctx.db.query("financeApplications").collect())).length,
      "and no application row was left behind either"
    ).toBe(0);
    expect((await rootsOn(seed, v))[0].customerId).toBe(seed.customerA);
  });

  test("F.9e DOOR 4 finalizeDeal REFUSES once the car has legitimately moved to another deal", async () => {
    const seed = await seedDealer("f9e");
    const v = await vehicle(seed);
    const quoteA = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteA, 5_000);
    const applicationId = await approvedApplication(seed, quoteA);
    await registerHandover(seed.asUser, api, seed.orgId, applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId,
      applicationId,
      method: "CASH" as const,
      expectedDate: Date.now() + 86_400_000,
    });

    // The deal is closed through a DIFFERENT door — a direct sale on the same
    // quote, which F.8a requires to consume the root.
    const saleId = await directSale(seed, quoteA, v, seed.customerA);
    expect(
      (await rootsOn(seed, v))[0].status,
      "precondition (F.8a): the direct sale consumed the root"
    ).toBe("CONSUMED");

    // The sale is then cancelled. F.27 requires the root to STAY CONSUMED — and
    // `saleCancellation.ts` contains zero references to `financeApplications`,
    // so the application never learns and remains APPROVED.
    await cancelSale(seed, saleId);
    expect(
      (await seed.t.run((ctx) => ctx.db.get(applicationId)))?.status,
      "the application is untouched by the cancellation"
    ).toBe("APPROVED");

    // The car is genuinely free now, so another customer legitimately takes it.
    const quoteB = await quoteFor(seed, seed.customerB, [v]);
    await depositOn(seed, quoteB, 4_000);
    expect(
      (await rootsOn(seed, v)).find((r) => r.status === "OPEN")?.customerId,
      "customer B now holds the car"
    ).toBe(seed.customerB);

    // ⚠️ THIS IS THE STATE I ARGUED WAS UNREACHABLE, AND I WAS WRONG.
    //
    // Round 3b rejected this contract on the reasoning that "an APPROVED
    // application IS a live FINANCE basis, so its car cannot belong to another
    // root". A sale-then-cancel breaks that correspondence: the root goes
    // CONSUMED and STAYS CONSUMED (F.27), while the application is never told.
    // Every finalizeDeal precondition — APPROVED, vehicleHandoverAt,
    // expectedPayment — is still satisfied, so only a COMPLETION-TIME ownership
    // check stops it selling customer B's car out from under them.
    //
    // The lesson is about evidence, not about this contract: one seat searched
    // for a sequence and failed, the other constructed one. A failed search is
    // not a proof of absence.
    await expect(
      seed.asUser.mutation(api.applications.finalizeDeal, {
        orgId: seed.orgId,
        applicationId,
      }),
      "a stale APPROVED application must not be able to complete against a car another deal holds"
    ).rejects.toThrow();

    expect(
      (await rootsOn(seed, v)).find((r) => r.status === "OPEN")?.customerId,
      "customer B still holds it"
    ).toBe(seed.customerB);
    expect(
      (await seed.t.run((ctx) => ctx.db.query("sales").collect())).filter(
        (x) => x.status !== "CANCELLED"
      ),
      "and no second live sale was created"
    ).toHaveLength(0);
  });

  test("F.10 one sale stamps exactly one root — sale -> root provenance is a function", async () => {
    const seed = await seedDealer("f10");
    const vs = [await vehicle(seed), await vehicle(seed), await vehicle(seed)];
    const quoteId = await quoteFor(seed, seed.customerA, vs);
    await depositOn(seed, quoteId, 9_000);
    await allocate(seed, quoteId, vs.map((vehicleId) => ({ vehicleId, amount: 3_000 })));

    await completeQuote(seed, quoteId);

    const roots = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    const stamped = roots.map(rootSaleStamp).filter((s): s is string => s !== undefined);
    expect(stamped.length, "every consumed root is stamped").toBe(3);
    expect(
      new Set(stamped).size,
      "and no sale id stamps two roots — this is what lets Phase 3 look up a cancelled sale's root " +
        "by index instead of reconstructing it. Requires a by_consumed_sale index ON commitmentRoots; " +
        "today that index exists only on vehicleCommitmentClaims (schema.ts:3002)."
    ).toBe(3);
  });

  test("F.11 terminalization is monotonic — a consumed root is never reopened or re-stamped", async () => {
    const seed = await seedDealer("f11");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    const saleId = await completeQuoteOne(seed, quoteId);

    const root = (await rootsOn(seed, v))[0];
    expect(root.status).toBe("CONSUMED");
    expect(rootSaleStamp(root)).toBe(String(saleId));

    // A second completion attempt on the same quote must not move it.
    await completeQuote(seed, quoteId).catch(() => undefined);

    const after = (await rootsOn(seed, v))[0];
    expect(after.status, "still CONSUMED").toBe("CONSUMED");
    expect(rootSaleStamp(after), "write-once: the first sale keeps the stamp").toBe(String(saleId));
    expect(after.closedAt, "and the original close time is not overwritten").toBe(root.closedAt);
  });

  test("F.12 finalization is indifferent to 61 live episodes — it neither scans nor patches them", async () => {
    const seed = await seedDealer("f12");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    for (let i = 0; i < 61; i += 1) {
      await depositOn(seed, quoteId, 100);
    }
    const before = await claimSnapshot(seed, v);
    expect((await claimsOn(seed, v)).length, "precondition: 61 real episodes").toBe(61);

    const saleId = await completeQuoteOne(seed, quoteId);

    const root = (await rootsOn(seed, v))[0];
    expect(root.status).toBe("CONSUMED");
    expect(rootSaleStamp(root)).toBe(String(saleId));
    expect(
      await claimSnapshot(seed, v),
      "all 61 stay ACTIVE and byte-identical — which is also why claim.status is NOT a liveness signal"
    ).toBe(before);
  });

  test("F.13 a root holding DEPOSIT and FINANCE episodes is consumed once, and neither episode moves", async () => {
    const seed = await seedDealer("f13");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    const applicationId = await approvedApplication(seed, quoteId);
    const before = await claimSnapshot(seed, v);
    expect(new Set((await claimsOn(seed, v)).map((c) => c.evidenceKind))).toEqual(
      new Set(["DEPOSIT", "FINANCE"])
    );

    const saleId = await financedSale(seed, applicationId);

    const roots = await rootsOn(seed, v);
    expect(roots, "one root, consumed once — not once per evidence kind").toHaveLength(1);
    expect(roots[0].status).toBe("CONSUMED");
    expect(rootSaleStamp(roots[0])).toBe(String(saleId));
    expect(await claimSnapshot(seed, v)).toBe(before);
  });
});

describe("P2-F M3 finalization barrier — RELEASE", () => {
  /**
   * The shared shape of D1-D7 when the released basis is the ONLY one holding
   * the car: the root must end RELEASED, no sale may exist, and no claim may
   * move. Each door gets its own `test()` so a failure names the door.
   */
  async function expectSoleBasisReleases(
    seed: Seed,
    v: Id<"vehicles">,
    door: () => Promise<unknown>,
    doorName: string
  ) {
    const before = await claimSnapshot(seed, v);
    expect((await rootsOn(seed, v))[0]?.status, `precondition: ${doorName} starts from an OPEN root`).toBe("OPEN");

    await door();

    const roots = await rootsOn(seed, v);
    expect(roots, `${doorName}: still exactly one root`).toHaveLength(1);
    expectTerminalRoot(roots[0], { status: "RELEASED", door: doorName });
    expect(await salesCount(seed), `${doorName}: no sale exists`).toBe(0);
    expect(await claimSnapshot(seed, v), `${doorName}: B+ writes no claim field`).toBe(before);
  }

  test("F.14 D1 refunding the sole deposit RELEASES the root", async () => {
    const seed = await seedDealer("f14");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const depositId = await depositOn(seed, quoteId, 5_000);
    await expectSoleBasisReleases(seed, v, () => releaseDeposit(seed, depositId, "REFUNDED"), "deposits.release REFUNDED");
  });

  test("F.15 D2 forfeiting the sole deposit RELEASES the root", async () => {
    const seed = await seedDealer("f15");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const depositId = await depositOn(seed, quoteId, 5_000);
    await expectSoleBasisReleases(seed, v, () => releaseDeposit(seed, depositId, "FORFEITED"), "deposits.release FORFEITED");
  });

  test("F.16 D3 voiding the sole deposit RELEASES the root", async () => {
    const seed = await seedDealer("f16");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const depositId = await depositOn(seed, quoteId, 5_000);
    await expectSoleBasisReleases(seed, v, () => voidDeposit(seed, depositId), "deposits.voidDeposit");
  });

  test("F.17 D5 releasing the sole reservation RELEASES the root", async () => {
    const seed = await seedDealer("f17");
    const v = await vehicle(seed);
    const reservationId = await reserve(seed, v, seed.customerA, { depositAmount: 1_000 });
    await expectSoleBasisReleases(seed, v, () => releaseReservation(seed, reservationId), "vehicles.releaseReservation");
  });

  test("F.18 D6 rejecting the sole finance application RELEASES the root", async () => {
    const seed = await seedDealer("f18");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });
    await expectSoleBasisReleases(seed, v, () => rejectApplication(seed, applicationId), "updateStatus(REJECTED)");
  });

  test("F.19 D7 cancelling the sole finance application RELEASES the root", async () => {
    const seed = await seedDealer("f19");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });
    await expectSoleBasisReleases(seed, v, () => cancelApplication(seed, applicationId), "cancelApplication");
  });

  test("F.20 D4 SCRUM-199: a never-sold car leaving a multi-car deal RELEASES its root while the money stays undecided", async () => {
    const seed = await seedDealer("f20");
    const v1 = await vehicle(seed);
    const v2 = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v1, v2]);
    const depositId = await depositOn(seed, quoteId, 6_000);
    await allocate(seed, quoteId, [
      { vehicleId: v1, amount: 3_000 },
      { vehicleId: v2, amount: 3_000 },
    ]);

    await releaseVehicle(seed, quoteId, v1);

    // D4 is the ONE door outside the shared release helper, because it needs a
    // multi-car fixture — which is exactly how it slipped the audit contract
    // every other door gets. It asserts through the same helper here.
    expectTerminalRoot((await rootsOn(seed, v1))[0], {
      status: "RELEASED",
      door: "releaseVehicleAllocation — the car is free the moment it leaves the deal",
    });
    expect(
      (await rootsOn(seed, v2))[0].status,
      "and the car still on the deal is untouched — release is per-car, not per-quote"
    ).toBe("OPEN");
    expect(
      (await seed.t.run((ctx) => ctx.db.get(depositId)))?.status,
      "THE ROOT LOCKS THE CAR, IT DOES NOT LOCK THE CASH — the money is still HELD and undecided"
    ).toBe("HELD");
    expect(
      (await holdsOn(seed, v1)).some((h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"),
      "the slice is awaiting a human decision"
    ).toBe(true);
  });

  test("F.21 a RIVAL can then genuinely acquire AND SELL that released car", async () => {
    const seed = await seedDealer("f21");
    const v1 = await vehicle(seed);
    const v2 = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v1, v2]);
    await depositOn(seed, quoteId, 6_000);
    await allocate(seed, quoteId, [
      { vehicleId: v1, amount: 3_000 },
      { vehicleId: v2, amount: 3_000 },
    ]);
    await releaseVehicle(seed, quoteId, v1);
    expect((await rootsOn(seed, v1))[0].status, "precondition: released").toBe("RELEASED");

    // The rival's acquisition AND completion are asserted steps, not setup — if
    // either throws, this contract fails at its own assertion.
    const rivalQuote = await quoteFor(seed, seed.customerB, [v1]);
    await expect(depositOn(seed, rivalQuote, 4_000), "the rival may acquire it").resolves.toBeDefined();
    const rivalSale = await completeQuoteOne(seed, rivalQuote);

    const roots = await rootsOn(seed, v1);
    expect(roots.length, "a historical RELEASED root plus the rival's own").toBe(2);
    const open = roots.filter((r) => r.status !== "RELEASED");
    expect(open, "exactly one non-released root").toHaveLength(1);
    expect(open[0].customerId, "and it belongs to the rival").toBe(seed.customerB);
    expect(open[0].status, "which their sale then consumed").toBe("CONSUMED");
    expect(rootSaleStamp(open[0])).toBe(String(rivalSale));
  });

  test("F.22 and the original customer's money then cannot be returned to a car somebody else took", async () => {
    const seed = await seedDealer("f22");
    const v1 = await vehicle(seed);
    const v2 = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v1, v2]);
    await depositOn(seed, quoteId, 6_000);
    await allocate(seed, quoteId, [
      { vehicleId: v1, amount: 3_000 },
      { vehicleId: v2, amount: 3_000 },
    ]);
    await releaseVehicle(seed, quoteId, v1);
    expect(
      (await rootsOn(seed, v1))[0].status,
      "precondition: the released car is genuinely free, or the rival below cannot acquire it at all"
    ).toBe("RELEASED");
    const rivalQuote = await quoteFor(seed, seed.customerB, [v1]);
    await expect(
      depositOn(seed, rivalQuote, 4_000),
      "the rival legitimately takes the freed car"
    ).resolves.toBeDefined();

    const hold = (await holdsOn(seed, v1)).find(
      (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
    );
    expect(hold, "precondition: a slice is awaiting a decision").toBeDefined();

    await expect(
      seed.asUser.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: seed.orgId,
        holdId: hold!._id,
        treatment: "REALLOCATE_TO_VEHICLE" as const,
        toVehicleId: v1,
        reason: "put it back on the original car",
      }),
      "reacquisition must refuse — somebody else legitimately holds the car now"
    ).rejects.toThrow();
  });

  // ── the ruling: releasing ONE basis does not free a car another basis holds ──

  test("F.23 refunding the deposit while the FINANCE application is live keeps the root OPEN", async () => {
    const seed = await seedDealer("f23");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const depositId = await depositOn(seed, quoteId, 5_000);
    const applicationId = await approvedApplication(seed, quoteId);

    await releaseDeposit(seed, depositId, "REFUNDED");

    const app = await seed.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status, "the money operation must not silently kill the finance workflow").toBe("APPROVED");
    expect(
      (await seed.t.run((ctx) => ctx.db.get(depositId)))?.status,
      "and the refund itself genuinely succeeded"
    ).toBe("REFUNDED");
    expect(
      (await rootsOn(seed, v))[0].status,
      "an independent live basis still holds the car, so the root stays OPEN"
    ).toBe("OPEN");

    const rival = await quoteFor(seed, seed.customerB, [v]);
    await expect(
      completeQuote(seed, rival),
      "and a rival is still refused — see the header on why refusal at the completion doors is Phase-2 scope"
    ).rejects.toThrow();

    // ⚠️ THE HALF ABOVE IS NOT SELF-SUFFICIENT. "Root stays OPEN" is also true
    // today, for the wrong reason: nothing releases anything yet. The contract
    // is only differential once it carries through to the release, so it does.
    await cancelApplication(seed, applicationId);
    expect(
      (await rootsOn(seed, v))[0].status,
      "and once the finance basis goes too, the car is genuinely free"
    ).toBe("RELEASED");
  });

  test("F.24 releasing the reservation while the FINANCE application is live keeps the root OPEN", async () => {
    const seed = await seedDealer("f24");
    const v = await vehicle(seed);
    const reservationId = await reserve(seed, v, seed.customerA, { depositAmount: 1_000 });
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
      adoptReservationId: reservationId,
    });

    await releaseReservation(seed, reservationId);

    expect(
      (await seed.t.run((ctx) => ctx.db.get(applicationId)))?.status,
      "releaseReservation releases the reservation, not the finance application"
    ).toBe("PENDING_DOCS");
    expect(
      (await rootsOn(seed, v))[0].status,
      "reservation RELEASED + finance still in flight => root stays OPEN"
    ).toBe("OPEN");

    // Differential, for the same reason as F.23: staying OPEN is also today's
    // behaviour. Only carrying through to the release distinguishes them.
    await cancelApplication(seed, applicationId);
    expect(
      (await rootsOn(seed, v))[0].status,
      "and once the finance basis goes too, the reservation-origin root releases"
    ).toBe("RELEASED");
  });

  test("F.25 liveness is the HOLD, not the row — a rejection releases the root while the deposit still exists", async () => {
    const seed = await seedDealer("f25");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const depositId = await depositOn(seed, quoteId, 5_000);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });

    await rejectApplication(seed, applicationId);

    const deposit = await seed.t.run((ctx) => ctx.db.get(depositId));
    expect(deposit, "the deposit ROW is still there").toBeDefined();
    expect(deposit?.status, "and its money is still HELD, awaiting a human decision").toBe("HELD");
    expect(deposit?.holdActive, "but it holds no car — G.8: the rejection cleared it").toBe(false);
    expect(
      (await rootsOn(seed, v))[0].status,
      "so NOTHING holds the car and the root releases. A predicate that asked " +
        "'does a deposit exist' instead of 'is a hold live' would strand this car forever"
    ).toBe("RELEASED");
    expect(await salesCount(seed), "and no sale was ever created").toBe(0);
    await expect(
      depositOn(seed, await quoteFor(seed, seed.customerB, [v]), 4_000),
      "the next customer can have it"
    ).resolves.toBeDefined();
  });

  test("F.26 EXPLICIT VEHICLE RELEASE IS STRICTER — it REFUSES while a live RESERVATION basis holds the car", async () => {
    const seed = await seedDealer("f26");
    const v1 = await vehicle(seed);
    const v2 = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v1, v2]);
    const depositId = await depositOn(seed, quoteId, 6_000);
    await allocate(seed, quoteId, [
      { vehicleId: v1, amount: 3_000 },
      { vehicleId: v2, amount: 3_000 },
    ]);
    // A reservation on v1, proving lineage to the SAME deal so it JOINS rather
    // than being refused. FINANCE cannot be used here: an application supports
    // exactly one vehicle, so it cannot coexist with a multi-car allocation —
    // which is itself why the reservation branch of the ruling needs its own
    // contract rather than being assumed symmetric with the finance branch.
    const reservationId = await reserve(seed, v1, seed.customerA, {
      dealQuoteId: quoteId,
      dealDepositId: depositId,
    });
    const claimsBefore = await claimSnapshot(seed, v1);
    const holdsBefore = (await holdsOn(seed, v1)).length;

    await expect(
      releaseVehicle(seed, quoteId, v1),
      '"take this car out of this deal" does not get to end a reservation nobody released'
    ).rejects.toThrow();

    expect(
      (await seed.t.run((ctx) => ctx.db.get(reservationId)))?.status,
      "the reservation is untouched — the operator must end that workflow explicitly first"
    ).toBe("ACTIVE");
    expect((await rootsOn(seed, v1))[0].status, "and the root is untouched").toBe("OPEN");
    expect(await claimSnapshot(seed, v1), "zero residue: no claim written").toBe(claimsBefore);
    expect((await holdsOn(seed, v1)).length, "zero residue: no hold row added or removed").toBe(holdsBefore);
    expect(
      (await holdsOn(seed, v1)).some((h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"),
      "zero residue: the slice was NOT put into limbo by a refused call"
    ).toBe(false);

    // And the way out exists: end the reservation, then the release works.
    await releaseReservation(seed, reservationId);
    await expect(
      releaseVehicle(seed, quoteId, v1),
      "the rule and its way out ship together — a refusal with no reachable remedy is a blocker"
    ).resolves.toBeDefined();
    expect((await rootsOn(seed, v1))[0].status).toBe("RELEASED");
  });

  test("F.34 after the application ends, a rival can genuinely start a NEW one — REJECTED and CANCELLED", async () => {
    for (const ending of ["REJECTED", "CANCELLED"] as const) {
      const seed = await seedDealer(`f34-${ending}`);
      const v = await vehicle(seed);
      const q1 = await quoteFor(seed, seed.customerA, [v]);
      const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: q1,
      });

      if (ending === "REJECTED") await rejectApplication(seed, applicationId);
      else await cancelApplication(seed, applicationId);

      expect(
        (await rootsOn(seed, v))[0].status,
        `${ending}: the sole basis is gone, so the car is free`
      ).toBe("RELEASED");

      const q2 = await quoteFor(seed, seed.customerB, [v]);
      expect(
        await seed.asUser.mutation(api.applications.createFromQuote, {
          orgId: seed.orgId,
          quoteId: q2,
        }),
        `${ending}: proven by a NEW application succeeding, not by reading the old row's status. ` +
          "This is where the finance in-flight set and the root release must agree — if they " +
          "disagree the car is refused by one authority while the other thinks it is free"
      ).toBeDefined();
    }
  });

  test("F.28 D8 the reservation-expiry SWEEP releases a sole-basis root", async () => {
    const seed = await seedDealer("f28");
    const v = await vehicle(seed);
    const reservationId = await reserve(seed, v, seed.customerA, { depositAmount: 1_000 });
    await seed.t.run((ctx) => ctx.db.patch(reservationId, { expiresAt: Date.now() - 60_000 }));
    expect((await rootsOn(seed, v))[0].status, "precondition: held").toBe("OPEN");

    await seed.t.mutation(internal.vehicles.expireReservations, {});

    expectTerminalRoot((await rootsOn(seed, v))[0], {
      status: "RELEASED",
      door: "expireReservations — an expired reservation is not live (the sweep's own query is the " +
        "spec), so the car is free; otherwise the root is locked forever with no door that can reach it",
    });
    expect(await salesCount(seed), "expiry is not a sale").toBe(0);
    // Preserved from the retired G.12c: the sweep still does its own job.
    expect(
      (await seed.t.run((ctx) => ctx.db.get(reservationId)))?.status,
      "and the reservation row itself is EXPIRED"
    ).toBe("EXPIRED");
  });

  test("F.29 D9 the INLINE expiry sweep inside createReservation does the same", async () => {
    const seed = await seedDealer("f29");
    const v = await vehicle(seed);
    const first = await reserve(seed, v, seed.customerA, { depositAmount: 1_000 });
    await seed.t.run((ctx) => ctx.db.patch(first, { expiresAt: Date.now() - 60_000 }));

    // A different customer walks in and reserves the same car. createReservation
    // sweeps the stale reservation inline (vehicles.ts:1592) BEFORE acquiring —
    // so this call is itself the contract: today the authority refuses it,
    // because the sweep retires the reservation and leaves the root open.
    await expect(
      reserve(seed, v, seed.customerB, { depositAmount: 1_000 }),
      "the inline sweep must retire the expired deal's ROOT, not just its reservation row, " +
        "or the next real customer is refused a car nobody holds"
    ).resolves.toBeDefined();

    const roots = await rootsOn(seed, v);
    const released = roots.filter((r) => r.status === "RELEASED");
    const open = roots.filter((r) => r.status === "OPEN");
    expect(released, "the expired deal's root is closed by the sweep that expired it").toHaveLength(1);
    expect(released[0].customerId).toBe(seed.customerA);
    expectTerminalRoot(released[0], { status: "RELEASED", door: "createReservation inline sweep" });
    expect(open, "and exactly one live root remains").toHaveLength(1);
    expect(open[0].customerId, "belonging to the customer who actually has the car").toBe(seed.customerB);
  });

  test("F.30 expiry does NOT release a root another live basis still holds", async () => {
    const seed = await seedDealer("f30");
    const v = await vehicle(seed);
    const reservationId = await reserve(seed, v, seed.customerA, { depositAmount: 1_000 });
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
      adoptReservationId: reservationId,
    });
    await seed.t.run((ctx) => ctx.db.patch(reservationId, { expiresAt: Date.now() - 60_000 }));

    await seed.t.mutation(internal.vehicles.expireReservations, {});

    expect(
      (await seed.t.run((ctx) => ctx.db.get(applicationId)))?.status,
      "an expiry sweep must not cancel a finance application"
    ).toBe("PENDING_DOCS");
    expect(
      (await rootsOn(seed, v))[0].status,
      "the reservation basis died on the clock; the finance basis did not"
    ).toBe("OPEN");

    // ⚠️ Differential, for the same reason as F.23/F.24: "stays OPEN" is also
    // today's behaviour, so the contract only means something once it carries
    // through to the release.
    await cancelApplication(seed, applicationId);
    expect(
      (await rootsOn(seed, v))[0].status,
      "and once the finance basis ends too, the root finally releases"
    ).toBe("RELEASED");
  });

  test("F.31 SOFT-DELETING a committed car is REFUSED", async () => {
    const seed = await seedDealer("f31");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });

    await expect(
      seed.asUser.mutation(api.vehicles.softDelete, { orgId: seed.orgId, vehicleId: v }),
      "removing a car from inventory while a deal holds it strands the root where no door can reach it. " +
        "The correct outcome is REFUSAL, not release — the operator ends the deal explicitly first"
    ).rejects.toThrow();

    expect((await seed.t.run((ctx) => ctx.db.get(v)))?.isDeleted ?? false).toBe(false);
    expect((await rootsOn(seed, v))[0].status).toBe("OPEN");

    // And the way out exists.
    await cancelApplication(seed, applicationId);
    expect((await rootsOn(seed, v))[0].status, "the deal is ended properly").toBe("RELEASED");
    await expect(
      seed.asUser.mutation(api.vehicles.softDelete, { orgId: seed.orgId, vehicleId: v }),
      "and only then may the car leave inventory"
    ).resolves.toBeDefined();
  });

  test("F.32 completing a quote whose line was RELEASED refuses as a whole, with no partial sale", async () => {
    const seed = await seedDealer("f32");
    const v1 = await vehicle(seed);
    const v2 = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v1, v2]);
    await depositOn(seed, quoteId, 6_000);
    await allocate(seed, quoteId, [
      { vehicleId: v1, amount: 3_000 },
      { vehicleId: v2, amount: 3_000 },
    ]);
    await releaseVehicle(seed, quoteId, v1);
    expect((await rootsOn(seed, v1))[0].status, "precondition: v1 left the deal").toBe("RELEASED");

    // completeFromQuote enumerates EVERY vehicleItem (sales.ts:419), and the
    // quote still lists v1. The commitment outcome must be defined, not left to
    // whichever unrelated guard happens to fire first.
    await expect(
      completeQuote(seed, quoteId),
      "the deal no longer holds v1, so completing the quote as written must refuse OUTRIGHT"
    ).rejects.toThrow();

    expect(await salesCount(seed), "and NEITHER car is sold — no partial completion").toBe(0);
    expect((await rootsOn(seed, v2))[0].status, "v2's root is untouched by the refusal").toBe("OPEN");
    expect((await rootsOn(seed, v1))[0].status, "and v1 stays released").toBe("RELEASED");
  });

  test("F.33 a rejection that releases BOTH a finance and a reservation basis at once still releases the root", async () => {
    const seed = await seedDealer("f33");
    const v = await vehicle(seed);
    const reservationId = await reserve(seed, v, seed.customerA, { depositAmount: 1_000 });
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
      adoptReservationId: reservationId,
    });

    // releaseHoldForApplicationQuote (depositHelpers.ts:727) releases the quote's
    // deposit holds AND same-customer reservations in ONE call. The predicate
    // must be evaluated AFTER those internal releases, or it reads a reservation
    // this very mutation just retired and keeps the root open forever.
    await rejectApplication(seed, applicationId);

    expect(
      (await seed.t.run((ctx) => ctx.db.get(reservationId)))?.status,
      "the rejection released the reservation too"
    ).toBe("RELEASED");
    expect(
      (await rootsOn(seed, v))[0].status,
      "so NOTHING holds the car, and a predicate evaluated too early would miss it"
    ).toBe("RELEASED");
  });

  test("F.27 cancelling a completed sale changes nothing — the root stays CONSUMED and stamped", async () => {
    const seed = await seedDealer("f27");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await depositOn(seed, quoteId, 5_000);
    const saleId = await completeQuoteOne(seed, quoteId);
    const before = await claimSnapshot(seed, v);

    await cancelSale(seed, saleId);

    const root = (await rootsOn(seed, v))[0];
    expect(
      root.status,
      "cancellation is entirely Phase 3 (c15683) — Phase 2 performs ZERO canonical lifecycle work here"
    ).toBe("CONSUMED");
    expect(rootSaleStamp(root), "and the provenance stamp survives for Phase 3 to use").toBe(String(saleId));
    expect(await claimSnapshot(seed, v)).toBe(before);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════
 * COVERAGE MAP — owner remediation list (c15683) -> contract
 * ══════════════════════════════════════════════════════════════════════════════
 *
 *  1. enumerate every release door               -> file header D1-D9; G.6a-G.6g
 *  2. single-car deposits.release refund+forfeit -> G.6a, G.6b, F.14, F.15
 *     and voidDeposit                            -> G.6c, F.16
 *  3. releaseReservation                         -> G.6d, F.17, F.24
 *  4. REJECTED and cancelApplication             -> G.6e, G.6f, G.8, F.18, F.19, F.25
 *  5. real financed finalizeDeal fixture         -> financedSale(); F.8d, F.13
 *  6. negative ownership on every completion door-> F.3, F.4, F.9a-F.9e
 *  7. full claim snapshots, not censuses         -> claimSnapshot(); F.1, F.12, F.13, F.26, F.27
 *  8. complete the rival sale after a RELEASED   -> F.21
 *  9. 60+ claims by real acquisition             -> G.13, F.12
 * 10. root by_consumed_sale / one-sale-one-root  -> F.10 (index requirement stated there)
 * 11. reservation-origin coverage                -> G.11, F.17, F.24
 *
 * Product ruling c15683 -> contract
 *   evidence-scoped release keeps root OPEN      -> F.23, F.24 (both carry through
 *                                                   to the release, so neither is
 *                                                   satisfied by today's behaviour)
 *   liveness is the HOLD, not the row            -> F.25
 *   explicit vehicle release is stricter         -> F.26, which also proves the
 *                                                   remedy is reachable
 *   REJECTED / CANCELLED stop holding the car    -> G.9, F.18, F.19
 *
 * DECLARED GAPS, so their absence is a decision and not an oversight:
 *   - Concurrency and cross-tenant isolation are unspecified. Convex mutations
 *     are serializable and `resolveOwnership` is already orgId-scoped, so these
 *     are low by construction rather than merely unexamined.
 *   - Trade-in origins are unspecified; they create no commitment evidence.
 *   - PRE-EXISTING OPEN ROOTS. Phase-1 acquisition is already live on this
 *     branch, so any deal that completed or was abandoned BEFORE M3's write
 *     path exists keeps an OPEN root that no door will ever revisit. M3 closes
 *     the forward path only; draining the backlog is SCRUM-201 cutover work and
 *     needs its own migration.
 *   - PART X holds every contract the M3 commit must DELETE. See that block.
 *   - COMPOUND CONTRACTS. F.9e, F.21, F.22, F.32 and F.34 assert a second-order
 *     outcome whose PRECONDITION is itself a Part-B requirement — a released or
 *     consumed root has to exist before the thing they test can be reached, and
 *     no door produces one today. So against a PARTIAL M3 they go red at the
 *     precondition rather than at their own target assertion. That is inherent
 *     to testing an emergent outcome, not an oversight: M3 ships F.14-F.20
 *     together with these, and the precondition lines say "precondition" so the
 *     distinction is visible in the failure output.
 */
