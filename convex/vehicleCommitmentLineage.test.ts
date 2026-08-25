import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ORGANIZATION_DELETION_STEPS } from "./adminOrgs";
import { anyApi, FunctionReference } from "convex/server";

/**
 * A reference to a surface this design REQUIRES but that does not exist yet.
 *
 * ## Why this exists, and why the previous approach was worse than useless
 *
 * These contracts were first written as `test.skip` with the call commented out
 * and a trailing `expect(something).toBeDefined()`. I described them as "the
 * specification". A reviewer showed they were nothing of the kind: **every one
 * would have passed green if merely unskipped**, because the body never invoked
 * the surface it was named for. An implementer could have un-skipped all eight,
 * seen green, and built none of it — the exact "passes for the wrong reason"
 * failure I had spent the day finding in other people's work, sitting inside my
 * own device for recording the rulings.
 *
 * So these are now ORDINARY ACTIVE TESTS. They build real state, invoke the
 * intended surface through an untyped reference, and assert real behaviour.
 * Today they fail because the function does not exist — which is what a
 * failing-first test is supposed to do. When the surface lands they will fail
 * on the ASSERTION until the behaviour is right, and only then go green.
 *
 * ## One honest qualification (round-6)
 *
 * "Every test invokes the surface it is named for" is too strong TODAY, and
 * saying it flatly was an overclaim. A number of the cross-surface fixtures
 * first have to build a superseded head, and that setup itself goes through
 * `saveQuote({ supersedesQuoteId })` — a field that does not exist yet. Those
 * tests are therefore PREREQUISITE-red: they fail in setup, before the
 * mutation under test is ever reached.
 *
 * That is not the same defect as a test that fails for an unrelated reason —
 * the rejection is the deliberate pending-surface boundary, and every one of
 * them becomes target-red the moment supersession lands, with no edit. But an
 * implementer should know which is which, because a prerequisite-red test
 * proves nothing about its own subject until the prerequisite exists. Where a
 * fixture could be made independently red by seeding root/head state directly,
 * that is the better form; it is not available until a seeding surface exists.
 *
 * The distinction that actually matters, and the one this file must never get
 * wrong, is a test failing on a rule that has NOTHING to do with its subject.
 * Round 6 found exactly one (`REALLOCATE_TO_VEHICLE`, since rebuilt) and it
 * would have stayed red forever against a perfectly correct implementation.
 *
 * The untyped reference is the minimum needed to make an unbuilt function
 * callable. It is deliberately not a cast that would let a missing function
 * silently resolve: `anyApi` produces a real function reference, so the call
 * genuinely executes and genuinely throws.
 */
type UnbuiltMutation = FunctionReference<"mutation", "public", Record<string, unknown>, unknown>;
type UnbuiltQuery = FunctionReference<"query", "public", Record<string, unknown>, unknown>;

const notYetBuilt = anyApi as unknown as Record<string, Record<string, UnbuiltMutation>>;
const notYetBuiltQuery = anyApi as unknown as Record<string, Record<string, UnbuiltQuery>>;

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

/**
 * SCRUM-195 — DEAL LINEAGE, the compatibility identity (owner ruling c14554).
 *
 * FAILING-FIRST DESIGN FIXTURES. No implementation exists; the failures are the
 * specification.
 *
 * ## What this ruling fixed
 *
 * "One physical unit" (c14551) is right, but enforcing it as "reject whenever
 * any hold exists" is wrong, and the repository proves it: the existing suite
 * REQUIRES two behaviours naive uniqueness would break —
 *
 *   - `convex/deposits.test.ts` — "a second deposit from a different quote on
 *     the same vehicle does not error (soft warning, not a hard block)";
 *   - `convex/financeLifecyclePhase3.test.ts` — multiple deposits against ONE
 *     quote are legitimate;
 *   - `convex/sourcedVehicleHolds.test.ts` — "a SOURCING vehicle that already
 *     carries a deposit hold can still be reserved".
 *
 * Meanwhile preserving today's behaviour leaves a hole that is not even a race:
 * `prepareSaleCompletion` checks only SOLD and ARCHIVED — it never consults
 * deposit holds — so B deposits on a car, A buys it for cash, and B's money
 * silently sits against someone else's vehicle.
 *
 * ## The binding model
 *
 * One physical vehicle may have ONE logical hard-commitment OWNER, and that one
 * commitment may have MANY evidence rows. **Identity is deal lineage — a root —
 * never row count and never `(customerId, vehicleId)`.**
 *
 *   - **the root EXISTS from the first quote save** (c14796), but is purely
 *     informational and holds nothing — a quote does not lock a car;
 *   - the first deposit, Finance Application or proven reservation **ACTIVATES**
 *     the vehicle commitment under that already-existing root. It activates;
 *     it never creates. Creating the identity lazily at first hard evidence —
 *     which is what I originally proposed — leaves two linked re-quotes able to
 *     take their first deposits concurrently and each mint a root, and the fix
 *     is structural rather than a lock: if the identity already exists there is
 *     no window in which two writers can both decide to create one;
 *   - further deposits on that SAME quote are more evidence for the same root;
 *   - a Finance Application from that same quote joins that same root and must
 *     not conflict with its own deposit rows;
 *   - a standalone manual reservation may establish a reservation root;
 *   - a reservation layered over an existing deal may JOIN it only when the
 *     server can explicitly or unambiguously prove that exact same root.
 *     **Ambiguity fails closed. There is no broad same-customer exemption.**
 *   - a different, INDEPENDENT quote is a COMPETING owner **even for the same
 *     customer**.
 *
 * ## ⚠️ The root is SERVER-OWNED. A quoteId is proof, not the root itself
 *
 * Refined by c14659, and the distinction is load-bearing rather than
 * terminological. An earlier draft of this file used `QUOTE:<quoteId>` as the
 * identity itself, which looked equivalent and was not:
 *
 *   - `saveQuote` has **no update path** — every save mints a brand-new
 *     `quoteId` (it is an unconditional insert; the only patch is
 *     `updateQuoteStatus`, on `status` alone). So identity-equals-quoteId means
 *     that renegotiating a price after a deposit is down mints a NEW root, and
 *     the different-root rule then refuses the customer's own deal. That is a
 *     closed-loop dead-end on the most ordinary workflow there is, and it is
 *     the same class of defect that sank the previous attempt.
 *
 * So a quote RESOLVES to a stable, server-owned root. A **linked** re-quote —
 * one the server can tie to the same deal — shares that root and may continue
 * the deal. An **independent** quote remains a competing owner. `createReservation`
 * accepts an optional `quoteId` as *lineage proof* for the same reason: it is
 * evidence the server resolves, never the identity it stores.
 *
 * Two consequences that are easy to get backwards, and are pinned below:
 *
 *   1. **Releasing the finance claim does not free the unit** while live
 *      deposit or reservation evidence on the same root remains. A rejected
 *      application must not implicitly discard the customer's money.
 *   2. **Omitting lineage is not permission.** A cash sale proceeds only
 *      through its own proven root, or when the vehicle is uncommitted —
 *      passing no quote does not make someone else's deposit invisible.
 *
 * `convex/deposits.test.ts`'s cross-customer expectation is SUPERSEDED by this
 * ruling and must be rewritten when the authority lands. It is named here so
 * the supersession is explicit rather than discovered as a broken test.
 */

const PRICE = 28_000;

type Seed = Awaited<ReturnType<typeof seedDealer>>;

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, MODULES);

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Lineage ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `lin_${suffix}`, email: `l${suffix}@x.com`, name: "Closer" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `lin_ap_${suffix}`, email: `la${suffix}@x.com`, name: "Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Lineage",
      permissions: [
        "view:sales",
        "create:sales",
        "edit:sales",
        "approve:requests",
        "view:customers",
        "edit:vehicles",
        "delete:vehicles",
        "create:finance_application",
        "review:finance_application",
        "approve:finance_application",
        "finalize:financed_deal",
        "view:finance_applications",
        "register:vehicle_handover",
        "register:expected_payment",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));

  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Aisha", lastName: "Root" })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Bilal", lastName: "Other" })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Lineage Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    })
  );

  return {
    t,
    orgId,
    userId,
    approverId,
    customerA,
    customerB,
    companyId,
    asUser: t.withIdentity({ subject: `lin_${suffix}`, clerkId: `lin_${suffix}` }),
    asApprover: t.withIdentity({ subject: `lin_ap_${suffix}`, clerkId: `lin_ap_${suffix}` }),
  };
}

async function vehicle(seed: Seed, vin: string): Promise<Id<"vehicles">> {
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin,
      make: "Toyota",
      model: "Land Cruiser",
      year: 2024,
      mileage: 20,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: PRICE,
      status: "AVAILABLE",
    })
  );
}

/**
 * A quote, which the server RESOLVES to a root — it is not the root itself.
 *
 * The previous wording here said "a quote is the ROOT", which contradicted
 * c14659 and survived the edit that introduced the server-owned model. Left
 * uncorrected it would have told an implementer exactly the wrong thing, in the
 * one place they are most likely to look.
 */
async function quoteFor(
  seed: Seed,
  customerId: Id<"customers">,
  vehicleId: Id<"vehicles">,
  financed = false
): Promise<Id<"quotes">> {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId,
    ...(financed
      ? { mode: "CONFIGURED_FINANCE_COMPANY" as const, companyId: seed.companyId }
      : { mode: "CASH" as const }),
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: financed ? 48 : 0,
    totalFinancedAmount: financed ? PRICE : 0,
  });
}

/**
 * A two-car deal whose second share has been released and is AWAITING A
 * DECISION: 4,000 taken, 2,000 against each car, the second one released.
 *
 * Module-scoped because two different blocks need it — the root-wide ceiling
 * (does unresolved money still count?) and the ownership/money axes (does it
 * still hold the car?). Those are the two questions this exact state answers,
 * and they live in different describes.
 */
async function dealWithReleasedShare(seed: Seed, keepVin: string, freedVin: string) {
  const keep = await vehicle(seed, keepVin);
  const freed = await vehicle(seed, freedVin);

  const root = await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId: seed.customerA,
    vehicleId: keep,
    vehicleItems: [
      { vehicleId: keep, unitPrice: PRICE },
      { vehicleId: freed, unitPrice: PRICE },
    ],
    mode: "CASH" as const,
    vehiclePrice: PRICE * 2,
    downPayment: 0,
    termMonths: 0,
    totalFinancedAmount: 0,
  });
  await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 4_000 });
  await seed.asUser.mutation(api.deposits.allocateToVehicles, {
    orgId: seed.orgId,
    quoteId: root,
    allocations: [
      { vehicleId: keep, amount: 2_000 },
      { vehicleId: freed, amount: 2_000 },
    ],
  });
  await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
    orgId: seed.orgId,
    quoteId: root,
    vehicleId: freed,
    reason: "customer dropped the second car",
  });
  return { root, keep, freed };
}

/**
 * Every table a refused deposit could plausibly touch.
 *
 * "Whole-world zero delta" is only a real claim if the world is actually
 * counted. Asserting that no DEPOSIT row appeared would miss the payment,
 * transaction, hold and notification residue that is the reason the rule exists.
 */
const WORLD_TABLES = [
  "deposits",
  "depositVehicleHolds",
  "depositApplications",
  "transactions",
  "vehicleReservations",
  "notifications",
  "financeApplications",
  "sales",
  "receivableDocuments",
  "journalEntries",
  "pendingAccountingEvents",
  // Added after review: `recordHeldDeposit` writes all three unconditionally on
  // every successful deposit, before any chart-of-accounts gating. Omitting them
  // made the comment above ("every table a refused deposit could touch") false.
  // Convex's mutation atomicity means the assertion passed either way today —
  // which is precisely why the omission was invisible, and precisely why it
  // would stop being invisible the moment any of this moved to a scheduled
  // action outside the transaction.
  "collectionPayments",
  "canonicalPayments",
  "paymentVouchers",
] as const;

async function snapshotWorld(seed: Seed): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of WORLD_TABLES) {
    counts[table] = await seed.t.run(async (ctx) => {
      const rows = await ctx.db.query(table as "deposits").collect();
      return rows.length;
    });
  }
  return counts;
}

