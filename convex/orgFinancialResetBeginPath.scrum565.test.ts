/**
 * SCRUM-565 N9 — the dormant "begin a reset" path keeps the SCRUM-563 properties.
 *
 * INVARIANT: if `FRESH_RESET_STARTS_BLOCKED` is ever flipped to false, the first
 * destructive call on a clean org still bumps `financialResetGeneration` in the
 * SAME transaction as its first deletions, a refused call bumps and deletes
 * nothing, and a dry run writes nothing.
 *
 * D-19 made that path unreachable, so every other test now reaches the reset
 * through a seeded continuation. This file is the only thing that executes the
 * bump in `resetOrgFinancialData`, so a regression in it would otherwise be
 * invisible until someone flips the switch.
 *
 * The switch is read inside `isFreshResetStartRefused` (a module-local binding),
 * so overriding the exported constant alone does not reach it. The mock below
 * therefore replaces both, driven by one flag; the CONTROL test turns the flag
 * on and proves the mock really is what the reset module calls.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import { expect, test, describe, vi, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const flags = vi.hoisted(() => ({ blocked: false }));

vi.mock("./utils/orgResetGeneration", async (importOriginal) => {
  const original = await importOriginal<typeof import("./utils/orgResetGeneration")>();
  return {
    ...original,
    FRESH_RESET_STARTS_BLOCKED: false as const,
    isFreshResetStartRefused: (
      org: Parameters<typeof original.isFreshResetStartRefused>[0],
      dryRun: boolean
    ) => flags.blocked && !dryRun && (org === null || !original.orgResetState(org).inProgress),
  };
});

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

beforeEach(() => {
  flags.blocked = false;
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

const PERMISSIONS = [
  "create:expenses", "edit:expenses", "delete:expenses", "view:expenses", "view:users", "manage:finance",
];

type Harness = ReturnType<typeof convexTestWithComponents>;
type Setup = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const { orgId, identity } = await seedOrgWithMember(t, {
    clerkId: "user_a",
    permissions: PERMISSIONS,
    orgName: "Begin Path Dealer",
  });
  return { t, orgId, asUser: identity };
}

function createExpense(s: Setup, idempotencyKey: string) {
  return s.asUser.mutation(api.expenses.create, {
    orgId: s.orgId,
    idempotencyKey,
    title: "Office Rent",
    amount: 5000,
    date: 1_756_000_000_000,
    category: "OTHER" as const,
    status: "PAID" as const,
  });
}

async function suspend(t: Harness, orgId: Id<"organizations">) {
  await t.run((ctx) => ctx.db.patch(orgId, { suspended: true, suspendedAt: Date.now() }));
}

function destructive(s: Setup, batchSize?: number) {
  return s.t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
    orgId: s.orgId,
    dryRun: false,
    ...(batchSize === undefined ? {} : { batchSize }),
  });
}

async function orgState(t: Harness, orgId: Id<"organizations">) {
  const org = await t.run((ctx) => ctx.db.get(orgId));
  return {
    generation: org?.financialResetGeneration,
    completed: org?.financialResetCompletedGeneration,
    suspended: org?.suspended,
  };
}

async function expenseCount(t: Harness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("expenses").collect()).filter((r) => String(r.orgId) === String(orgId)).length
  );
}

describe("SCRUM-565 N9 — begin path with fresh starts allowed (switch flipped off)", () => {
  test("CONTROL: with the switch on, the same call is refused and writes nothing (the mock reaches the reset module)", async () => {
    flags.blocked = true;
    const s = await setup();
    await createExpense(s, "A");
    await suspend(s.t, s.orgId);

    await expect(destructive(s)).rejects.toThrow(/Fresh financial resets are disabled/);
    expect(await orgState(s.t, s.orgId)).toEqual({ generation: undefined, completed: undefined, suspended: true });
    expect(await expenseCount(s.t, s.orgId)).toBe(1);
  });

  test("(a) the first destructive call bumps the generation in the same transaction as its first deletions", async () => {
    const s = await setup();
    for (const key of ["A", "B", "C"]) await createExpense(s, key);
    await suspend(s.t, s.orgId);
    expect(await orgState(s.t, s.orgId)).toEqual({ generation: undefined, completed: undefined, suspended: true });

    const first = await destructive(s, 1);
    expect(first.remaining).toBeGreaterThan(0);
    // Generation moved AND rows were deleted by this one call; not completed while rows remain.
    expect(await orgState(s.t, s.orgId)).toMatchObject({ generation: 1 });
    expect((await orgState(s.t, s.orgId)).completed ?? 0).toBe(0);
    expect(await expenseCount(s.t, s.orgId)).toBeLessThan(3);

    // A continuation does not bump again; completion stamps only when nothing remains.
    for (let i = 0; i < 40; i += 1) {
      const r = await destructive(s, 1);
      expect(await orgState(s.t, s.orgId)).toMatchObject({ generation: 1 });
      if (r.remaining === 0) break;
      expect((await orgState(s.t, s.orgId)).completed ?? 0).toBe(0);
    }
    expect(await orgState(s.t, s.orgId)).toMatchObject({ generation: 1, completed: 1 });
    expect(await expenseCount(s.t, s.orgId)).toBe(0);
  });

  test("(b) a refused destructive call (org not suspended) leaves both generation fields unset and deletes nothing", async () => {
    const s = await setup();
    await createExpense(s, "A");

    await expect(destructive(s)).rejects.toThrow(/Suspend this organization/);
    expect(await orgState(s.t, s.orgId)).toEqual({ generation: undefined, completed: undefined, suspended: undefined });
    expect(await expenseCount(s.t, s.orgId)).toBe(1);
  });

  test("(c) a dry run writes nothing", async () => {
    const s = await setup();
    await createExpense(s, "A");
    await createExpense(s, "B");
    await suspend(s.t, s.orgId);

    await s.t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: s.orgId, dryRun: true });
    expect(await orgState(s.t, s.orgId)).toEqual({ generation: undefined, completed: undefined, suspended: true });
    expect(await expenseCount(s.t, s.orgId)).toBe(2);
  });
});
