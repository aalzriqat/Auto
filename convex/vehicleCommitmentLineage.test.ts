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
 *     that deal's root;
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

    // SKIPPED, and the skip is the specification — same discipline as the aged
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
    test.skip("a reservation supplying the SAME root as the live deposit is admitted", async () => {
      const seed = await seedDealer("bridge-proven");
      const v = await vehicle(seed, "LIN0000000000016");
      const root = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: root, amount: 1_200 });

      // await expect(
      //   seed.asUser.mutation(api.vehicles.createReservation, {
      //     orgId: seed.orgId,
      //     vehicleId: v,
      //     customerId: seed.customerA,
      //     quoteId: root,
      //   })
      // ).resolves.toBeDefined();
      expect(root).toBeDefined();
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

    // SKIPPED — the specification. No linkage field exists on `quotes` (no
    // `supersedesQuoteId`, no revision pointer anywhere in the schema), so a
    // LINKED re-quote is not expressible today and this cannot be written as a
    // running assertion without inventing the field in the test.
    //
    // REQUIRED CONTRACT (c14659): a re-quote the server can tie to the same
    // deal RESOLVES TO THE SAME ROOT, so the deal continues — the second
    // quote's deposit, application and completion are all admitted.
    test.skip("a LINKED re-quote resolves to the same root and the deal continues", async () => {
      const seed = await seedDealer("requote-linked");
      const v = await vehicle(seed, "LIN0000000000017");
      const first = await quoteFor(seed, seed.customerA, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: first, amount: 1_000 });

      // const revised = await seed.asUser.mutation(api.quotes.saveQuote, {
      //   ...same customer/vehicle, renegotiated price...,
      //   supersedesQuoteId: first,
      // });
      // await expect(
      //   seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: revised, amount: 500 })
      // ).resolves.toBeDefined();
      expect(first).toBeDefined();
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
      const seed = await seedDealer("legacy-conflict");
      const v = await vehicle(seed, "LIN0000000000019");

      const rootA = await quoteFor(seed, seed.customerA, v);
      const rootB = await quoteFor(seed, seed.customerB, v);
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootA, amount: 1_000 });
      await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rootB, amount: 2_000 });

      const live = await seed.t.run(async (ctx) => {
        const rows = await ctx.db
          .query("deposits")
          .filter((q) => q.eq(q.field("vehicleId"), v))
          .collect();
        return rows.filter((row) => row.holdActive === true);
      });

      // Two live holders, two different quotes, two different customers, one
      // physical car. This is the input the cutover must refuse.
      expect(live).toHaveLength(2);
      expect(new Set(live.map((row) => String(row.quoteId)))).toHaveProperty("size", 2);
      expect(new Set(live.map((row) => String(row.customerId)))).toHaveProperty("size", 2);
    });
  });
});