describe("SCRUM-195 c14554 + c14659: the commitment owner is a SERVER-OWNED DEAL ROOT", () => {
  describe("1. multiple evidence rows may support ONE commitment", () => {
    test("a second and third deposit on the SAME quote succeed", async () => {
      // The behaviour naive uniqueness would have broken. Instalments are one
      // commitment paid in parts, not three competing claims.
      const seed = await seedDealer("same-root");
      const v = await vehicle(seed, "LIN0000000000001");
      const root = await quoteFor(seed, seed.customerA, v);

      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 500 });
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 700 })
      ).resolves.toBeDefined();
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 300 })
      ).resolves.toBeDefined();
    });

    test("a Finance Application from the same quote joins that root rather than competing with its own deposit", async () => {
      const seed = await seedDealer("same-root-app");
      const v = await vehicle(seed, "LIN0000000000002");
      const root = await quoteFor(seed, seed.customerA, v, true);

      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 900 });

      await expect(
        seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: root })
      ).resolves.toBeDefined();
    });
  });

  describe("2. a DIFFERENT root is a competing owner — including for the same customer", () => {
    test("a deposit from a different quote and a different customer is refused", async () => {
      // ⚠️ SUPERSEDES `convex/deposits.test.ts`'s "soft warning, not a hard
      // block". That test asserts this exact call resolves; under c14554 it must
      // refuse, because the money would otherwise be taken against a car another
      // deal already owns. Named explicitly so the supersession is a decision on
      // the record, not a mystery failure later.
      const seed = await seedDealer("diff-root-diff-cust");
      const v = await vehicle(seed, "LIN0000000000003");

      const rootA = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootA, amount: 1_000 });

      const rootB = await quoteFor(seed, seed.customerB, v);
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootB, amount: 2_000 })
      ).rejects.toThrow(/committed|another deal|already held|different deal/i);
    });

    test("a deposit from a different quote by the SAME customer is refused too", async () => {
      // The half that a `(customerId, vehicleId)` scope would wave through, and
      // the reason the ruling says identity is lineage rather than the customer.
      // Two quotes are two deals even when one person holds both: joining them
      // silently would let the second quote's terms consume the first quote's
      // money.
      const seed = await seedDealer("diff-root-same-cust");
      const v = await vehicle(seed, "LIN0000000000004");

      const rootOne = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootOne, amount: 1_000 });

      const rootTwo = await quoteFor(seed, seed.customerA, v);
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootTwo, amount: 1_500 })
      ).rejects.toThrow(/committed|another deal|already held|different deal/i);
    });

    test("a Finance Application on a different root than the live deposit is refused", async () => {
      const seed = await seedDealer("diff-root-app");
      const v = await vehicle(seed, "LIN0000000000005");

      const depositRoot = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: depositRoot, amount: 800 });

      const otherRoot = await quoteFor(seed, seed.customerB, v, true);
      await expect(
        seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: otherRoot })
      ).rejects.toThrow(/committed|another deal|deposit|already held/i);
    });
  });

  describe("3. a refusal leaves the whole world untouched", () => {
    test("a refused deposit writes nothing anywhere", async () => {
      // Not "no deposit row" — the whole world. A refusal that still emitted a
      // transaction, a hold, a notification or an accounting event would be a
      // partial write dressed as a guard, and on a money path that is worse
      // than no guard at all because it looks clean.
      const seed = await seedDealer("zero-delta");
      const v = await vehicle(seed, "LIN0000000000006");

      const rootA = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootA, amount: 1_000 });

      const rootB = await quoteFor(seed, seed.customerB, v);
      const before = await snapshotWorld(seed);

      // Matched, not bare. A bare `rejects.toThrow()` would go green on ANY
      // future rejection — an auth change, a validator tightening, a rate
      // limit — and the zero-delta assertion below would then be proving that
      // a call which never ran wrote nothing.
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootB, amount: 2_000 })
      ).rejects.toThrow(/committed|another deal|already held|no longer available|different root/i);

      expect(await snapshotWorld(seed)).toEqual(before);
    });
  });

  describe("4. the reservation bridge joins only on PROVEN root, and fails closed on ambiguity", () => {
    test("a reservation over the same customer's deposit is NOT admitted on customer identity alone", async () => {
      // `sourcedVehicleHolds.test.ts` proves this bridge is a real supported
      // flow — but it is supported because the reservation belongs to the same
      // DEAL, not because the customer happens to match. `createReservation`
      // takes no quote/root argument today, so the server cannot prove lineage
      // and must fail closed rather than infer it from the customer.
      //
      // The ruling permits persisting an optional root reference on the
      // reservation to make this provable; until one exists, ambiguity refuses.
      const seed = await seedDealer("bridge-ambiguous");
      const v = await vehicle(seed, "LIN0000000000007");

      const root = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 1_200 });

      await expect(
        seed.asUser.mutation(api.vehicles.createReservation, {
          orgId: seed.orgId,
          vehicleId: v,
          customerId: seed.customerA,
        })
      ).rejects.toThrow(/root|deal|which deal|cannot be proven|ambiguous/i);
    });

    // PENDING SURFACE — the failing call is the specification; same discipline as the aged
    // commitments query. `createReservation`'s args are `orgId, vehicleId,
    // customerId, depositAmount?, depositMethod?, expiresAt?` — there is no
    // `quoteId`, so this cannot compile, and casting to force it green would
    // hide the fact that the argument does not exist yet.
    //
    // REQUIRED CONTRACT (c14659):
    //   vehicles.createReservation({ orgId, vehicleId, customerId, quoteId? })
    //
    // `quoteId` is LINEAGE PROOF, not the root. The server resolves it to the
    // stable root and admits the reservation only when it resolves to the SAME
    // root that already holds the vehicle.
    //
    // This is what PRESERVES the supported sourced flow that
    // `convex/sourcedVehicleHolds.test.ts` protects — "a SOURCING vehicle that
    // already carries a deposit hold can still be reserved". That flow stays;
    // what is removed is the unsafe way it was admitted, on customer identity
    // alone. That existing test must be rewritten to pass the root, not deleted:
    // the business flow is not superseded, only its proof is.
    test("a reservation supplying the SAME root as the live deposit is admitted", async () => {
      const seed = await seedDealer("bridge-proven");
      const v = await vehicle(seed, "LIN0000000000016");
      const root = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 1_200 });

      // Fails today: `createReservation` has no `quoteId`, so its validator
      // rejects the field. Once the argument lands this keeps failing until the
      // reservation is genuinely admitted on the proven root — the behaviour,
      // not the signature.
      const reservationId = await seed.asUser.mutation(notYetBuilt.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
        quoteId: root,
      });
      expect(reservationId).toBeDefined();

      // And it JOINED rather than competing — one commitment on the car, not two.
      const active = await seed.t.run(async (ctx) => {
        const rows = await ctx.db
          .query("vehicleReservations")
          .filter((q) => q.eq(q.field("vehicleId"), v))
          .collect();
        return rows.filter((row) => row.status === "ACTIVE");
      });
      expect(active).toHaveLength(1);
    });

    test("a standalone reservation on an uncommitted vehicle still establishes its own root", async () => {
      // The control. The bridge refusal above must not become "no reservation
      // may ever be taken", which would break ordinary walk-in holds.
      const seed = await seedDealer("bridge-standalone");
      const v = await vehicle(seed, "LIN0000000000008");

      await expect(
        seed.asUser.mutation(api.vehicles.createReservation, {
          orgId: seed.orgId,
          vehicleId: v,
          customerId: seed.customerA,
        })
      ).resolves.toBeDefined();
    });
  });

  describe("5. omitting lineage is not permission to sell over someone else's money", () => {
    test("a cash sale with no quote cannot consume a vehicle another root holds", async () => {
      // The sequential money hole, stated as a rule: `prepareSaleCompletion`
      // consults only SOLD and ARCHIVED today, so passing no quote makes another
      // customer's deposit invisible and the car sells out from under it.
      const seed = await seedDealer("cash-no-lineage");
      const v = await vehicle(seed, "LIN0000000000009");

      const root = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 1_000 });

      await expect(
        seed.asUser.mutation(api.sales.create, {
          orgId: seed.orgId,
          vehicleId: v,
          customerId: seed.customerB,
          salespersonId: seed.userId,
          salePrice: PRICE,
          saleDate: Date.now(),
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(/committed|deposit|another deal|already held/i);
    });

    test("completion through the vehicle's OWN root succeeds", async () => {
      // The control that stops the rule collapsing into "a deposited car can
      // never be sold" — which would make taking a deposit an act of sabotage.
      const seed = await seedDealer("cash-own-root");
      const v = await vehicle(seed, "LIN0000000000010");

      const root = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 1_000 });

      await expect(
        seed.asUser.mutation(api.sales.create, {
          orgId: seed.orgId,
          vehicleId: v,
          customerId: seed.customerA,
          salespersonId: seed.userId,
          salePrice: PRICE,
          saleDate: Date.now(),
          status: "COMPLETED" as const,
          quoteId: root,
        })
      ).resolves.toBeDefined();
    });
  });

  describe("6. releasing the finance claim does not discard the customer's money", () => {
    test("a REJECTED application leaves the unit held while its root's deposit is live", async () => {
      // The lifecycle consequence that is easy to get backwards. The finance
      // claim and the deposit are two evidence rows on ONE root; retiring the
      // finance half does not retire the root while money is still down. A
      // design that frees the car here would quietly convert a rejected
      // financing into a lost deposit.
      const seed = await seedDealer("release-keeps-hold");
      const v = await vehicle(seed, "LIN0000000000011");

      const root = await quoteFor(seed, seed.customerA, v, true);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 1_000 });
      const app = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: root,
      });
      await seed.asUser.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId: app,
        status: "UNDER_REVIEW",
      });
      await seed.asApprover.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId: app,
        status: "REJECTED",
      });

      // The financing is dead; the deposit is not. Another root must still lose.
      const rival = await quoteFor(seed, seed.customerB, v);
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rival, amount: 2_000 })
      ).rejects.toThrow(/committed|another deal|deposit|already held/i);
    });
  });

  describe("7. a multi-vehicle deposit acquires EVERY vehicle on the quote", () => {
    // ⚠️ REPLACES an earlier fixture that both reviewers showed was
    // UNREACHABLE, and the reason is worth keeping.
    //
    // It set up a multi-vehicle quote containing an already-committed vehicle,
    // called `deposits.create` on it EXPECTING SUCCESS, and only asserted that
    // the later `allocateToVehicles` refused. But `deposits.create` already
    // holds every vehicle on the quote — `depositVehicleItems` iterates
    // `quote.vehicleItems` and calls `holdVehicleForDeposit` on each — so under
    // a correct authority the SETUP call must itself be refused, and the test
    // would throw before reaching its assertion.
    //
    // It was also unreachable for a second reason: reallocation can only target
    // vehicles already on the same immutable quote, so "acquire a NEW vehicle
    // during allocation" is not a state any supported API can produce.
    //
    // The rule it was groping for is this one, and this one is reachable.
    test("a deposit is refused when ANY line item is already committed to another root", async () => {
      // The multi-vehicle hole: a guard that validates only `quote.vehicleId`
      // — the convenience field `saveQuote` derives from `vehicleItems[0]` —
      // would let a deposit plant an active hold on someone else's committed
      // car through the SECOND slot, and pass every other fixture here.
      const seed = await seedDealer("multi-item");
      const held = await vehicle(seed, "LIN0000000000012");
      const spare = await vehicle(seed, "LIN0000000000013");

      const ownerRoot = await quoteFor(seed, seed.customerA, held);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ownerRoot, amount: 1_000 });

      // `held` is the SECOND line item, so only a per-item check catches it.
      const moverRoot = await seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerB,
        vehicleId: spare,
        vehicleItems: [
          { vehicleId: spare, unitPrice: PRICE },
          { vehicleId: held, unitPrice: PRICE },
        ],
        mode: "CASH" as const,
        vehiclePrice: PRICE * 2,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
      });

      const before = await snapshotWorld(seed);
      await expect(
        seed.asUser.mutation(api.deposits.create, {
          orgId: seed.orgId,
          quoteId: moverRoot,
          amount: 3_000,
        })
      ).rejects.toThrow(/committed|another deal|already held/i);

      // Atomic: the uncontested first line item must not be quietly held either.
      expect(await snapshotWorld(seed)).toEqual(before);
    });

    test("a RELEASED allocation cannot be reactivated onto a vehicle a rival root has since taken", async () => {
      // The reachable reacquisition my previous fixture stopped covering.
      //
      // Replacing the unreachable reallocation test closed the INITIAL
      // acquisition and silently dropped the later-write problem it existed
      // for. This sequence is entirely public and entirely supported:
      //
      //   1. a multi-vehicle deposit claims A and B;
      //   2. `releaseVehicleAllocation` drops B from the deal and frees it;
      //   3. a rival root legitimately acquires B;
      //   4. `resolveReleasedAllocation(RETURN_TO_UNALLOCATED)` inserts a FRESH
      //      ACTIVE hold on B — with no acquisition check anywhere.
      //
      // Two roots on one car, through supported APIs, with nobody having done
      // anything wrong. Reactivation is an acquisition or it is a hole.
      const seed = await seedDealer("reacquire");
      const keep = await vehicle(seed, "LIN0000000000021");
      const dropped = await vehicle(seed, "LIN0000000000022");

      const ownRoot = await seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: keep,
        vehicleItems: [
          { vehicleId: keep, unitPrice: PRICE },
          { vehicleId: dropped, unitPrice: PRICE },
        ],
        mode: "CASH" as const,
        vehiclePrice: PRICE * 2,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
      });
      await seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: ownRoot,
        amount: 4_000,
      });

      await seed.asUser.mutation(api.deposits.allocateToVehicles, {
        orgId: seed.orgId,
        quoteId: ownRoot,
        allocations: [
          { vehicleId: keep, amount: 2_000 },
          { vehicleId: dropped, amount: 2_000 },
        ],
      });
      await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
        orgId: seed.orgId,
        quoteId: ownRoot,
        vehicleId: dropped,
        reason: "customer dropped the second car",
      });

      // The rival legitimately takes the now-free vehicle.
      const rivalRoot = await quoteFor(seed, seed.customerB, dropped);
      await seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rivalRoot,
        amount: 1_500,
      });

      const releasedHold = await seed.t.run(async (ctx) => {
        const holds = await ctx.db
          .query("depositVehicleHolds")
          .filter((q) => q.eq(q.field("vehicleId"), dropped))
          .collect();
        return holds.find((hold) => hold.active === false) ?? holds[0];
      });

      await expect(
        seed.asUser.mutation(api.deposits.resolveReleasedAllocation, {
          orgId: seed.orgId,
          holdId: releasedHold!._id,
          treatment: "RETURN_TO_UNALLOCATED" as const,
          reason: "put it back on the deal",
        })
      ).rejects.toThrow(/committed|another deal|already held|no longer available/i);
    });

    test("a multi-vehicle deposit on wholly uncommitted vehicles still succeeds", async () => {
      // The control. Multi-vehicle cash deposits are a real supported feature,
      // so the per-item check must not become "no multi-vehicle deposits".
      const seed = await seedDealer("multi-item-ok");
      const one = await vehicle(seed, "LIN0000000000014");
      const two = await vehicle(seed, "LIN0000000000015");

      const root = await seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: one,
        vehicleItems: [
          { vehicleId: one, unitPrice: PRICE },
          { vehicleId: two, unitPrice: PRICE },
        ],
        mode: "CASH" as const,
        vehiclePrice: PRICE * 2,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
      });

      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 3_000 })
      ).resolves.toBeDefined();
    });
  });

  describe("8. rollout and org-purge sequencing", () => {
    test("the claim must OUTLIVE its vehicle during a purge, not precede it", async () => {
      // ⚠️ THIS REQUIREMENT IS THE REVERSE OF WHAT I FIRST WROTE, and the
      // correction matters more than the original.
      //
      // I reasoned "a claim is a child of the vehicle, children purge first",
      // and asserted the claim must precede its earliest referent. One reviewer
      // checked the arithmetic and agreed. The other checked something I had
      // not: whether a FAILED purge can be returned to service.
      //
      // It can. `ACTIVE_DELETION_STATUSES` is ["PENDING_REVIEW","APPROVED",
      // "RUNNING"] — FAILED is NOT among them — so `unsuspendOrg` permits
      // unsuspending an organisation whose purge failed part-way. Deletion is
      // batched across transactions, so "part-way" is an ordinary outcome.
      //
      // Under my original ordering: claims are deleted, the next batch fails,
      // the org is unsuspended, and the vehicles and the customers' live
      // deposits both SURVIVE — with no claims. The authority then reports
      // every car free and admits a competing sale. My purge order would have
      // manufactured exactly the defect this authority exists to prevent.
      //
      // Convex enforces no foreign keys, so a claim briefly pointing at a
      // deleted vehicle is inert. A surviving sellable vehicle with no claim is
      // not. The safe rule is therefore: NEVER delete the authority while its
      // vehicle can survive a recoverable purge.
      //
      // The registry itself corroborates that child-before-parent was never the
      // real invariant here — `financeApplications` (41) already outlives
      // `vehiclesWithStorage` (19).
      const order = ORGANIZATION_DELETION_STEPS.map((step) =>
        step.kind === "orgRows" ? step.table : step.kind
      );
      const at = (name: (typeof order)[number]) => order.indexOf(name);

      const referents = [
        "vehicleReservations",
        "vehiclesWithStorage",
        "financeApplications",
        "deposits",
        "quotes",
      ] as const;
      for (const referent of referents) {
        expect(at(referent)).toBeGreaterThanOrEqual(0);
      }

      // The precedent: an application already outlives the vehicle it names.
      expect(at("financeApplications")).toBeGreaterThan(at("vehiclesWithStorage"));

      // THE REQUIREMENT: the claim step must come after the LATEST referent
      // that could survive a failed run holding real value — the vehicle and
      // the money. Placing it before any of them re-creates the free-car state.
      const latestValueBearer = Math.max(
        at("vehiclesWithStorage"),
        at("deposits"),
        at("financeApplications")
      );
      expect(latestValueBearer).toBe(at("deposits"));

      // When the claim step is added this becomes:
      //   expect(at("vehicleCommitmentClaims")).toBeGreaterThan(latestValueBearer);
      //
      // Asserted as ABSENT rather than written as the real check, because
      // `indexOf` returns -1 for a missing step — and -1 > anything is false,
      // so the real assertion would fail loudly rather than pass vacuously.
      // That is the safe direction, but it would fail for the wrong reason
      // today, so the absence is what is pinned.
      expect(order).not.toContain("vehicleCommitmentClaims");
    });
  });

  describe("9. re-quoting a live deal must not orphan it", () => {
    // The dead-end that identity-equals-quoteId would have created, and the
    // reason c14659 made the root server-owned.
    //
    // `saveQuote` has no update path — verified: an unconditional
    // `ctx.db.insert("quotes", ...)`, with the only patch being
    // `updateQuoteStatus` on `status` alone. So every renegotiation mints a new
    // `quoteId`. If the quote id WERE the root, a price change after a deposit
    // would strand the customer's own deal behind the different-root rule.

    // PENDING SURFACE — the failing call is the specification. No linkage field exists on `quotes` (no
    // `supersedesQuoteId`, no revision pointer anywhere in the schema), so a
    // LINKED re-quote is not expressible today and this cannot be written as a
    // running assertion without inventing the field in the test.
    //
    // REQUIRED CONTRACT (c14659): a re-quote the server can tie to the same
    // deal RESOLVES TO THE SAME ROOT, so the deal continues — the second
    // quote's deposit, application and completion are all admitted.
    test("a LINKED re-quote resolves to the same root and the deal continues", async () => {
      const seed = await seedDealer("requote-linked");
      const v = await vehicle(seed, "LIN0000000000017");
      const first = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: first, amount: 1_000 });

      // Fails today: `saveQuote` has no `supersedesQuoteId`. Once it does, this
      // keeps failing until the revision genuinely resolves to the same root —
      // proven by the deposit on the NEW quote being accepted, which under the
      // different-root rule is only possible if the root was shared.
      const revised = await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE - 1_000, // renegotiated down
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        supersedesQuoteId: first,
      });

      await expect(
        seed.asUser.mutation(api.deposits.create, {
          orgId: seed.orgId,
          quoteId: revised as Id<"quotes">,
          amount: 500,
        })
      ).resolves.toBeDefined();
    });

    // PENDING SURFACE — the failing call is the specification. Both reviewers converged here independently, and
    // the precedent is already in the codebase.
    //
    // The two new mechanisms this design introduces — `createReservation`'s
    // `quoteId` and a re-quote's linkage — both let a caller CROSS a root
    // boundary. Neither contract says WHO may supply that proof. Implemented
    // literally, a staff member who mis-copies a quote id can attach customer
    // B's reservation to customer A's live root, or let B's quote "supersede"
    // A's committed deal — defeating the different-root rule through the one
    // mechanism built to cross it.
    //
    // `sales.create` already solved this shape (`saleCompletion.ts:214`):
    //   if (quote.customerId !== args.customerId || !quoteVehicleIds.includes(...))
    //     throw "Quote does not match the sale customer and vehicle."
    //
    // REQUIRED CONTRACT: proof must be AUTHORIZED, not merely valid. A supplied
    // root proof is rejected when the resolved root's customer differs from the
    // caller-supplied customer, or when the predecessor quote names a different
    // vehicle set. Customer merge does not weaken this — `quotes`, `deposits`,
    // `financeApplications` and `vehicleReservations` are all live-repointed by
    // `mergeCustomers`, and `customerMergeRegistry.test.ts` mechanically forces
    // any new `customerId`-bearing table into that registry.
    test("a reservation root proof belonging to a DIFFERENT customer is refused", async () => {
      const seed = await seedDealer("proof-authz-res");
      const v = await vehicle(seed, "LIN0000000000020");
      const rootA = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootA, amount: 1_000 });

      await expect(
        seed.asUser.mutation(notYetBuilt.vehicles.createReservation, {
          orgId: seed.orgId,
          vehicleId: v,
          customerId: seed.customerB, // NOT the root's customer
          quoteId: rootA, // a valid id, an unauthorized bearer
        })
      ).rejects.toThrow(/does not match|not this customer|unauthorized|different customer/i);
    });

    test("a saveQuote supersession proof belonging to a DIFFERENT customer is refused", async () => {
      // The sibling that previously existed ONLY as a trailing comment on the
      // test above — which is exactly how half of an accepted security rule
      // goes unimplemented while every pinned test stays green.
      const seed = await seedDealer("proof-authz-quote");
      const v = await vehicle(seed, "LIN0000000000028");
      const rootA = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootA, amount: 1_000 });

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerB, // rival hijacking A's committed root
          vehicleId: v,
          mode: "CASH",
          vehiclePrice: PRICE,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          supersedesQuoteId: rootA,
        })
      ).rejects.toThrow(/does not match|not this customer|unauthorized|different customer/i);
    });

    test("a supersession proof naming a DIFFERENT vehicle is refused", async () => {
      // ⚠️ The vehicle half of the supersession rule, which existed only for
      // the RESERVATION bridge. Same omission shape as the customer half above:
      // a rule pinned on one proof surface and merely described on the other.
      //
      // Concrete hazard: an implementation validating only the customer lets a
      // supersession inherit a live root and swing it onto INVENTORY THE ROOT
      // NEVER COVERED — the customer is right, so every collision fixture stays
      // green while an unrelated car is quietly absorbed into a committed deal.
      const seed = await seedDealer("proof-vehicle-quote");
      const owned = await vehicle(seed, "LIN0000000000066");
      const unrelated = await vehicle(seed, "LIN0000000000067");
      const rootA = await quoteFor(seed, seed.customerA, owned);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootA, amount: 1_000 });

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA, // right customer — wrong car
          vehicleId: unrelated,
          mode: "CASH",
          vehiclePrice: PRICE,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          supersedesQuoteId: rootA,
        })
      ).rejects.toThrow(/does not match|vehicle|different vehicle|unauthorized/i);
    });

    test("a supersession proof whose vehicle SET differs from the predecessor is refused", async () => {
      // `vehicleId` is a convenience field; `vehicleItems` is authoritative. A
      // guard reading only the scalar lets a single-car root grow a second car
      // it never held — inventory smuggled in through renegotiation.
      const seed = await seedDealer("proof-set-quote");
      const owned = await vehicle(seed, "LIN0000000000068");
      const smuggled = await vehicle(seed, "LIN0000000000069");
      const rootA = await quoteFor(seed, seed.customerA, owned);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootA, amount: 1_000 });

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: owned, // scalar matches the predecessor…
          vehicleItems: [
            { vehicleId: owned, unitPrice: PRICE },
            { vehicleId: smuggled, unitPrice: PRICE }, // …the SET does not
          ],
          mode: "CASH",
          vehiclePrice: PRICE * 2,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          supersedesQuoteId: rootA,
        })
      ).rejects.toThrow(/does not match|vehicle set|different vehicle|unauthorized/i);
    });

    test("an INDEPENDENT re-quote is still a competing root", async () => {
      // The other half, and it must keep failing closed: without a linkage the
      // server cannot tell a renegotiation from a second, rival deal — so it
      // must assume rival. This is the same shape as the same-customer refusal
      // in section 2, asserted here against the re-quote framing so the two
      // halves of c14659 sit side by side.
      const seed = await seedDealer("requote-independent");
      const v = await vehicle(seed, "LIN0000000000018");

      const first = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: first, amount: 1_000 });

      const unlinked = await quoteFor(seed, seed.customerA, v);
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: unlinked, amount: 500 })
      ).rejects.toThrow(/committed|another deal|already held|different deal/i);
    });
  });

  describe("10. legacy multi-root vehicles are NOT cutover-ready", () => {
    // PENDING SURFACE — the failing call is the specification, and the reason it must exist separately from
    // the characterization test below.
    //
    // That test proves the hazard is CONSTRUCTIBLE. It does not encode the
    // ruling: an implementation that picks the oldest root, picks the newest,
    // swallows ambiguity and returns FREE, or marks the vehicle cutover-ready
    // anyway would satisfy it completely, because it never invokes a resolver,
    // a cutover gate, or a competing acquisition.
    //
    // It is also self-limiting — once the write guard lands, the second
    // `deposits.create` is refused and the fixture goes red at its own setup.
    // So the specification version seeds the legacy rows DIRECTLY, which is
    // what a backfill actually meets and what survives the guard.
    //
    // REQUIRED CONTRACT (c14659): given a vehicle carrying two live roots,
    //   - the resolver returns CONFLICT, or fails closed — never a winner;
    //   - cutover readiness for that vehicle is FALSE;
    //   - no customer's money is moved, reassigned, or released;
    //   - ambiguity is never reported as free inventory;
    //   - the compatibility fallback stays until the conflict is explicitly
    //     resolved, or eliminated by the production reset.
    test("a legacy vehicle with two live roots resolves to CONFLICT and is not cutover-ready", async () => {
      const seed = await seedDealer("legacy-spec");
      const v = await vehicle(seed, "LIN0000000000023");
      const rootA = await quoteFor(seed, seed.customerA, v);
      const rootB = await quoteFor(seed, seed.customerB, v);

      // Seeded DIRECTLY rather than through `deposits.create`, because once the
      // acquisition guard lands the public path refuses the second deposit and
      // this scenario becomes unconstructible through the API — while remaining
      // exactly what a backfill inherits from today's data. A specification that
      // can only be expressed before the fix is no specification for the fix.
      await seed.t.run(async (ctx) => {
        for (const [customerId, quoteId, amount] of [
          [seed.customerA, rootA, 1_000],
          [seed.customerB, rootB, 2_000],
        ] as const) {
          await ctx.db.insert("deposits", {
            orgId: seed.orgId,
            customerId,
            quoteId,
            vehicleId: v,
            amount,
            amountMinor: amount * 1_000,
            currency: "JOD",
            method: "CASH" as const,
            status: "HELD" as const,
            holdActive: true,
            createdAt: Date.now(),
            createdBy: seed.userId,
          });
        }
      });

      const resolved = await seed.asUser.query(notYetBuiltQuery.commitments.resolveVehicleRoot, {
        orgId: seed.orgId,
        vehicleId: v,
      });
      expect((resolved as { kind: string }).kind).toBe("CONFLICT");
      expect((resolved as { winner?: unknown }).winner).toBeUndefined();

      const readiness = await seed.asUser.query(notYetBuiltQuery.commitments.cutoverReadiness, {
        orgId: seed.orgId,
      });
      expect((readiness as { blockedVehicleIds: unknown[] }).blockedVehicleIds).toContain(v);
    });

    test("main actively manufactures the conflicted state a backfill will meet", async () => {
      // Passes TODAY, and that is the point: it proves the hazard is real
      // rather than hypothetical. Current `deposits.create` permits two live
      // deposits from different quotes and different customers on one vehicle
      // — `convex/deposits.test.ts` requires it — so any backfill WILL find
      // vehicles carrying two roots' worth of live money.
      //
      // c14659 rules how that is handled: FAIL CLOSED, no automatic winner.
      // Never oldest, never newest, never silently move a customer's money,
      // and never read ambiguity as free inventory. A conflicted vehicle is
      // NOT CUTOVER-READY and the compatibility fallback stays until the
      // conflict is explicitly resolved — or eliminated by the production
      // reset, since no historical repair migration is being built to preserve
      // rows that are going away.
      //
      // Asserted as a live constructible state so that if a future change makes
      // it unconstructible, this test fails and tells us the hazard closed —
      // rather than the requirement quietly outliving the problem.
      // ⚠️ REWRITTEN — this test used to MANUFACTURE the conflict through the
      // public API: two quotes, two customers, one car, and two successful
      // `deposits.create` calls, then asserted both holds were live.
      //
      // That is a direct contradiction with describe 2 (`:388`), which requires
      // exactly that second call to be REFUSED. Both fixtures constructed the
      // same public-API situation and demanded opposite outcomes, so no
      // authority could satisfy both and the suite could never go fully green.
      // It hid from my first contradiction sweep because those two deposits
      // were bare SETUP calls with no `expect()` wrapper — an unasserted call
      // is a specification exactly as binding as a decorated one.
      //
      // The evidence it carried is still worth keeping: proof that the hazard
      // is REAL rather than hypothetical. But that proof does not have to be
      // manufactured here — it already exists on `main`, as a test that
      // REQUIRES today's permissive behaviour. Asserting that test still exists
      // keeps the hazard documented while requiring nothing of the fixed API.
      // The conflicted STATE itself is constructed by the sibling test above,
      // which seeds legacy rows directly and therefore survives the fix.
      const { readFileSync } = await import("node:fs");
      const superseded = readFileSync("convex/deposits.test.ts", "utf8");

      expect(superseded).toContain(
        "a second deposit from a different quote on the same vehicle does not error (soft warning, not a hard block)"
      );
    });
  });

  describe("11. c14796: the root exists from the first quote, and supersession is linear", () => {
    /**
     * The three rulings this block encodes, and why each replaced something.
     *
     * 1. LINEAR CURRENT-HEAD + CAS. A lineage has one `currentQuoteId` and a
     *    monotonic revision. ONLY the current quote may be superseded, so two
     *    simultaneous supersessions cannot mint sibling "valid" revisions —
     *    one wins atomically, the stale one refuses. Every new deposit,
     *    application and reservation must originate from the CURRENT revision.
     *
     * 2. THE ROOT IS CREATED AT THE FIRST QUOTE SAVE, NOT AT FIRST HARD
     *    EVIDENCE. This overrode my own recommendation, and the override is
     *    the better answer. I proposed creating the root lazily, when the first
     *    deposit or application arrives — which leaves exactly the race Codex
     *    described open: two linked re-quotes taking their first deposits
     *    concurrently, each finding no root and each minting one. Creating the
     *    identity up front removes the race by construction: activation becomes
     *    an UPDATE to something that already exists, never a creation, so there
     *    is no window in which two writers can both decide to create.
     *
     *    The root is INFORMATIONAL AND NON-LOCKING until activated. Saving a
     *    quote must not hold a car — that would turn every browsing customer
     *    into an inventory lock, which is the failure mode this whole issue
     *    exists to avoid at the other extreme.
     *
     * 3. MONEY BELONGS TO THE ROOT; `quoteId` IS PROVENANCE. A Q1 deposit
     *    survives a linked Q2 re-quote as evidence on the same root. Completion
     *    on Q2 must inspect and resolve ALL live evidence across EVERY revision.
     *    If even one deposit, hold, reservation or finance claim cannot be
     *    deterministically handled, completion fails ATOMICALLY — no orphaning,
     *    no automatic refund, no silent reassignment, no silent deactivation,
     *    no double application.
     */

    test("saving a quote does NOT lock the vehicle", async () => {
      // The non-locking half, and it must keep passing. A root exists from the
      // first save, but an informational quote holds nothing — two customers
      // may both be quoted the same car, and an uncommitted car still sells.
      // Without this control, "create the root early" would quietly become
      // "browsing locks inventory".
      const seed = await seedDealer("root-nonlocking");
      const v = await vehicle(seed, "LIN0000000000024");

      await quoteFor(seed, seed.customerA, v);
      await expect(quoteFor(seed, seed.customerB, v)).resolves.toBeDefined();

      const saleId = await seed.asUser.mutation(api.sales.create, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerB,
        salespersonId: seed.userId,
        salePrice: PRICE,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
      });
      expect(await seed.t.run((ctx) => ctx.db.get(saleId))).toBeTruthy();
    });

    // PENDING SURFACE — the failing call is the specification. No `supersedesQuoteId`, no `currentQuoteId` and
    // no revision counter exist on `quotes` yet, so none of the CAS behaviour
    // is expressible without inventing the fields inside the test.
    //
    // REQUIRED CONTRACT (c14796):
    //   - the lineage carries `currentQuoteId` and a monotonic `revision`;
    //   - `saveQuote({ supersedesQuoteId })` succeeds ONLY when the named quote
    //     IS the current head — a compare-and-set;
    //   - superseding a STALE revision refuses, atomically, with no new quote
    //     row written;
    //   - two concurrent supersessions of the same head: exactly one commits.
    test("only the CURRENT head may be superseded — a stale revision refuses", async () => {
      const seed = await seedDealer("cas-stale");
      const v = await vehicle(seed, "LIN0000000000025");
      const r1 = await quoteFor(seed, seed.customerA, v);

      const revise = (predecessor: Id<"quotes">, price: number) =>
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: v,
          mode: "CASH",
          vehiclePrice: price,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          supersedesQuoteId: predecessor,
        });

      // r1 is the head, so this moves it to r2.
      await revise(r1, PRICE - 500);

      // r1 is now stale. Superseding it again must refuse rather than fork the
      // lineage into two sibling "valid" revisions.
      await expect(revise(r1, PRICE - 900)).rejects.toThrow(
        /not the current revision|superseded|stale|current head/i
      );
    });

    // PENDING SURFACE — the failing call is the specification. Same missing surfaces.
    //
    // REQUIRED CONTRACT (c14796): new hard evidence must originate from the
    // CURRENT revision. A deposit, application or reservation quoting a
    // superseded revision is refused — otherwise money attaches to terms the
    // deal has already moved past, which is how a renegotiated price silently
    // fails to apply.
    test("new evidence must originate from the current revision", async () => {
      const seed = await seedDealer("cas-evidence");
      const v = await vehicle(seed, "LIN0000000000026");
      const r1 = await quoteFor(seed, seed.customerA, v);

      const r2 = (await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE - 500,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        supersedesQuoteId: r1,
      })) as Id<"quotes">;

      // Money must not attach to terms the deal has already moved past — that
      // is precisely how a renegotiated price silently fails to apply.
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r1, amount: 500 })
      ).rejects.toThrow(/current revision|superseded|stale/i);

      // …and the head still works, so the rule is a redirect, not a block.
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r2, amount: 500 })
      ).resolves.toBeDefined();
    });

    // PENDING SURFACE — the failing call is the specification, and this is the ruling with the sharpest teeth.
    //
    // REQUIRED CONTRACT (c14796): money belongs economically to the ROOT;
    // `quoteId` is provenance only. A Q1 deposit survives a linked Q2 re-quote
    // as live evidence on the same root, and completion on Q2 must inspect and
    // resolve EVERY live piece of evidence across EVERY revision.
    //
    // If even one deposit, hold, reservation or finance claim cannot be
    // deterministically handled, completion FAILS ATOMICALLY. Explicitly
    // forbidden: orphaning it, refunding it automatically, reassigning it
    // silently, deactivating it silently, or applying it twice. A completion
    // that "mostly" resolves the money is the defect, not a partial success.
    test("completion on a later revision resolves ALL live evidence on the root", async () => {
      const seed = await seedDealer("root-money");
      const v = await vehicle(seed, "LIN0000000000027");
      const r1 = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r1, amount: 1_000 });

      const r2 = (await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        supersedesQuoteId: r1,
      })) as Id<"quotes">;

      const saleId = await seed.asUser.mutation(api.sales.create, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
        salespersonId: seed.userId,
        salePrice: PRICE,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
        quoteId: r2,
      });

      // The Q1 deposit is live, on the same root, under an OLDER revision.
      // Completing r2 must APPLY it — not ignore it because its provenance
      // quoteId differs from the one being completed. An unapplied deposit here
      // is money the customer paid that the sale never credited.
      const applications = await seed.t.run(async (ctx) => {
        const rows = await ctx.db
          .query("depositApplications")
          .filter((q) => q.eq(q.field("saleId"), saleId))
          .collect();
        return rows;
      });
      expect(applications.length).toBeGreaterThan(0);
    });
  });

  describe("12. c14833 item 2: the deposit ceiling is ROOT-wide, not quote-wide", () => {
    /**
     * Today's ceiling is scoped to one quote: `deposits.create` sums
     * `by_quote(args.quoteId)` and compares against that quote's own
     * `vehiclePrice`. Under lineage that is not a ceiling at all — it is a
     * ceiling per revision, and a deal can hold more money than it is for.
     *
     * The failure this produces is not abstract. It is the exact interaction
     * between two rules that were each individually sensible: the per-quote cap
     * lets the money in, and "resolve all evidence or fail atomically" then has
     * nowhere to put the excess — so completion must refuse, and the customer
     * who has paid MORE than the price cannot buy the car.
     *
     * c14833: all economically retained deposit money across every revision
     * counts against the CURRENT head's price, and a linked price reduction
     * below money already held refuses IMMEDIATELY rather than deferring the
     * contradiction to completion time.
     */
    test("money across revisions counts against the CURRENT head price", async () => {
      const seed = await seedDealer("ceiling-lineage");
      const v = await vehicle(seed, "LIN0000000000029");

      // Q1 at full price, 5,000 down — comfortably inside Q1's own cap.
      const r1 = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r1, amount: 5_000 });

      // Renegotiated DOWN by 1,000.
      const r2 = (await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE - 1_000,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        supersedesQuoteId: r1,
      })) as Id<"quotes">;

      // This tops the ROOT above the new head price while sitting inside R2's
      // own per-quote cap — which is precisely the gap. It must be refused at
      // acquisition, not discovered at completion.
      await expect(
        seed.asUser.mutation(api.deposits.create, {
          orgId: seed.orgId,
          quoteId: r2,
          amount: PRICE - 1_000 - 4_000,
        })
      ).rejects.toThrow(/exceed|ceiling|already held|total deposits/i);
    });

    test("a linked price reduction BELOW money already held refuses immediately", async () => {
      // The other direction, and the one that prevents the dead-end rather than
      // merely detecting it. If the renegotiated price is lower than the money
      // already down, the contradiction exists the moment the revision is
      // saved. Refusing there is recoverable — the operator picks a different
      // price or resolves the deposit. Allowing it and refusing at completion
      // strands a paid-up customer at the last step.
      const seed = await seedDealer("ceiling-reduction");
      const v = await vehicle(seed, "LIN0000000000030");

      const r1 = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r1, amount: 9_000 });

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: v,
          mode: "CASH",
          vehiclePrice: 4_000, // below the 9,000 already held
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          supersedesQuoteId: r1,
        })
      ).rejects.toThrow(/below|already held|deposits|exceed/i);
    });

    test("a lineage total WITHIN the head price is still accepted", async () => {
      // The control. A root-wide ceiling must not become "one deposit per
      // deal" — instalments are the behaviour that started this whole design.
      const seed = await seedDealer("ceiling-ok");
      const v = await vehicle(seed, "LIN0000000000031");
      const r1 = await quoteFor(seed, seed.customerA, v);

      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r1, amount: 1_000 });
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r1, amount: 2_000 })
      ).resolves.toBeDefined();
    });

    /**
     * ## Round-6: "economically retained" was a phrase, not a formula
     *
     * Both seats landed on the same gap from different directions. The tests
     * above vary only the PRICE and never the AMOUNT, so every one of them
     * passes under the most naive reading — the raw sum of deposit face values
     * — while `deposits.releasedAmountMinor` (a real, shipped field, with
     * refunded and forfeited parts kept apart) is never consulted anywhere in
     * this file.
     *
     * The binding rule:
     *
     *     retained(root) = Σ (economically live deposit amounts)
     *                    − Σ (amounts actually paid back or forfeited)
     *
     * across every revision of the root. Money that genuinely left the customer
     * — refunded or forfeited — stops counting. Money that is APPLIED or merely
     * RELEASED_AWAITING_DECISION has NOT left: still the customer's, still on
     * the deal, still counts. `VOIDED` / soft-deleted deposit rows contribute
     * ZERO; they are not customer credit and must not inflate the ceiling.
     *
     * ⚠️ WHERE THE PREVIOUS VERSION OF THIS COMMENT WAS WRONG — and it was
     * wrong in the one way that matters, because it claimed to remove guesswork.
     *
     * It stated the rule as a direct field read,
     * `Σ amountMinor − Σ deposit.releasedAmountMinor`, "so an implementer does
     * not have to guess". But `releasedAmountMinor` is written ONLY by
     * `releaseHeldDeposit` (`utils/depositHelpers.ts:902+`). The per-share path
     * — `resolveReleasedAllocation` → `payOutDepositSlice` (`754–901`) — never
     * patches the deposit row at all. Both halves of the pair below resolve a
     * share, so under the literal formula BOTH read zero and the pair does not
     * discriminate: the exact property it was written to have.
     *
     * The codebase already knows this. `utils/depositAllocation.ts:223-311`
     * computes refunded/forfeited as `sliceRefunded + rowLevelRefundedMinor` —
     * an explicit row-PLUS-slice split that exists precisely because the row
     * field alone is insufficient for multi-vehicle deposits. That is the
     * required precedent. An implementation may instead keep the row aggregate
     * in sync from `payOutDepositSlice`, but it may not read the row field and
     * assume it is complete.
     *
     * Legacy rows with absent release totals normalise to "nothing released".
     */
    test("a price RISE lifts the ceiling — headroom is recomputed, not remembered", async () => {
      const seed = await seedDealer("ceiling-rise");
      const v = await vehicle(seed, "LIN0000000000055");
      const r1 = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r1, amount: PRICE });

      // Renegotiated UP: 28,000 held against a 35,000 head leaves 7,000 of room.
      //
      // ⚠️ The new head is CAPTURED and used. The first version of this test
      // discarded it and deposited against `r1` — which describe 11 requires to
      // be REFUSED as a superseded revision (`:1237`). Two fixtures demanding
      // opposite outcomes for one operation shape: no implementation could
      // satisfy both, so this test would have stayed red forever against a
      // correct stale-head guard, or forced an implementer to punch a hole in
      // it. Both seats found it independently.
      const r2 = (await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: 35_000,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        supersedesQuoteId: r1,
      })) as Id<"quotes">;

      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r2, amount: 7_000 })
      ).resolves.toBeDefined();
    });

    /**
     * The discriminating PAIR. Both start from the identical state — a 4,000
     * deposit on a two-car deal with a 2,000 share released — and both
     * renegotiate the head down to 3,000. The ONLY difference is whether that
     * released share was actually paid back.
     *
     * Under the naive face-value sum both refuse. Under the binding formula
     * one refuses and one succeeds. That is what makes them evidence rather
     * than decoration; either test alone proves nothing.
     *
     * Note `deposits.release` takes no amount — it resolves a whole deposit,
     * and refuses outright while any share is still allocated. The genuine
     * partial-refund mechanism is per-share resolution, which is why the
     * refund half goes through `resolveReleasedAllocation`.
     */
    test("money merely AWAITING A DECISION still counts — it has not left the deal", async () => {
      const seed = await seedDealer("ceiling-awaiting");
      const { root, keep, freed } = await dealWithReleasedShare(
        seed,
        "LIN0000000000057",
        "LIN0000000000157"
      );

      // Nothing was refunded, so all 4,000 is still the customer's credit.
      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: keep,
          vehicleItems: [
            { vehicleId: keep, unitPrice: 1_500 },
            { vehicleId: freed, unitPrice: 1_500 },
          ],
          mode: "CASH",
          vehiclePrice: 3_000,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          supersedesQuoteId: root,
        })
      ).rejects.toThrow(/below|already held|deposits|exceed/i);
    });

    test("money actually REFUNDED stops counting — the same head is then admissible", async () => {
      const seed = await seedDealer("ceiling-refunded");
      const { root, keep, freed } = await dealWithReleasedShare(
        seed,
        "LIN0000000000058",
        "LIN0000000000158"
      );

      const releasedHold = await seed.t.run(async (ctx) => {
        const holds = await ctx.db
          .query("depositVehicleHolds")
          .filter((q) => q.eq(q.field("vehicleId"), freed))
          .collect();
        return holds.find((hold) => hold.allocationStatus === "RELEASED_AWAITING_DECISION");
      });

      // 2,000 genuinely paid back: retained falls to 2,000.
      //
      // Resolved by the APPROVER, not the creator: `assertDifferentActors`
      // enforces maker-checker on refunds, so using the same identity fails on
      // that guard instead of on the ceiling — the wrong-reason failure this
      // round was called to eliminate.
      await seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: seed.orgId,
        holdId: releasedHold!._id,
        treatment: "REFUND_TO_CUSTOMER" as const,
        refundMethod: "CASH" as const,
        reason: "customer took the money back",
      });

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: keep,
          vehicleItems: [
            { vehicleId: keep, unitPrice: 1_500 },
            { vehicleId: freed, unitPrice: 1_500 },
          ],
          mode: "CASH",
          vehiclePrice: 3_000,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          supersedesQuoteId: root,
        })
      ).resolves.toBeDefined();
    });

    test("an AWAITING-DECISION root is still supersedable when the new head clears the retained amount", async () => {
      // ⚠️ THE ANTI-CONFOUND. Without this control the pair above is satisfied
      // by an implementation that never computes a ceiling at all and simply
      // says "refuse any supersession while a share is awaiting a decision" —
      // that shortcut refuses the first half and permits the second, scoring
      // two green lights for a rule it does not implement.
      //
      // Here the money is untouched and unresolved exactly as in the refusing
      // case; only the proposed head differs, and it CLEARS the 4,000 retained.
      // The shortcut refuses this; a real ceiling calculation allows it.
      const seed = await seedDealer("ceiling-awaiting-ok");
      const { root, keep, freed } = await dealWithReleasedShare(
        seed,
        "LIN0000000000064",
        "LIN0000000000164"
      );

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: keep,
          vehicleItems: [
            { vehicleId: keep, unitPrice: 2_500 },
            { vehicleId: freed, unitPrice: 2_500 },
          ],
          mode: "CASH",
          vehiclePrice: 5_000, // above the 4,000 still retained
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          supersedesQuoteId: root,
        })
      ).resolves.toBeDefined();
    });

    test("a VOIDED deposit contributes NOTHING to the ceiling", async () => {
      // A voided row is not customer credit. Counting its face value would
      // refuse renegotiations on money that does not exist — and the raw
      // formula, read literally, counts it, because voiding does not populate
      // `releasedAmountMinor` (`voidDeposit` in fact refuses when that field is
      // already non-zero).
      const seed = await seedDealer("ceiling-voided");
      const v = await vehicle(seed, "LIN0000000000065");
      const r1 = await quoteFor(seed, seed.customerA, v);
      const depositId = await seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: r1,
        amount: 20_000,
      });
      await seed.asApprover.mutation(api.deposits.voidDeposit, {
        orgId: seed.orgId,
        depositId,
        reason: "entered against the wrong deal",
      });

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: v,
          mode: "CASH",
          vehiclePrice: 6_000, // far below the voided 20,000 face value
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          supersedesQuoteId: r1,
        })
      ).resolves.toBeDefined();
    });
  });

  describe("13. c14833 item 6: vehicle ownership and unresolved money are SEPARATE axes", () => {
    /**
     * ⚠️ THIS CORRECTS SOMETHING I ENCODED BACKWARDS.
     *
     * I fused the two axes — "releasing the finance claim does not free the
     * unit while live money remains on the root". That is right for money that
     * is still HOLDING the car, and wrong as a general rule, because the
     * existing engine deliberately produces a state where it is not:
     *
     *   `convex/deposits.test.ts` — "cancelling every sale row of a
     *   multi-vehicle deal FREES EVERY VEHICLE and leaves each share AWAITING A
     *   DECISION".
     *
     * So `RELEASED_AWAITING_DECISION` money does NOT hold a vehicle. The car is
     * genuinely free and another deal may legitimately take it. What remains
     * open is the ROOT's financial position: that customer's money still exists
     * and still needs an explicit decision.
     *
     * Two axes, and conflating them fails in both directions — treat released
     * money as holding and you lock inventory that cancellation deliberately
     * freed; treat the root as closed and you silently discard a customer's
     * money.
     */
    /**
     * The RELEASED_AWAITING_DECISION state only arises on a MULTI-vehicle deal.
     *
     * My first version of these fixtures used a single-vehicle quote and every
     * one failed on "This quote covers a single vehicle, so its deposit is
     * already allocated to it in full" — a refusal from a completely different
     * rule, which would have recorded three findings that were really one
     * fixture bug. The engine only produces awaiting-decision shares when a
     * share can be released while the deal continues, which needs two cars.
     */
    test("RELEASED_AWAITING_DECISION money does not hold the vehicle", async () => {
      // Ownership axis. Cancellation freed the car on purpose; an independent
      // deal may take it. This must keep passing — a commitment authority that
      // re-locks it would break the cancellation flow the engine already has.
      const seed = await seedDealer("axes-free");
      const { freed } = await dealWithReleasedShare(seed, "LIN0000000000032", "LIN0000000000132");

      const rival = await quoteFor(seed, seed.customerB, freed);
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rival, amount: 1_500 })
      ).resolves.toBeDefined();
    });

    test("but the original root stays FINANCIALLY open until that money is resolved", async () => {
      // Money axis. The car is gone; the customer's money is not. Closing the
      // root while a share sits AWAITING A DECISION would be exactly the silent
      // discard c14833 forbids — no orphaning, no automatic refund, no silent
      // deactivation.
      const seed = await seedDealer("axes-open");
      const { root } = await dealWithReleasedShare(seed, "LIN0000000000033", "LIN0000000000133");

      const state = await seed.asUser.query(notYetBuiltQuery.commitments.rootFinancialState, {
        orgId: seed.orgId,
        quoteId: root,
      });
      expect((state as { financiallyOpen: boolean }).financiallyOpen).toBe(true);
      expect((state as { unresolvedMinor: number }).unresolvedMinor).toBeGreaterThan(0);
    });

    test("final closure of a root cannot strand awaiting-decision money", async () => {
      // The closing rule. A root may only reach terminal closure once every
      // share has an explicit disposition — applied, refunded or forfeited by
      // decision. "Mostly resolved" is the defect, not a partial success.
      const seed = await seedDealer("axes-closure");
      const { root } = await dealWithReleasedShare(seed, "LIN0000000000034", "LIN0000000000134");

      await expect(
        seed.asUser.mutation(notYetBuilt.commitments.closeRoot, {
          orgId: seed.orgId,
          quoteId: root,
        })
      ).rejects.toThrow(/unresolved|awaiting|decision|cannot close/i);
    });

    /**
     * ## Round-6: one negative test is not a contract (both seats)
     *
     * `closeRoot` was pinned ONLY against the multi-vehicle
     * RELEASED_AWAITING_DECISION edge case. A mutation that special-cases
     * exactly that state and otherwise closes anything satisfies it — so the
     * FIRST-ORDER case, an ordinary mid-deal root with live money and nothing
     * released at all, was the one state nothing checked. That is the silent
     * deactivation c14833 forbids, reachable through the plainest path there is.
     *
     * And with only a negative test, a `closeRoot` that refuses everything and
     * does nothing else is also conformant. A terminal state nothing can reach
     * is not a lifecycle; the successful closure has to be pinned too.
     */
    test("an ordinary root with live money cannot be closed either", async () => {
      const seed = await seedDealer("axes-ordinary");
      const v = await vehicle(seed, "LIN0000000000059");
      const root = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: root,
        amount: 3_000,
      });

      // Nothing released, nothing cancelled — just a deal in progress.
      await expect(
        seed.asUser.mutation(notYetBuilt.commitments.closeRoot, {
          orgId: seed.orgId,
          quoteId: root,
        })
      ).rejects.toThrow(/unresolved|live|open|in progress|cannot close/i);
    });

    test("a root whose money is fully resolved CAN be closed", async () => {
      // The positive half. Without it, "refuses when unresolved" is satisfied
      // by a mutation that never closes anything.
      const seed = await seedDealer("axes-closable");
      const { root, keep } = await dealWithReleasedShare(
        seed,
        "LIN0000000000060",
        "LIN0000000000160"
      );

      // The kept car's share is released too, so BOTH shares are awaiting a
      // decision and the root has no money still holding anything.
      //
      // The engine enforces this order and refuses to shortcut it:
      // `deposits.release` will not touch a deposit whose share is still
      // "allocated to a vehicle still on the deal". Every share must be
      // released and then explicitly resolved — which is precisely the
      // "explicit disposition for every share" rule this test is pinning, so
      // the sequencing is the contract rather than an obstacle to it.
      await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
        orgId: seed.orgId,
        quoteId: root,
        vehicleId: keep,
        reason: "deal wound down",
      });

      const awaiting = await seed.t.run(async (ctx) => {
        const holds = await ctx.db.query("depositVehicleHolds").collect();
        return holds
          .filter((hold) => hold.allocationStatus === "RELEASED_AWAITING_DECISION")
          .map((hold) => hold._id);
      });
      expect(awaiting.length).toBe(2);

      // Maker-checker: refunds are resolved by a different actor than the one
      // who took the deposit (`assertDifferentActors`).
      for (const holdId of awaiting) {
        await seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
          orgId: seed.orgId,
          holdId,
          treatment: "REFUND_TO_CUSTOMER" as const,
          refundMethod: "CASH" as const,
          reason: "resolved",
        });
      }

      await expect(
        seed.asUser.mutation(notYetBuilt.commitments.closeRoot, {
          orgId: seed.orgId,
          quoteId: root,
        })
      ).resolves.toBeDefined();

      // ⚠️ Resolving is not closing. Asserting only that the call succeeds is
      // satisfied by a mutation that validates "no unresolved money" and then
      // returns null without changing a single row — a terminal state nothing
      // can actually reach. What makes this a lifecycle rather than a
      // validator is the state AFTER it.
      const state = await seed.asUser.query(notYetBuiltQuery.commitments.rootFinancialState, {
        orgId: seed.orgId,
        quoteId: root,
      });
      expect((state as { financiallyOpen: boolean }).financiallyOpen).toBe(false);

      const owner = await seed.asUser.query(notYetBuiltQuery.commitments.resolveVehicleRoot, {
        orgId: seed.orgId,
        vehicleId: keep,
      });
      expect((owner as { kind: string }).kind).not.toBe("OWNED");

      // And the strongest evidence that the claim really let go: somebody else
      // can now buy the car.
      const next = await quoteFor(seed, seed.customerB, keep);
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: next, amount: 1_000 })
      ).resolves.toBeDefined();
    });
  });

  describe("14. c14833 item 5: a reservation-first deal has an explicit bridge into a quote", () => {
    /**
     * `createReservation` can establish a reservation root before any quote
     * exists — the ordinary walk-in who puts money down on a car and does the
     * paperwork afterwards. Every bridge specified so far runs the other way:
     * a reservation supplying a quote as proof. Nothing said how the deal gets
     * FROM a reservation root INTO a quote, which left the implementer to
     * invent whether sales infer an active reservation, whether quotes accept a
     * `reservationId`, or whether reservation roots convert into quote roots.
     *
     * c14833: the later first quote may explicitly ADOPT the reservation root
     * via `reservationId`, after the server validates org, customer, vehicle
     * and authorization. No proof means an independent quote — which cannot
     * take a vehicle the reservation already holds.
     */
    test("a first quote may ADOPT the reservation root with explicit proof", async () => {
      const seed = await seedDealer("bridge-adopt");
      const v = await vehicle(seed, "LIN0000000000035");

      const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
      });

      const adopted = (await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        reservationId,
      })) as Id<"quotes">;

      // Adoption is proven by consequence: a deposit on the adopting quote is
      // accepted even though the reservation already holds the car. That is
      // only possible if the quote joined the reservation's root rather than
      // competing with it.
      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: adopted, amount: 1_000 })
      ).resolves.toBeDefined();
    });

    test("without proof the quote is INDEPENDENT and cannot take the reserved vehicle", async () => {
      // The fail-closed half. A quote that merely happens to name the same car
      // and the same customer is not evidence of the same deal — that is the
      // "no broad same-customer exemption" rule, applied to the direction the
      // design had not covered.
      const seed = await seedDealer("bridge-noproof");
      const v = await vehicle(seed, "LIN0000000000036");

      await seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
      });

      const independent = await quoteFor(seed, seed.customerA, v);
      await expect(
        seed.asUser.mutation(api.deposits.create, {
          orgId: seed.orgId,
          quoteId: independent,
          amount: 1_000,
        })
      ).rejects.toThrow(/reserved|committed|another deal|already held/i);
    });

    test("adoption proof belonging to a DIFFERENT customer is refused", async () => {
      // Same authorization rule as every other proof surface: valid id,
      // unauthorized bearer. Pinned here rather than assumed to carry over,
      // because assuming it carried over is exactly how the saveQuote half of
      // this rule went unpinned the first time.
      const seed = await seedDealer("bridge-authz");
      const v = await vehicle(seed, "LIN0000000000037");

      const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
      });

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerB, // not the reservation's customer
          vehicleId: v,
          mode: "CASH",
          vehiclePrice: PRICE,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          reservationId,
        })
      ).rejects.toThrow(/does not match|not this customer|unauthorized|different customer/i);
    });

    /**
     * ## Round-6 CRITICAL: the bridge never tested the money it exists for
     *
     * Every fixture above created the reservation with NO `depositAmount`, so
     * the only money in the whole section arrived after adoption, through the
     * quote. The prose describes a customer who puts money down before there
     * is any paperwork — and that is precisely the case nothing exercised.
     *
     * `vehicles.createReservation` accepts `depositAmount` and
     * `depositMethod`, so reservation-origin money is real and constructible
     * today. An implementation whose root-wide ceiling scans only
     * quote-linked deposits passes every test written so far and still lets a
     * customer's own money exceed the price of the car — after which
     * completion applies the quote deposit and STRANDS the reservation one.
     * Money-loss, reachable, and previously invisible to this file.
     */
    test("reservation-origin money joins the adopted root and counts against its ceiling", async () => {
      const seed = await seedDealer("bridge-money");
      const v = await vehicle(seed, "LIN0000000000045");

      const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
        depositAmount: 5_000,
      });

      const adopted = (await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        reservationId,
      })) as Id<"quotes">;

      // 5,000 already held through the reservation. A further 24,000 would put
      // 29,000 of the customer's money against a 28,000 car.
      await expect(
        seed.asUser.mutation(api.deposits.create, {
          orgId: seed.orgId,
          quoteId: adopted,
          amount: 24_000,
        })
      ).rejects.toThrow(/exceed|more than|price|already held|ceiling/i);
    });

    test("an adoption proof naming a DIFFERENT vehicle is refused", async () => {
      // The other half of the authorization rule, and the half that was left
      // unpinned. The cited precedent — `saleCompletion.ts:214` — checks the
      // customer AND the vehicle together in a single condition. Pinning only
      // the customer half is exactly how half an accepted rule ships unbuilt.
      const seed = await seedDealer("bridge-wrongcar");
      const reserved = await vehicle(seed, "LIN0000000000046");
      const other = await vehicle(seed, "LIN0000000000047");

      const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: reserved,
        customerId: seed.customerA,
      });

      // Right customer, right reservation — wrong car.
      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: other,
          mode: "CASH",
          vehiclePrice: PRICE,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          reservationId,
        })
      ).rejects.toThrow(/does not match|not this vehicle|different vehicle|unauthorized/i);
    });

    test("an adoption proof is refused when the quote's vehicle SET is not the reserved car alone", async () => {
      // `vehicleId` is not the authoritative vehicle set — `vehicleItems` is.
      // Validating the scalar while the quote carries a materially different
      // set adopts a single-car reservation's root onto a multi-car deal.
      const seed = await seedDealer("bridge-setdrift");
      const reserved = await vehicle(seed, "LIN0000000000048");
      const smuggled = await vehicle(seed, "LIN0000000000049");

      const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: reserved,
        customerId: seed.customerA,
      });

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: reserved,
          vehicleItems: [
            { vehicleId: reserved, unitPrice: PRICE },
            { vehicleId: smuggled, unitPrice: PRICE },
          ],
          mode: "CASH",
          vehiclePrice: PRICE * 2,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          reservationId,
        })
      ).rejects.toThrow(/does not match|vehicle set|different vehicle|unauthorized/i);
    });

    test("supplying BOTH proofs that resolve to DIFFERENT roots is refused, not silently reconciled", async () => {
      // Two proofs, two roots, no stated precedence. Whichever one "wins"
      // either merges an independent deal's money into the reservation's root
      // or uses the reservation as permission to move that deal onto the
      // reserved car. The contract must refuse rather than pick.
      const seed = await seedDealer("bridge-bothproofs");
      const reserved = await vehicle(seed, "LIN0000000000050");

      const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: reserved,
        customerId: seed.customerA,
      });
      // An unrelated live deal of the same customer, on its own root.
      const otherCar = await vehicle(seed, "LIN0000000000051");
      const independent = await quoteFor(seed, seed.customerA, otherCar);

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: reserved,
          mode: "CASH",
          vehiclePrice: PRICE,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          reservationId,
          supersedesQuoteId: independent,
        })
      ).rejects.toThrow(/conflicting|both|ambiguous|one root|mutually exclusive|does not match/i);
    });

    test("a reservation that is no longer ACTIVE cannot be adopted", async () => {
      // `vehicleReservations.status` allows RELEASED / CONVERTED / EXPIRED. A
      // proof is only proof while it is live; adopting a dead reservation
      // resurrects a root nobody is holding.
      const seed = await seedDealer("bridge-dead");
      const v = await vehicle(seed, "LIN0000000000052");

      const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
      });
      await seed.t.run(async (ctx) => {
        await ctx.db.patch(reservationId as Id<"vehicleReservations">, { status: "RELEASED" });
      });

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: v,
          mode: "CASH",
          vehiclePrice: PRICE,
          downPayment: 0,
          termMonths: 0,
          totalFinancedAmount: 0,
          reservationId,
        })
      ).rejects.toThrow(/not active|released|expired|converted|no longer/i);
    });

    test("a reservation already adopted by one quote cannot be adopted by a DIFFERENT second quote", async () => {
      // Otherwise the proof is reusable and two quotes claim one root — the
      // multi-root state this whole design exists to make impossible, reached
      // through the bridge instead of around it.
      //
      // ⚠️ The second call is DELIBERATELY DIFFERENT (another customer), and
      // that distinction is load-bearing. The first version replayed byte-
      // identical arguments with no idempotency key — which is indistinguishable
      // from a double-click, and section 15 requires exactly that shape to
      // succeed under one root. Two fixtures demanding opposite outcomes for an
      // identical request: a server with no retry-stable operation id cannot
      // satisfy both, and picking either one silently breaks the other.
      //
      // Making the second call a genuinely different operation removes the
      // ambiguity instead of resolving it by fiat. A reused proof is refused
      // because the RESERVATION is already spoken for — a state rule — not
      // because of anything to do with retries.
      const seed = await seedDealer("bridge-twice");
      const v = await vehicle(seed, "LIN0000000000053");

      const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
      });
      const shared = {
        orgId: seed.orgId,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        reservationId,
      };
      await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        ...shared,
        customerId: seed.customerA,
      });

      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
          ...shared,
          customerId: seed.customerB,
        })
      ).rejects.toThrow(
        /already adopted|already claimed|already linked|not available|does not match|different customer/i
      );
    });
  });

  describe("17. c14833 item 4: cross-surface — a rule pinned on ONE mutation is not pinned", () => {
    /**
     * Every rule in this design spans several mutations, and the failure mode
     * has already happened once here: the cross-customer authorization rule was
     * pinned for `createReservation` and left as a trailing COMMENT for
     * `saveQuote`, so an implementer could have made every test green while
     * leaving half the rule unbuilt.
     *
     * These are the remaining surfaces for the stale-head and reacquisition
     * rules. They are not variations for completeness — each is a different
     * mutation with its own code path, and a guard added to one is not a guard
     * added to the others.
     */
    async function supersededHead(seed: Seed, vin: string) {
      const v = await vehicle(seed, vin);
      const r1 = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE - 500,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        supersedesQuoteId: r1,
      });
      return { v, stale: r1 };
    }

    test("createFromQuote refuses a superseded revision", async () => {
      const seed = await seedDealer("xsurface-app");
      const { stale } = await supersededHead(seed, "LIN0000000000040");

      await expect(
        seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: stale })
      ).rejects.toThrow(/current revision|superseded|stale|current head/i);
    });

    test("createReservation refuses a superseded revision as lineage proof", async () => {
      const seed = await seedDealer("xsurface-res");
      const { v, stale } = await supersededHead(seed, "LIN0000000000041");

      await expect(
        seed.asUser.mutation(notYetBuilt.vehicles.createReservation, {
          orgId: seed.orgId,
          vehicleId: v,
          customerId: seed.customerA,
          quoteId: stale,
        })
      ).rejects.toThrow(/current revision|superseded|stale|current head/i);
    });

    /**
     * ## Round-6: the stale-head rule stopped short of the paths that spend money
     *
     * The block above covers surfaces that CREATE evidence — deposits,
     * applications, reservations. It never covered the surfaces that CONSUME
     * the deal. An implementation can refuse new evidence on a stale revision
     * and still let a sale complete against the OLD price after the customer
     * renegotiated, because completion reads its own quote and never asks
     * whether that quote is still the head.
     *
     * That is the renegotiation failure in its most expensive form: the money
     * is taken at terms the customer already replaced. All three completion
     * doors are separate handlers, so a guard on one is not a guard on any
     * other — the same one-of-two omission this describe exists to prevent,
     * now one-of-five.
     */
    test("completeFromQuote refuses a superseded revision", async () => {
      const seed = await seedDealer("xsurface-complete");
      const { stale } = await supersededHead(seed, "LIN0000000000061");

      await expect(
        seed.asUser.mutation(api.sales.completeFromQuote, {
          orgId: seed.orgId,
          quoteId: stale,
        })
      ).rejects.toThrow(/current revision|superseded|stale|current head/i);
    });

    test("sales.create refuses a superseded revision as its quote", async () => {
      const seed = await seedDealer("xsurface-salecreate");
      const { v, stale } = await supersededHead(seed, "LIN0000000000062");

      await expect(
        seed.asUser.mutation(api.sales.create, {
          orgId: seed.orgId,
          vehicleId: v,
          customerId: seed.customerA,
          salespersonId: seed.userId,
          quoteId: stale,
          salePrice: PRICE,
          saleDate: Date.now(),
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(/current revision|superseded|stale|current head/i);
    });

    test("finalizeDeal refuses once its application's quote has been superseded", async () => {
      // The subtlest of the three: the application was created legitimately
      // against the then-current head, and the head moved AFTERWARDS. Whether
      // an in-flight application pins its original terms or must follow the
      // current head is exactly the question an implementer would otherwise
      // have to invent an answer to.
      const seed = await seedDealer("xsurface-finalize");
      const v = await vehicle(seed, "LIN0000000000063");
      const r1 = await quoteFor(seed, seed.customerA, v, true);
      const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: r1,
      });

      // The customer renegotiates after the application exists.
      await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CONFIGURED_FINANCE_COMPANY",
        companyId: seed.companyId,
        vehiclePrice: PRICE - 1_500,
        downPayment: 0,
        termMonths: 48,
        totalFinancedAmount: PRICE - 1_500,
        supersedesQuoteId: r1,
      });

      await expect(
        seed.asUser.mutation(api.applications.finalizeDeal, {
          orgId: seed.orgId,
          applicationId,
        })
      ).rejects.toThrow(/current revision|superseded|stale|current head/i);
    });

    test("REALLOCATE_TO_VEHICLE is an acquisition too, not only RETURN_TO_UNALLOCATED", async () => {
      // The sibling treatment. Both reinsert an active hold, so pinning only
      // one leaves the other as an unchecked second writer — the same
      // one-of-two omission this whole block exists to prevent.
      //
      // ## Why this fixture is shaped exactly this way — TWO corrections deep
      //
      // v1 released `freed` and re-allocated the share back onto `freed`.
      // Unreachable: `deposits.ts:731` refuses same-source re-allocation
      // outright, before any hold is inserted. Red for an unrelated shipped
      // rule, and it would have stayed red against a CORRECT authority.
      //
      // v2 added a third car and left it UNALLOCATED, on the theory that "no
      // allocation" meant "no hard commitment", so a rival could take it. That
      // contradicted describe 7 of this very file: `deposits.create` calls
      // `holdVehicleForDeposit` for EVERY line on `vehicleItems`, so a deposit
      // acquires all three cars regardless of how the money is split. Under a
      // correct authority the rival's acquisition would refuse first and the
      // call under test would never be reached — a second unreachable fixture,
      // inside the fix for the first. Codex caught it; I had contradicted my
      // own describe 7.
      //
      // v3 — this one. The ONLY way a rival may legitimately hold a car that
      // is a line on our quote is if our root has RELEASED it, because
      // `RELEASED_AWAITING_DECISION` money does not hold a vehicle (describe
      // 13). So `third` gets a real allocation, is released, and is then taken
      // by the rival. Re-allocating `dropped`'s released share onto it is then
      // a genuine acquisition of a car another root owns, which is the rule
      // this test is named for and the first time it is actually exercised.
      const seed = await seedDealer("xsurface-realloc");
      const keep = await vehicle(seed, "LIN0000000000042");
      const dropped = await vehicle(seed, "LIN0000000000043");
      const third = await vehicle(seed, "LIN0000000000044");

      const root = await seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: keep,
        vehicleItems: [
          { vehicleId: keep, unitPrice: PRICE },
          { vehicleId: dropped, unitPrice: PRICE },
          { vehicleId: third, unitPrice: PRICE },
        ],
        mode: "CASH" as const,
        vehiclePrice: PRICE * 3,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
      });
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 6_000 });
      // Every line gets a real share: `releaseVehicleAllocation` refuses a
      // vehicle that "holds no active share of this quote's deposit", so a
      // zero-allocated car could not be released and therefore could never be
      // freed for the rival to take.
      await seed.asUser.mutation(api.deposits.allocateToVehicles, {
        orgId: seed.orgId,
        quoteId: root,
        allocations: [
          { vehicleId: keep, amount: 2_000 },
          { vehicleId: dropped, amount: 2_000 },
          { vehicleId: third, amount: 2_000 },
        ],
      });
      for (const [vehicleId, reason] of [
        [dropped, "customer dropped this one"],
        [third, "customer dropped this one too"],
      ] as const) {
        await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
          orgId: seed.orgId,
          quoteId: root,
          vehicleId,
          reason,
        });
      }

      // Released means genuinely free, so the rival's acquisition is legitimate
      // — that is the ownership/money axis split, relied on rather than
      // restated.
      const rival = await quoteFor(seed, seed.customerB, third);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rival, amount: 1_500 });

      // Selected by allocationStatus, not by `active === false`. The status is
      // what `resolveReleasedAllocation` itself checks, so matching on it means
      // a wrong pick fails loudly here rather than surfacing later as "that
      // allocation has not been released" — an unrelated refusal wearing the
      // costume of the rule under test.
      const releasedHold = await seed.t.run(async (ctx) => {
        const holds = await ctx.db
          .query("depositVehicleHolds")
          .filter((q) => q.eq(q.field("vehicleId"), dropped))
          .collect();
        return holds.find((hold) => hold.allocationStatus === "RELEASED_AWAITING_DECISION");
      });
      expect(releasedHold).toBeDefined();

      await expect(
        seed.asUser.mutation(api.deposits.resolveReleasedAllocation, {
          orgId: seed.orgId,
          holdId: releasedHold!._id,
          treatment: "REALLOCATE_TO_VEHICLE" as const,
          toVehicleId: third,
          reason: "move it to the third car",
        })
      ).rejects.toThrow(/committed|another deal|already held|no longer available/i);
    });
  });

  describe("15. c14833 item 3: saveQuote must be idempotent", () => {
    /**
     * `saveQuote` is an unconditional insert with no idempotency protection,
     * while `deposits.create` — a sibling money-adjacent mutation — wraps every
     * call in `runWithIdempotency`. Once a quote save CREATES the deal-lineage
     * identity, that asymmetry stops being cosmetic: a double-click or a
     * network retry mints TWO roots for what the user did once, and evidence
     * landing on the "wrong" duplicate gets the customer's own deal refused as
     * a competing root.
     *
     * That is a self-inflicted version of the failure this whole design exists
     * to prevent — no adversary, no race between two people, just a retry.
     */
    test("an exact retry returns the SAME quote rather than minting a second root", async () => {
      const seed = await seedDealer("idem-retry");
      const v = await vehicle(seed, "LIN0000000000038");

      const args = {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        idempotencyKey: "quote-save-retry-1",
      };

      const first = await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, args);
      const second = await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, args);
      expect(second).toBe(first);

      const quotes = await seed.t.run((ctx) =>
        ctx.db
          .query("quotes")
          .filter((q) => q.eq(q.field("vehicleId"), v))
          .collect()
      );
      expect(quotes).toHaveLength(1);
    });

    test("the same key with CHANGED terms conflicts rather than silently winning", async () => {
      // The other half, and the one that makes idempotency safe rather than
      // merely convenient. Returning the first quote for a genuinely different
      // request would silently discard the operator's new terms; writing the
      // new terms under the same key would make the retry non-idempotent. A
      // conflict is the only answer that loses nothing.
      const seed = await seedDealer("idem-conflict");
      const v = await vehicle(seed, "LIN0000000000039");

      const base = {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        idempotencyKey: "quote-save-conflict-1",
      };

      await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, { ...base, vehiclePrice: PRICE });
      await expect(
        seed.asUser.mutation(notYetBuilt.quotes.saveQuote, { ...base, vehiclePrice: PRICE - 2_000 })
      ).rejects.toThrow(/idempoten|conflict|different|reused/i);
    });

    /**
     * ## Round-6 CRITICAL: both tests above supply a key. No real caller does.
     *
     * Verified on this commit: all four production callers of `saveQuote` —
     * `QuoteDialog.tsx`, `Step3Review.tsx`, `SalesWizardScreen.tsx` and mobile
     * `quotes.tsx` — omit `idempotencyKey` entirely. `runWithIdempotency`
     * treats the key as OPTIONAL, so an implementation that dedupes only when
     * a key happens to be supplied passes both tests above while every real
     * double-click and every network retry still mints a second root.
     *
     * That is the vacuity class this whole file is meant to prevent, and it
     * had reappeared inside the very section written to close it. The contract
     * therefore has to say what happens with NO key — either the key becomes
     * mandatory (and the four callers must supply a retry-stable one), or the
     * server derives a stable operation identity itself. It cannot stay
     * "idempotent if you ask nicely".
     */
    test("a retry with NO key supplied still does not mint a second root", async () => {
      const seed = await seedDealer("idem-nokey");
      const v = await vehicle(seed, "LIN0000000000054");

      const args = {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
      };

      // The shape every real caller uses today: a double-submit.
      const first = await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, args);
      const second = await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, args);

      // ⚠️ Lineage is resolved by ASKING THE SERVER, not by reading a field
      // this test guessed the name of.
      //
      // The first version read `q.rootId ?? q._id`. Describe 11's own contract
      // says the lineage carries `currentQuoteId` and a revision — which does
      // not require a field literally called `rootId` on each quote row. An
      // implementer who links revisions through `currentQuoteId` instead would
      // hit the `?? q._id` fallback, see two distinct ids, and be failed by
      // this test for building something the design explicitly permits.
      //
      // `rootForEvidence` is already a required surface (the contention harness
      // depends on it), so using it here costs nothing and pins no field name.
      const quoteIds = await seed.t.run(async (ctx) => {
        const quotes = await ctx.db
          .query("quotes")
          .filter((q) => q.eq(q.field("vehicleId"), v))
          .collect();
        return quotes.map((q) => q._id);
      });
      const resolved = await Promise.all(
        quoteIds.map((id) =>
          seed.asUser.query(notYetBuiltQuery.commitments.rootForEvidence, {
            orgId: seed.orgId,
            kind: "quote",
            id,
          })
        )
      );
      const roots = new Set(resolved.map((r) => JSON.stringify(r)));

      // Whether the server returns the same quote or a second revision of the
      // same lineage is an implementation choice; producing two COMPETING
      // ROOTS from one operator action is not.
      expect(roots.size).toBe(1);
      expect(second).toBeDefined();
      expect(first).toBeDefined();
    });
  });
});

