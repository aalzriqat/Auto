/**
 * SCRUM-57 — the invariant proved through a REAL economic command, not just
 * through the framework helper.
 *
 * `convex/idempotencyFramework.test.ts` proves the rule in isolation. This file
 * proves the thing the ticket actually cares about: that retrying ONE user
 * intent against a live financial mutation produces ONE economic event and ONE
 * GL effect, and that reusing an identity with materially changed money
 * instructions is refused.
 *
 * `expenses.create` is the consumer under test because it is small enough to
 * assert exactly and it produces BOTH a subledger row (`expenses`) and a cash
 * row (`transactions`) — so "exactly one economic effect" is checkable on two
 * independent surfaces rather than inferred from one.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:expenses",
  "edit:expenses",
  "delete:expenses",
  "view:expenses",
  "view:vehicles",
  "view:users",
];

async function setup(suffix: string) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Idem Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `user_${suffix}`,
      email: `${suffix}@test.com`,
      name: "Idem User",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: `user_${suffix}` });
  return { t, orgId, asUser };
}

function payload(orgId: any, idempotencyKey: string, overrides: Record<string, unknown> = {}) {
  return {
    orgId,
    idempotencyKey,
    title: "Office Rent",
    amount: 5000,
    date: 1_756_000_000_000,
    category: "OTHER" as const,
    status: "PAID" as const,
    ...overrides,
  };
}

/** Every surface the command touches, counted. */
async function economicFootprint(t: any, orgId: any) {
  return await t.run(async (ctx: any) => {
    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
      .collect();
    const transactions = await ctx.db
      .query("transactions")
      .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
      .collect();
    // Bounded on purpose: these fixtures create at most a handful, and a
    // number larger than the take() would show up as an equality failure below
    // rather than being silently truncated into looking correct.
    const commands = await ctx.db.query("commandIdempotency").take(50);
    return {
      expenses: expenses.length,
      transactions: transactions.length,
      commands: commands.length,
    };
  });
}

describe("SCRUM-57 — one intent, one economic effect", () => {
  test("a sequential retry of the SAME intent creates exactly one economic event", async () => {
    const { t, orgId, asUser } = await setup("seq");
    const key = "intent-office-rent";

    const first = await asUser.mutation(api.expenses.create, payload(orgId, key));
    // The retry a client makes after a lost response: same intent, same key.
    const second = await asUser.mutation(api.expenses.create, payload(orgId, key));

    expect(second).toEqual(first);
    const fp = await economicFootprint(t, orgId);
    expect(fp.expenses).toBe(1);
    expect(fp.transactions).toBe(1);
    expect(fp.commands).toBe(1);
  });

  test("a rapid double submission creates exactly one economic event", async () => {
    const { t, orgId, asUser } = await setup("dbl");
    const key = "intent-double-click";

    // Both in flight before either resolves — the double-click case.
    const results = await Promise.allSettled([
      asUser.mutation(api.expenses.create, payload(orgId, key)),
      asUser.mutation(api.expenses.create, payload(orgId, key)),
    ]);

    // At least one must succeed; whatever happens, the BOOKS must show one event.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    const fp = await economicFootprint(t, orgId);
    expect(fp.expenses).toBe(1);
    expect(fp.transactions).toBe(1);
  });

  test("a concurrent retry of the same intent still creates exactly one economic event", async () => {
    const { t, orgId, asUser } = await setup("conc");
    const key = "intent-concurrent";

    await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        asUser.mutation(api.expenses.create, payload(orgId, key))
      )
    );

    const fp = await economicFootprint(t, orgId);
    expect(fp.expenses).toBe(1);
    expect(fp.transactions).toBe(1);
  });

  test("a genuinely NEW intent creates a SECOND economic event", async () => {
    const { t, orgId, asUser } = await setup("new");

    await asUser.mutation(api.expenses.create, payload(orgId, "intent-1"));
    await asUser.mutation(api.expenses.create, payload(orgId, "intent-2"));

    const fp = await economicFootprint(t, orgId);
    // Two real expenses, not one — the guard must not swallow distinct intents.
    expect(fp.expenses).toBe(2);
    expect(fp.transactions).toBe(2);
  });
});

describe("SCRUM-57 — reused identity with changed money instructions fails closed", () => {
  test("same key + changed AMOUNT is refused and posts nothing extra", async () => {
    const { t, orgId, asUser } = await setup("amt");
    const key = "intent-amount";

    await asUser.mutation(api.expenses.create, payload(orgId, key, { amount: 5000 }));
    await expect(
      asUser.mutation(api.expenses.create, payload(orgId, key, { amount: 9900 }))
    ).rejects.toThrow(/different request content/i);

    const fp = await economicFootprint(t, orgId);
    expect(fp.expenses).toBe(1);
    expect(fp.transactions).toBe(1);
    await t.run(async (ctx: any) => {
      const only = await ctx.db
        .query("expenses")
        .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
        .unique();
      // The ORIGINAL amount survived; the changed instruction was not applied.
      expect(only.amount).toBe(5000);
    });
  });

  test("same key + changed SOURCE (payment method) is refused", async () => {
    const { orgId, asUser } = await setup("src");
    const key = "intent-source";
    await asUser.mutation(
      api.expenses.create,
      payload(orgId, key, { paymentMethod: "CASH" })
    );
    await expect(
      asUser.mutation(
        api.expenses.create,
        payload(orgId, key, { paymentMethod: "BANK_TRANSFER" })
      )
    ).rejects.toThrow(/different request content/i);
  });

  test("same key + changed EFFECTIVE DATE is refused", async () => {
    const { orgId, asUser } = await setup("date");
    const key = "intent-date";
    await asUser.mutation(api.expenses.create, payload(orgId, key, { date: 1_756_000_000_000 }));
    await expect(
      asUser.mutation(api.expenses.create, payload(orgId, key, { date: 1_750_000_000_000 }))
    ).rejects.toThrow(/different request content/i);
  });

  test("same key + changed COUNTERPARTY (vendor) is refused", async () => {
    const { orgId, asUser } = await setup("vendor");
    const key = "intent-vendor";
    await asUser.mutation(api.expenses.create, payload(orgId, key, { vendor: "Acme" }));
    await expect(
      asUser.mutation(api.expenses.create, payload(orgId, key, { vendor: "Other Supplier" }))
    ).rejects.toThrow(/different request content/i);
  });
});

