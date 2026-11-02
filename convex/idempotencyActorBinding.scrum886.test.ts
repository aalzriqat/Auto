/**
 * SCRUM-886 round 9 (Seat 2 at a38cdb86; OWASP API3:2023, property-level authorization). `vehicles.create`
 * needs only `create:vehicles`, then compares the caller's cost-bearing fingerprint with the one stored under
 * the idempotency key. A caller without `view:cost_price` who replays an owner's key got the original
 * vehicle id for the stored price and "Idempotency key reused with different request content" for any other:
 * an equality oracle on a COST-tier field, reached through the outcome of a mutation, not a read.
 *
 * Rounds 5 to 8 each closed one door of this class. The class is "a command identity is replayable by a
 * principal that did not mint it, and the fingerprint comparison then answers for the stored values". It is
 * closed in `runWithIdempotency` itself: a stored command is compared and replayed only for the actor that
 * minted it, so every caller (65 call sites) gets the rule and none can reintroduce the oracle.
 *
 * Every test goes through the public functions. Expected values are literals from the seeded rows.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { runWithIdempotency } from "./utils/idempotency";
import { SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";

const FOREIGN_ACTOR_CODE = "COMMAND_IDENTITY_FOREIGN_ACTOR";
const CONFLICT_MESSAGE = /Idempotency key reused with different request content/;
const STORED_COST = 8_000;
const VIN = "ACTR886VEH0000001";

const CREATOR = ["view:vehicles", "create:vehicles"];
const COST_CREATOR = ["view:vehicles", "create:vehicles", "view:cost_price"];
const CLERK = ["create:expenses", "view:expenses"];

type Who = "owner" | "creator" | "costCreator" | "clerkA" | "clerkB";

async function seed() {
  vi.useFakeTimers();
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Actor Binding", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const specs: Record<Who, string[] | "owner"> = {
    owner: "owner", creator: CREATOR, costCreator: COST_CREATOR, clerkA: CLERK, clerkB: CLERK,
  };
  const actors = {} as Record<Who, ReturnType<typeof t.withIdentity>>;
  const userIds = {} as Record<Who, Id<"users">>;
  for (const who of Object.keys(specs) as Who[]) {
    const clerkId = `scrum886a_${who}`;
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: who }));
    const spec = specs[who];
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", spec === "owner"
        ? { orgId, name: SYSTEM_OWNER_ROLE_NAME, permissions: [], isSystemOwnerRole: true }
        : { orgId, name: `Role ${who}`, permissions: spec })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    actors[who] = t.withIdentity({ subject: clerkId, clerkId });
    userIds[who] = userId;
  }
  await actors.owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await actors.owner.mutation(api.accountingPeriods.create, {
    orgId, fiscalYear: year, periodNumber: 1, startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), openImmediately: true,
  });
  return { t, orgId, actors, userIds };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

afterEach(() => vi.useRealTimers());

const createArgs = (s: Seeded, key: string, purchasePrice: number) => ({
  orgId: s.orgId, vin: VIN, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White",
  fuelType: "Gas", transmission: "Auto", sellingPrice: 25_000, status: "AVAILABLE" as const, sourceType: "STOCK" as const,
  purchasePrice, purchasePaymentMethod: "CASH" as const, idempotencyKey: key,
});
const createVehicle = (s: Seeded, who: Who, key: string, purchasePrice: number) =>
  s.actors[who].mutation(api.vehicles.create, createArgs(s, key, purchasePrice));

const counts = (s: Seeded) =>
  s.t.run(async (ctx) => ({
    vehicles: (await ctx.db.query("vehicles").collect()).map((row) => [row.vin, row.purchasePrice ?? null]),
    commands: (await ctx.db.query("commandIdempotency").collect()).length,
    journals: (await ctx.db.query("journalEntries").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
  }));

describe("SCRUM-886 round 9: vehicles.create gives a caller without cost access no equality oracle", () => {
  test("a create-only caller replaying the owner's key is refused for the stored price and for a different one, identically", async () => {
    const s = await seed();
    await createVehicle(s, "owner", "act-886-a", STORED_COST);
    const equal = await refusalDataOf(createVehicle(s, "creator", "act-886-a", STORED_COST));
    const different = await refusalDataOf(createVehicle(s, "creator", "act-886-a", STORED_COST + 1));
    expect(equal).not.toBeNull();
    expect(different).not.toBeNull();
    expect(equal).toEqual(different);
    expect(equal?.code).toBe(FOREIGN_ACTOR_CODE);
    expect(different?.code).toBe(FOREIGN_ACTOR_CODE);
    expect(equal?.message).not.toMatch(CONFLICT_MESSAGE);
  });

  test("the refusal comes before any write: vehicles, commands, journals and events are untouched", async () => {
    const s = await seed();
    await createVehicle(s, "owner", "act-886-b", STORED_COST);
    const before = await counts(s);
    expect(before.vehicles).toEqual([[VIN, STORED_COST]]);
    expect(before.commands).toBe(1);
    await refusalDataOf(createVehicle(s, "creator", "act-886-b", STORED_COST));
    await refusalDataOf(createVehicle(s, "creator", "act-886-b", STORED_COST + 1));
    expect(await counts(s)).toEqual(before);
  });

  test("control: the same actor retrying its own key gets the proven replay and a conflict on a changed fingerprint", async () => {
    const s = await seed();
    const first = await createVehicle(s, "owner", "act-886-c", STORED_COST);
    const before = await counts(s);
    expect(await createVehicle(s, "owner", "act-886-c", STORED_COST)).toBe(first);
    expect(await counts(s)).toEqual(before);
    const changed = await refusalDataOf(createVehicle(s, "owner", "act-886-c", STORED_COST + 1));
    expect(changed?.message).toMatch(CONFLICT_MESSAGE);
    expect(await counts(s)).toEqual(before);
  });

  test("control: a create-only caller keeps the proven replay and the conflict on its OWN key", async () => {
    const s = await seed();
    const first = await createVehicle(s, "creator", "act-886-own", STORED_COST);
    const before = await counts(s);
    expect(await createVehicle(s, "creator", "act-886-own", STORED_COST)).toBe(first);
    expect((await refusalDataOf(createVehicle(s, "creator", "act-886-own", STORED_COST + 1)))?.message).toMatch(CONFLICT_MESSAGE);
    expect(await counts(s)).toEqual(before);
  });

  test("control: a holder of view:cost_price keeps the proven replay and the conflict on its own key", async () => {
    const s = await seed();
    const first = await createVehicle(s, "costCreator", "act-886-d", STORED_COST);
    expect(await createVehicle(s, "costCreator", "act-886-d", STORED_COST)).toBe(first);
    expect((await refusalDataOf(createVehicle(s, "costCreator", "act-886-d", STORED_COST + 1)))?.message).toMatch(CONFLICT_MESSAGE);
    expect((await counts(s)).vehicles).toEqual([[VIN, STORED_COST]]);
  });

  test("a holder of view:cost_price replaying ANOTHER user's key is refused too: the rule is the actor, not the role", async () => {
    const s = await seed();
    await createVehicle(s, "owner", "act-886-e", STORED_COST);
    const equal = await refusalDataOf(createVehicle(s, "costCreator", "act-886-e", STORED_COST));
    const different = await refusalDataOf(createVehicle(s, "costCreator", "act-886-e", STORED_COST + 1));
    expect(equal?.code).toBe(FOREIGN_ACTOR_CODE);
    expect(different).toEqual(equal);
  });

  test("a fresh key still creates: the refusal is about the identity, not the caller", async () => {
    const s = await seed();
    await createVehicle(s, "owner", "act-886-f", STORED_COST);
    await expect(
      s.actors.creator.mutation(api.vehicles.create, { ...createArgs(s, "act-886-fresh", 7_000), vin: "ACTR886VEH0000002" })
    ).resolves.toBeTruthy();
  });
});

const expenseArgs = (s: Seeded, key: string, amount: number) => ({
  orgId: s.orgId, title: "Office supplies", amount, date: Date.now(), category: "OFFICE" as const,
  status: "PAID" as const, idempotencyKey: key,
});

describe("SCRUM-886 round 9: the rule lives in runWithIdempotency, so every economic operation gets it", () => {
  test("expenses.create: a different actor replaying a key is refused before the comparison, for the same and a changed amount", async () => {
    const s = await seed();
    const first = await s.actors.clerkA.mutation(api.expenses.create, expenseArgs(s, "act-886-x", 120));
    const before = await counts(s);
    const equal = await refusalDataOf(s.actors.clerkB.mutation(api.expenses.create, expenseArgs(s, "act-886-x", 120)));
    const different = await refusalDataOf(s.actors.clerkB.mutation(api.expenses.create, expenseArgs(s, "act-886-x", 121)));
    expect(equal?.code).toBe(FOREIGN_ACTOR_CODE);
    expect(different).toEqual(equal);
    expect(await counts(s)).toEqual(before);
    // control: the minting actor keeps replay and conflict
    expect(await s.actors.clerkA.mutation(api.expenses.create, expenseArgs(s, "act-886-x", 120))).toBe(first);
    expect((await refusalDataOf(s.actors.clerkA.mutation(api.expenses.create, expenseArgs(s, "act-886-x", 121))))?.message)
      .toMatch(CONFLICT_MESSAGE);
  });

  test("a stored command with no recorded actor is not replayable by a user: unknown ownership fails closed", async () => {
    const s = await seed();
    await s.actors.clerkA.mutation(api.expenses.create, expenseArgs(s, "act-886-legacy", 120));
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("commandIdempotency").collect()).find((r) => r.idempotencyKey === "act-886-legacy");
      await ctx.db.patch(row!._id, { createdBy: undefined });
    });
    const replay = await refusalDataOf(s.actors.clerkA.mutation(api.expenses.create, expenseArgs(s, "act-886-legacy", 120)));
    expect(replay?.code).toBe(FOREIGN_ACTOR_CODE);
  });

  test("a caller with no actor (an internal or scheduled command) retrying its own command still replays", async () => {
    const s = await seed();
    const run = (fingerprint: string, work: () => Promise<string>) =>
      s.t.run((ctx) =>
        runWithIdempotency(ctx, {
          orgId: s.orgId, operation: "test.internal", economic: true, idempotencyKey: "act-886-sys", fingerprint,
        }, work)
      );
    let ran = 0;
    const work = async () => { ran += 1; return "done"; };
    expect(await run("fp-1", work)).toBe("done");
    expect(await run("fp-1", work)).toBe("done");
    expect(ran).toBe(1);
    await expect(run("fp-2", work)).rejects.toThrow(CONFLICT_MESSAGE);
  });

  test("a non-economic command is bound to the actor that minted it too", async () => {
    const s = await seed();
    const run = (actorId: Id<"users">, fingerprint: string) =>
      s.t.run((ctx) =>
        runWithIdempotency(ctx, {
          orgId: s.orgId, operation: "test.harmless", economic: false, idempotencyKey: "act-886-soft", fingerprint, actorId,
        }, async () => "stored")
      );
    expect(await run(s.userIds.clerkA, "fp-1")).toBe("stored");
    expect(await run(s.userIds.clerkA, "fp-1")).toBe("stored");
    const equal = await refusalDataOf(run(s.userIds.clerkB, "fp-1"));
    const different = await refusalDataOf(run(s.userIds.clerkB, "fp-2"));
    expect(equal?.code).toBe(FOREIGN_ACTOR_CODE);
    expect(different).toEqual(equal);
  });

  test("a user cannot replay or probe a command minted with no actor", async () => {
    const s = await seed();
    await s.t.run((ctx) =>
      runWithIdempotency(ctx, {
        orgId: s.orgId, operation: "test.internal", economic: true, idempotencyKey: "act-886-sys2", fingerprint: "fp-1",
      }, async () => "done")
    );
    let ran = 0;
    const asUser = (fingerprint: string) =>
      refusalDataOf(
        s.t.run((ctx) =>
          runWithIdempotency(ctx, {
            orgId: s.orgId, operation: "test.internal", economic: true, idempotencyKey: "act-886-sys2", fingerprint,
            actorId: s.userIds.clerkA,
          }, async () => { ran += 1; return "x"; })
        )
      );
    const equal = await asUser("fp-1");
    const different = await asUser("fp-2");
    expect(equal).not.toBeNull();
    expect(equal?.code).toBe(FOREIGN_ACTOR_CODE);
    expect(different).toEqual(equal);
    expect(ran).toBe(0);
  });

  test("a caller with no actor cannot replay or probe a command a user minted", async () => {
    const s = await seed();
    await s.t.run((ctx) =>
      runWithIdempotency(ctx, {
        orgId: s.orgId, operation: "test.user-minted", economic: true, idempotencyKey: "act-886-usr", fingerprint: "fp-1",
        actorId: s.userIds.clerkA,
      }, async () => "done")
    );
    let ran = 0;
    const asSystem = (fingerprint: string) =>
      refusalDataOf(
        s.t.run((ctx) =>
          runWithIdempotency(ctx, {
            orgId: s.orgId, operation: "test.user-minted", economic: true, idempotencyKey: "act-886-usr", fingerprint,
          }, async () => { ran += 1; return "x"; })
        )
      );
    const equal = await asSystem("fp-1");
    const different = await asSystem("fp-2");
    expect(equal?.code).toBe(FOREIGN_ACTOR_CODE);
    expect(different).toEqual(equal);
    expect(ran).toBe(0);
  });
});