describe("16. c14833 item 3: every saveQuote caller is mapped and pinned", () => {
  /**
   * The Revise Quote client work stays inside SCRUM-195 and is owned by the
   * same implementation lane as the backend — server support with no usable
   * client workflow is not cutover-ready. Until that lane runs, no production
   * client changes are made here; what IS made is a forcing function.
   *
   * Once `saveQuote` creates the deal-lineage identity, every caller of it
   * becomes a place where a root is minted. A caller that is added later
   * without a `supersedesQuoteId`/`reservationId` path silently produces
   * independent roots for continuing deals — the renegotiation dead-end,
   * reintroduced by omission rather than by design.
   *
   * So the caller set is asserted. Adding or moving one fails this test and
   * forces the question rather than letting it pass unnoticed. This is a
   * source-scan for the same reason `customerMergeRegistry.test.ts` is one:
   * a registry nobody is required to update is a comment.
   */
  /**
   * ## Round-6: this registry was blind to half its subject (both seats)
   *
   * It scanned `components`, `app` and `lib` only — and `apps/mobile` contains
   * TWO live production callers on this very commit. The forcing function was
   * pointed at the half of the codebase that was already going to be handled.
   *
   * That is not a cosmetic miss. `apps/mobile` has NO revise path at all: its
   * quote save is always a fresh insert, so under the cross-root refusal rule
   * a mobile salesperson who re-prices their own customer's deal produces a
   * COMPETING root and that customer's own second deposit is refused — with no
   * UI, no argument to pass, and nothing anywhere that would have caught it
   * before it shipped. The design would have introduced that breakage itself.
   *
   * ⚠️ OPEN OWNER DECISION — mobile is in scope or explicitly out, and it is
   * not mine to choose. Either the mobile quote flow gets the same
   * `supersedesQuoteId`/`reservationId` support in this lane, or mobile is
   * consciously descoped WITH the consequence written down. What is not
   * acceptable is the third option this registry was silently taking: not
   * knowing mobile existed.
   */
  const CALLERS = [
    "apps/mobile/src/features/workspace/modules/quotes.tsx",
    "apps/mobile/src/features/workspace/salesWizard/SalesWizardScreen.tsx",
    "components/sales/QuoteDialog.tsx",
    "components/sales/wizard/steps/Step3Review.tsx",
  ] as const;

  test("the known callers are exactly the ones that exist", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, relative, sep } = await import("node:path");

    // `convex` is scanned too: a server-side `ctx.runMutation` caller would
    // mint roots exactly like a client one, and none exists today only by
    // accident rather than by any rule.
    const roots = ["components", "app", "lib", "apps", "convex"];
    const found: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "_generated") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry) || /\.test\./.test(entry)) continue;
        const text = readFileSync(full, "utf8");
        // Any REFERENCE to the function, not only the exact
        // `useMutation(api.quotes.saveQuote)` spelling. Matching that one
        // spelling missed aliasing (`const fn = api.quotes.saveQuote`), wrapper
        // hooks and `ctx.runMutation` — every one of which mints a root just
        // the same.
        //
        // ⚠️ The bracket form is matched by the SECOND alternative below. An
        // earlier revision's comment claimed bracket access was covered while
        // the pattern only handled dots — a comment asserting a property the
        // code did not have, which is the same defect this file spends its
        // length hunting. A string-built fully dynamic reference still evades
        // this; that residual hole is stated rather than papered over.
        const DOTTED = /api\s*\.\s*quotes\s*\.\s*saveQuote/;
        const BRACKET = /api\s*(?:\.\s*quotes|\[\s*["'`]quotes["'`]\s*\])\s*\[\s*["'`]saveQuote["'`]\s*\]/;
        if (DOTTED.test(text) || BRACKET.test(text)) {
          found.push(relative(process.cwd(), full).split(sep).join("/"));
        }
      }
    };

    for (const root of roots) {
      try {
        walk(root);
      } catch {
        // A root that does not exist in this checkout is not a caller.
      }
    }

    expect([...new Set(found)].sort()).toEqual([...CALLERS].sort());
  });
});