describe("SCRUM-57 — the identity is not optional at the trust boundary", () => {
  test("an economic command submitted with NO identity is refused before it runs", async () => {
    const { t, orgId, asUser } = await setup("noid");

    const { idempotencyKey: _omitted, ...withoutIdentity } = payload(orgId, "unused");
    await expect(
      // Deliberately untyped: this is the shape an untyped or future client
      // sends, and the server — not the TypeScript signature — has to refuse it.
      asUser.mutation(api.expenses.create, withoutIdentity as any)
    ).rejects.toThrow();

    const fp = await economicFootprint(t, orgId);
    expect(fp.expenses).toBe(0);
    expect(fp.transactions).toBe(0);
  });

  test("an economic command submitted with a BLANK identity is refused", async () => {
    const { t, orgId, asUser } = await setup("blank");
    await expect(
      asUser.mutation(api.expenses.create, payload(orgId, "   "))
    ).rejects.toThrow();
    const fp = await economicFootprint(t, orgId);
    expect(fp.expenses).toBe(0);
  });

  test("a NON-economic command (sales.createDraft) is NOT constrained", async () => {
    // The classification boundary. A draft "commits nothing and reserves
    // nothing" (`convex/utils/saleCompletion.ts`), so forcing an identity onto
    // it would be the over-application the ticket explicitly warns against.
    const sales = await import("./sales");
    const optional = argIsOptional(sales, "createDraft");
    expect(optional).toBe(true);
  });
});

/**
 * Reads the REAL exported argument validator and reports whether
 * `idempotencyKey` is optional. Anything it cannot establish — module missing,
 * export missing, no `exportArgs`, no such field — throws rather than
 * returning a value, so an enumeration that has gone blind can never be
 * mistaken for a satisfied assertion.
 */
function argIsOptional(mod: Record<string, unknown>, exportName: string): boolean {
  const fn = mod[exportName] as { exportArgs?: () => string } | undefined;
  if (!fn) throw new Error(`No export named ${exportName} — classification cannot be checked.`);
  if (typeof fn.exportArgs !== "function") {
    throw new Error(`${exportName} exposes no exportArgs() — classification cannot be checked.`);
  }
  const field = JSON.parse(fn.exportArgs()).value?.idempotencyKey;
  if (!field) throw new Error(`${exportName} declares no idempotencyKey argument at all.`);
  if (typeof field.optional !== "boolean") {
    throw new Error(`${exportName}.idempotencyKey has no optionality flag to read.`);
  }
  return field.optional;
}

/**
 * ─── The classification ratchet ─────────────────────────────────────────────
 *
 * Every command classified ECONOMIC must expose a REQUIRED identity at the
 * trust boundary. This is the guard that catches the next one: adding a new
 * financial mutation with `v.optional(v.string())`, or quietly relaxing an
 * existing one, fails here rather than in production.
 *
 * The manifest is written out by hand deliberately. A test that discovered the
 * list by scanning for `runWithIdempotency` would pass vacuously the day
 * somebody writes an economic mutation that never calls it.
 */
const ECONOMIC_COMMANDS: Record<string, string[]> = {
  "./applications": [
    "cancelApplication",
    "finalizeDeal",
    "confirmDisbursement",
    "confirmSupplierDisbursement",
    "amendSupplierDisbursementAdvice",
  ],
  "./collections": [
    "recordPayment",
    "clearCheque",
    "returnClearedCheque",
    "respondToApproval",
    "submitCashierReconciliation",
  ],
  "./deposits": ["create", "release"],
  "./expenses": ["create"],
  "./financeDealCosts": ["recordDealFee", "openDealCustody", "recordCustodyMovement"],
  "./paymentIntents": ["create", "markSettled"],
  "./payroll": ["recordAdvance", "recoverAdvance"],
  "./prepaidExpenses": ["correctSchedule"],
  "./sales": ["create", "completeFromQuote", "completeDraft", "markCommissionPaid"],
  "./sourcingPayables": ["markPaid", "recordPartialPayment"],
  "./supplierReceivables": ["recordReceipt"],
  "./transactions": ["add"],
};

describe("SCRUM-57 — classification ratchet", () => {
  test("every classified economic command requires a command identity", async () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const [modulePath, exportNames] of Object.entries(ECONOMIC_COMMANDS)) {
      const mod = (await import(modulePath)) as Record<string, unknown>;
      for (const exportName of exportNames) {
        // Throws if it cannot be established — never silently skipped.
        if (argIsOptional(mod, exportName)) {
          offenders.push(`${modulePath}#${exportName}`);
        }
        checked += 1;
      }
    }

    expect(offenders).toEqual([]);
    // The enumeration itself is asserted, so a manifest that silently shrank
    // (or a loop that stopped early) fails instead of passing on zero work.
    expect(checked).toBe(
      Object.values(ECONOMIC_COMMANDS).reduce((n, list) => n + list.length, 0)
    );
    expect(checked).toBe(29);
  });
});
