import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ORGANIZATION_DELETION_STEPS } from "./adminOrgs";

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
 *   - a quote with no hard participant is informational: no commitment;
 *   - the first deposit or Finance Application on a quote establishes or joins
 *     `QUOTE:<quoteId>`;
 *   - further deposits on that SAME quote are more evidence for the same root;
 *   - a Finance Application from that same quote joins that same root and must
 *     not conflict with its own deposit rows;
 *   - a standalone manual reservation may establish a reservation root;
 *   - a reservation layered over an existing deal may JOIN it only when the
 *     server can explicitly or unambiguously prove that exact same root.
 *     **Ambiguity fails closed. There is no broad same-customer exemption.**
 *   - a different quote is a COMPETING owner **even for the same customer**.
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

/** A quote is the ROOT. Cash or financed changes who joins it, not its identity. */
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

describe("SCRUM-195 c14554: the commitment owner is a DEAL ROOT, not a row or a customer", () => {
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

      await expect(
        seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootB, amount: 2_000 })
      ).rejects.toThrow();

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

  describe("7. reallocation and reactivation are ACQUISITIONS, never blind resurrection", () => {
    test("reallocating a deposit onto a vehicle another root holds is refused", async () => {
      // `deposits.allocateToVehicles` activates a hold, so it is an acquisition
      // and must go through the same authority. A reallocation that simply
      // inserts an active hold row would be a second writer creating a
      // commitment nobody checked.
      const seed = await seedDealer("realloc");
      const held = await vehicle(seed, "LIN0000000000012");
      const spare = await vehicle(seed, "LIN0000000000013");

      const ownerRoot = await quoteFor(seed, seed.customerA, held);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ownerRoot, amount: 1_000 });

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
      // Establishes the mover root; the reallocation below is keyed on the
      // quote, so the id itself is not needed.
      await seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: moverRoot,
        amount: 3_000,
      });

      await expect(
        seed.asUser.mutation(api.deposits.allocateToVehicles, {
          orgId: seed.orgId,
          quoteId: moverRoot,
          allocations: [
            { vehicleId: spare, amount: 1_500 },
            { vehicleId: held, amount: 1_500 },
          ],
        })
      ).rejects.toThrow(/committed|another deal|already held/i);
    });
  });

  describe("8. rollout and org-purge sequencing", () => {
    test("the purge registry already orders every referent the claim row will join", async () => {
      // Sequencing evidence, made executable instead of left in review prose.
      //
      // A commitment-claim row will reference the vehicle, the application and
      // the deposit. Org purge deletes children before parents so a FAILED run
      // never strands rows pointing at deleted documents — the registry says so
      // in its own comments. This pins the orderings the claim row must slot
      // into, so that when it is added, putting it after any of these fails
      // here rather than in a half-purged organisation.
      const order = ORGANIZATION_DELETION_STEPS.map((step) =>
        step.kind === "orgRows" ? step.table : step.kind
      );
      const at = (name: (typeof order)[number]) => order.indexOf(name);

      // Measured, not assumed. My first version of this test asserted that
      // `financeApplications` is purged before `vehiclesWithStorage` and it is
      // not — vehicles go at 19 and applications at 41, so an application
      // outlives its own vehicle during a purge. Worth stating plainly because
      // it inverts the intuition, and because a sequencing requirement built on
      // the guessed order would have been wrong in the one direction that
      // matters.
      const referents = [
        "vehicleReservations",
        "vehiclesWithStorage",
        "financeApplications",
        "deposits",
      ] as const;
      for (const referent of referents) {
        expect(at(referent)).toBeGreaterThanOrEqual(0);
      }

      // These two orderings ARE real and the claim row inherits their logic.
      expect(at("vehicleReservations")).toBeLessThan(at("vehiclesWithStorage"));
      expect(at("depositApplications")).toBeLessThan(at("deposits"));

      // THE REQUIREMENT, expressed against the real order rather than a guess:
      // a commitment-claim row references the vehicle, the application, the
      // deposit and possibly the reservation, so it must be purged before the
      // EARLIEST of them. Anything later strands a claim pointing at a document
      // that is already gone if a run FAILs between steps — which is the exact
      // hazard every child-first comment in this registry exists to prevent.
      const earliestReferent = Math.min(...referents.map((name) => at(name)));
      expect(earliestReferent).toBe(at("vehicleReservations"));

      // When the claim step is added, this becomes:
      //   expect(at("vehicleCommitmentClaims")).toBeLessThan(earliestReferent);
      // It is written out rather than asserted because the table does not exist
      // yet, and a test that silently passes on an absent step would be worse
      // than no test — `indexOf` returns -1, which is less than everything.
      expect(order).not.toContain("vehicleCommitmentClaims");
    });
  });
});