describe("18. round-6: the contention harness's own seeding surfaces must fail closed", () => {
  /**
   * `scripts/vehicleCommitmentContention.mjs` proves concurrency against a REAL
   * Convex deployment, which means it needs public `testSupport:*` functions
   * that seed scenarios and read commitment state.
   *
   * The script asks the deployment to self-declare `disposable` before calling
   * them. Review found that this is a check by the CALLER — and the caller is
   * the one party whose good behaviour proves nothing. An implementation that
   * ships these as authenticated-but-otherwise-unguarded endpoints makes the
   * probe green while leaving seeding mutations reachable on any deployment
   * where someone holds a valid session. Production included.
   *
   * So the guard belongs on the SERVER, and it has to be executable. These run
   * under `convex-test`, where no disposable-deployment marker exists, so a
   * correct implementation refuses here. A surface that seeds happily in this
   * context is the defect.
   *
   * ⚠️ This is the one contract in this file that protects PRODUCTION rather
   * than a customer's deal, and the only one whose failure mode is silent:
   * nothing in the probe's own output would ever reveal it.
   */
  /**
   * ⚠️ REWRITTEN. The first version invoked all four surfaces as MUTATIONS with
   * `{ orgId }`. Three of them are QUERIES and none of them takes that argument
   * shape, so Convex's argument validator refused every call before the
   * disposable-deployment guard could run. Four fixtures, four red results, and
   * not one of them was testing the thing it was named for — the same
   * wrong-reason class, in the block written to close a different gap.
   *
   * It also listed four of SEVEN surfaces the harness actually calls. The three
   * omitted ones included `seedRejectedApplication`, which is itself a
   * production-dangerous seeding mutation — precisely the kind this block
   * exists to fence.
   *
   * So the shapes are now declared explicitly, queries are called as queries,
   * and the omission is made structurally impossible by scanning the harness.
   */
  interface SeedSurface {
    name: string;
    kind: "query" | "mutation";
    args: (ctx: {
      seed: Seed;
      vehicleId: Id<"vehicles">;
      quoteId: Id<"quotes">;
      depositId: Id<"deposits">;
    }) => Record<string, unknown>;
  }

  const SURFACES: SeedSurface[] = [
    { name: "deploymentIdentity", kind: "query", args: () => ({}) },
    {
      name: "seedCommitmentScenario",
      kind: "mutation",
      args: () => ({ label: "guard-probe", quotes: 2 }),
    },
    {
      name: "commitmentRootFor",
      kind: "query",
      args: ({ seed, vehicleId }) => ({ orgId: seed.orgId, vehicleId }),
    },
    {
      name: "rootForEvidence",
      kind: "query",
      args: ({ seed, depositId }) => ({ orgId: seed.orgId, kind: "deposit", id: depositId }),
    },
    {
      name: "liveClaimCount",
      kind: "query",
      args: ({ seed, vehicleId }) => ({ orgId: seed.orgId, vehicleId }),
    },
    {
      name: "seedRejectedApplication",
      kind: "mutation",
      args: ({ seed, quoteId }) => ({ orgId: seed.orgId, quoteId }),
    },
    {
      name: "currentHead",
      kind: "query",
      args: ({ seed, quoteId }) => ({ orgId: seed.orgId, quoteId }),
    },
  ];

  test.each(SURFACES.map((surface) => [surface.name, surface] as const))(
    "testSupport:%s refuses when the deployment is not provably disposable",
    async (_name, surface) => {
      const seed = await seedDealer(`guard-${surface.name}`);
      const vehicleId = await vehicle(seed, "LIN0000000000090");
      const quoteId = await quoteFor(seed, seed.customerA, vehicleId);
      const depositId = await seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 500,
      });

      const args = surface.args({ seed, vehicleId, quoteId, depositId });
      const call =
        surface.kind === "query"
          ? seed.asUser.query(notYetBuiltQuery.testSupport[surface.name], args)
          : seed.asUser.mutation(notYetBuilt.testSupport[surface.name], args);

      await expect(call).rejects.toThrow(
        /disposable|not permitted|refus|production|test support/i
      );
    }
  );

  test("every testSupport surface the harness calls is fenced here", async () => {
    // The forcing function. Without it, adding an eighth seeding surface to the
    // harness silently creates an unfenced public endpoint, and every fixture
    // above still passes. Same reasoning as the `saveQuote` caller registry:
    // a registry nobody is required to update is a comment.
    const { readFileSync } = await import("node:fs");
    const harness = readFileSync("scripts/vehicleCommitmentContention.mjs", "utf8");
    const used = [...harness.matchAll(/testSupport:([A-Za-z0-9_]+)/g)].map((m) => m[1]);

    expect([...new Set(used)].sort()).toEqual(SURFACES.map((s) => s.name).sort());
  });

  /**
   * ⚠️ KNOWN GAP, stated rather than left implied.
   *
   * These are refusal-only contracts. An implementation that throws
   * unconditionally — with no real disposable-deployment check at all —
   * satisfies every fixture above while making the contention harness, this
   * design's ONLY source of real-concurrency evidence, permanently unable to
   * run anywhere.
   *
   * The positive half cannot be written here: `convex-test` has no way to
   * present itself as a provably disposable deployment, so "succeeds when the
   * deployment IS disposable" is not expressible in this suite. That is a real
   * boundary, not an oversight — and the same PREREQUISITE-red situation this
   * file names elsewhere rather than papering over.
   *
   * The positive control is therefore an OPERATIONAL gate, and it is recorded
   * as one: `scripts/vehicleCommitmentContention.mjs` must be observed running
   * successfully against a real disposable deployment before this ships. No
   * fixture in this file can stand in for that.
   */
});
