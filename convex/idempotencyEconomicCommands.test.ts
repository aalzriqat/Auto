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

  /**
   * The property that stops the mandatory identity becoming a workflow
   * dead-end, and the reason `ExpenseDialog` can safely hold ONE identity for a
   * whole dialog session.
   *
   * A rejected command must leave NO stored row. Convex rolls the whole mutation
   * back on a throw, taking the STARTED row with it — so the operator who is
   * told "VAT amount cannot exceed the expense amount", corrects the figure and
   * submits again is running a genuinely new command against a clean slate,
   * not colliding with the identity their failed attempt used.
   *
   * Without this, every server-side validation refusal would strand the form:
   * same key, changed amount, IDEMPOTENCY_CONFLICT, and no way forward except
   * closing the dialog.
   */
  test("a REFUSED command stores nothing, so a corrected resubmit on the same identity succeeds", async () => {
    const { t, orgId, asUser } = await setup("retryafterfail");
    const key = "intent-corrected-after-refusal";

    // Refused inside the command body: VAT cannot exceed the amount.
    await expect(
      asUser.mutation(
        api.expenses.create,
        payload(orgId, key, { amount: 100, taxAmount: 500 })
      )
    ).rejects.toThrow();

    // No evidence of the refused attempt may survive its own transaction.
    const afterFailure = await economicFootprint(t, orgId);
    expect(afterFailure.commands).toBe(0);
    expect(afterFailure.expenses).toBe(0);

    // The corrected resubmit reuses the SAME identity and must go through.
    const created = await asUser.mutation(
      api.expenses.create,
      payload(orgId, key, { amount: 100, taxAmount: 5 })
    );
    expect(created).toBeDefined();

    const afterFix = await economicFootprint(t, orgId);
    expect(afterFix.expenses).toBe(1);
    expect(afterFix.commands).toBe(1);
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
 * ─── The fingerprint-completeness ratchet ───────────────────────────────────
 *
 * A fingerprint that is too NARROW is the dangerous direction: two materially
 * different commands hash the same, so a reused identity silently replays the
 * first and the second economic instruction is discarded. Review found exactly
 * that on `sales.create` — `depositResolution`, which decides whether a held
 * deposit is refunded, forfeited or applied, was missing.
 *
 * This guard reads the REAL source and asserts that every argument the mutation
 * accepts is either hashed or explicitly exempted, so adding a field to the
 * validator and forgetting the fingerprint fails here instead of in production.
 * It throws rather than returns whenever it cannot parse what it is checking —
 * a guard that has gone blind must not be indistinguishable from a passing one.
 */
function fieldsBetween(source: string, startMarker: string, endMarker: string): string[] {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Cannot locate ${startMarker} — the guard cannot be evaluated.`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Cannot locate ${endMarker} after ${startMarker}.`);
  const names = [...source.slice(start, end).matchAll(/^\s{4,}([a-zA-Z][a-zA-Z0-9]*):/gm)].map(
    (m) => m[1]
  );
  if (names.length === 0) throw new Error(`Parsed zero fields between markers — guard is blind.`);
  return names;
}

describe("SCRUM-57 — fingerprint completeness ratchet (sales.create)", () => {
  test("every accepted argument is hashed, or explicitly exempted with a reason", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // Same convention as the other source-level guard in this repo
    // (convex/multiVehicleDepositAllocation.test.ts).
    const source = readFileSync(join(process.cwd(), "convex/sales.ts"), "utf8");

    const accepted = new Set(
      fieldsBetween(source, "export const create = mutation({", "  handler:")
    );
    const hashed = new Set(
      fieldsBetween(source, 'operation: "sales.create"', "        }),")
    );

    const EXEMPT = new Set([
      "orgId", // part of the lookup key, not the fingerprint
      "status", // the literal "COMPLETED" on this door
      "idempotencyKey", // the identity itself
      // Wrapper fields that live in the same object as the fingerprint.
      "operation",
      "economic",
      "actorId",
      "fingerprint",
      "args",
      "handler",
    ]);

    const unhashed = [...accepted].filter((f) => !hashed.has(f) && !EXEMPT.has(f));
    expect(unhashed).toEqual([]);
    // The enumeration itself is asserted: a parse that silently matched almost
    // nothing would otherwise look identical to full coverage.
    expect(accepted.size).toBeGreaterThan(20);
  });
});

/**
 * ─── Fields that must stay in specific fingerprints ─────────────────────────
 *
 * Each entry below is a field whose absence was a REAL defect found in review
 * and reproduced against the real code, not a guess. The framework tests above
 * already prove the behavioural half — a differing fingerprint fails closed —
 * so what these pin is the other half: that this particular field is part of
 * this particular command's fingerprint at all. Together the two halves say
 * "changing this field is refused", which is the property that matters.
 *
 * Extracted by brace-matching the `JSON.stringify({...})` argument rather than
 * by matching indented lines: a line-shaped regex silently mis-read single-line
 * and comment-interrupted fingerprints when this guard was first attempted, and
 * a guard that mis-parses is worse than no guard.
 */
function fingerprintBody(source: string, operation: string): string {
  const op = source.indexOf(`operation: "${operation}"`);
  if (op < 0) throw new Error(`No call site for operation ${operation}.`);
  const fp = source.indexOf("fingerprint:", op);
  if (fp < 0) throw new Error(`${operation} declares no fingerprint.`);
  const open = source.indexOf("(", source.indexOf("JSON.stringify", fp));
  if (open < 0) throw new Error(`${operation} fingerprint is not a JSON.stringify call.`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") {
      depth--;
      if (depth === 0) return source.slice(open, i);
    }
  }
  throw new Error(`Unbalanced fingerprint expression for ${operation}.`);
}

const REQUIRED_FINGERPRINT_FIELDS: Array<[string, string, string[]]> = [
  // Decides refund vs forfeit vs apply for a held deposit.
  ["convex/sales.ts", "sales.create", ["depositResolution", "apr", "termMonths"]],
  // Both forwarded to completeSalesForLineItems; the fingerprint was quoteId only.
  [
    "convex/sales.ts",
    "sales.completeFromQuote",
    ["supplierSettlementRoute", "depositResolution"],
  ],
  // Feeds settlementDeductedTotalMinor, so it changes the dealer remittance.
  [
    "convex/financeDealCosts.ts",
    "financeDealCosts.recordDealFee",
    ["deductedFromSettlement"],
  ],
  // Selects the credit account in hookEmployeeAdvancePaid.
  ["convex/payroll.ts", "payroll.recordAdvance", ["method"]],
];

describe("SCRUM-57 — fields whose omission was a reproduced defect stay hashed", () => {
  test.each(REQUIRED_FINGERPRINT_FIELDS)(
    "%s %s hashes its material fields",
    async (file, operation, fields) => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const body = fingerprintBody(
        readFileSync(join(process.cwd(), file), "utf8"),
        operation
      );
      for (const field of fields) {
        expect(body).toContain(field);
      }
    }
  );
});

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
 *
 * ─── THE DENOMINATOR, stated explicitly (SCRUM-313 RC integration) ──────────
 *
 * The combined RC has THIRTY-TWO `runWithIdempotency` call sites, and they split:
 *
 *   31  economic: true   — every one listed below, identity + fingerprint
 *                          REQUIRED at the trust boundary
 *    1  economic: false  — `sales.createDraft`, and only that one
 *   ──
 *   32  total classified call sites
 *
 * (It was 30 = 29 + 1 until an owner finding showed `collections.createReceivable`
 * and `collections.createInstallmentPlan` emit real accounting events through
 * `hookReceivableCreated`. Both are now identity-guarded and listed below.)
 *
 * So "30 sites" and "29 protected" describe the same tree with no gap between
 * them. `sales.createDraft` is not an unprotected economic command; it is a
 * classified NON-economic one. Verified on this topology rather than inherited
 * from the artifact's judgement: it reaches `createDraftSale`, which calls
 * `prepareSaleCompletion(ctx, args, "DRAFT")` — a helper that performs NO
 * database writes at all — and then `insertSaleRecord(..., "PENDING")`, whose
 * only write is `ctx.db.insert("sales")`. It never calls
 * `applySaleCompletionSideEffects`, which is where the receivable, the vehicle
 * status change and the queued accounting event live. A draft commits nothing,
 * reserves nothing and posts nothing; `sales.completeDraft` is the economic
 * event and IS classified economic below.
 *
 * The set equality is asserted both ways by the ratchet, so this comment cannot
 * drift from the source: nothing may be economic in the code and absent here,
 * and nothing may be listed here without being economic in the code.
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
    // ADDED during RC integration (SCRUM-313). SCRUM-218-C created this command
    // AFTER SCRUM-57's artifact was authored, so the artifact's manifest could
    // not have listed it. It relieves a receivable against a retained receipt
    // and posts to the GL — an at-most-once effect on money — so it is
    // classified ECONOMIC like every other command here. Without this entry the
    // ratchet would have passed while the one genuinely new money command in
    // the combined RC kept an optional identity.
    "applyRetainedCredit",
    // ADDED during RC integration (SCRUM-313) after an owner finding. These two
    // were first disclosed as "write only a receivable row, no GL" — WRONG, and
    // the error was reading `ctx.db.insert` calls instead of reading the helper.
    // Both call `hookReceivableCreated`, which emits a real RECEIVABLE_CREATED
    // event whose accounting key is `receivable_created_${receivableId}`. The id
    // is minted per call, so a retry mints a new id, a new key and a SECOND
    // journal that the downstream dedupe is structurally blind to.
    //
    // For the plan, the identity represents the WHOLE PLAN intent: a per-row
    // identity would let a retry mint installments 13..24 under the first plan's
    // name — a second plan wearing the first one's identity.
    "createReceivable",
    "createInstallmentPlan",
    "clearCheque",
    "returnClearedCheque",
    "respondToApproval",
    "submitCashierReconciliation",
  ],
  "./deposits": ["create", "release"],
  // ADDED by the SCRUM-313 CENSUS (owner ruling: scope A, mechanism C). These six
  // were outside the SCRUM-57 manifest because that manifest reasoned about
  // `runWithIdempotency` callers, which was only ever a SUBSET of the commands
  // that can move money. The census derives the population from the call graph
  // in both directions instead; see scripts/economicCommandCensus.test.ts, which
  // is now the release instrument and treats THIS manifest as a subset.
  "./fixedAssets": ["capitalize"],
  "./partnerEquity": ["add", "recordEquityMovement"],
  "./vehicles": ["create", "createReservation"],
  "./workOrders": ["create"],
  "./expenses": ["create"],
  "./financeDealCosts": ["recordDealFee", "openDealCustody", "recordCustodyMovement"],
  "./paymentIntents": ["create", "markSettled"],
  "./payroll": ["recordAdvance", "recoverAdvance"],
  "./prepaidExpenses": ["correctSchedule"],
  "./sales": ["create", "completeFromQuote", "completeDraft", "markCommissionPaid"],
  "./sourcingPayables": ["markPaid", "recordPartialPayment"],
  "./supplierReceivables": ["recordReceipt"],
  // ⚠️ `./transactions: ["add"]` was REMOVED during RC integration (SCRUM-313),
  // and the removal is NOT a relaxation — it is a retirement, guarded below.
  //
  // SCRUM-53 retired `transactions.add` / `update` / `remove` to unconditional
  // refusals. They take no economic arguments at all any more, so "does this
  // command expose a required identity" has no subject: there is no command
  // left to identify. Leaving the entry in place would have failed this ratchet
  // forever on a mutation that can no longer move money.
  //
  // Deleting a manifest line is exactly the silent shrink this ratchet exists
  // to prevent, so the obligation is not dropped — it is TRANSFERRED to
  // "the retired legacy ledger writers stay retired" below. If anyone ever
  // un-retires one of them, that test fails and the classification requirement
  // is re-armed, rather than the command quietly re-entering the codebase with
  // no identity and nothing watching.
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
    // RE-MEASURED on the combined RC (SCRUM-313), not adjusted arithmetically
    // from the artifact's 29: −1 for the retired `transactions.add`, +1 for
    // SCRUM-218-C's `collections.applyRetainedCredit`. The total returning to
    // 29 is a COINCIDENCE of two independent changes, which is precisely why
    // both are recorded above rather than netted into "unchanged".
    //
    // 31 -> 37 by the SCRUM-313 census: +6 commands the census found outside
    // this manifest (fixedAssets.capitalize, partnerEquity.add /
    // recordEquityMovement, vehicles.create / createReservation,
    // workOrders.create). RE-MEASURED against the combined tree, never carried
    // over because it happened to compile.
    expect(checked).toBe(37);
  });

  /**
   * The OTHER direction, and the one that makes the denominator above a fact
   * rather than a claim in a comment.
   *
   * The test above walks manifest → source: every listed command must require
   * an identity. That cannot detect the failure the owner asked about during
   * RC integration (SCRUM-313) — a command marked `economic: true` in the code
   * that nobody added to the manifest. It would simply never be looked at, and
   * the ratchet would stay green while an economic command went unprotected.
   *
   * So this walks source → manifest and asserts the two sets are EQUAL. It also
   * pins the non-economic side by name: a command may be `economic: false` only
   * if it is `sales.createDraft`. Flipping any economic command to `false` to
   * silence the ratchet fails here instead of passing quietly.
   */
  test("the manifest is exactly the set of economic commands in the source, both directions", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(process.cwd(), "convex");

    const economicInSource = new Set<string>();
    const nonEconomicInSource = new Set<string>();

    for (const file of readdirSync(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (line.trim() !== "return await runWithIdempotency(" && !/runWithIdempotency\($/.test(line.trim())) return;
        let exportName: string | null = null;
        for (let j = i; j >= 0; j--) {
          const m = lines[j].match(/^export const (\w+)\s*=/);
          if (m) { exportName = m[1]; break; }
        }
        let economic: string | null = null;
        for (let j = i; j < Math.min(i + 16, lines.length); j++) {
          const m = lines[j].match(/economic:\s*(true|false)/);
          if (m) { economic = m[1]; break; }
        }
        // "cannot tell" is never the permissive branch on a money path.
        expect(exportName, `could not resolve the export for a runWithIdempotency call in ${file}:${i + 1}`).not.toBeNull();
        expect(economic, `${file}#${exportName} does not declare \`economic\``).not.toBeNull();
        const key = `${file.replace(/\.ts$/, "")}.${exportName}`;
        (economic === "true" ? economicInSource : nonEconomicInSource).add(key);
      });
    }

    const manifestKeys = new Set(
      Object.entries(ECONOMIC_COMMANDS).flatMap(([mod, names]) =>
        names.map((n) => `${mod.replace("./", "")}.${n}`)
      )
    );

    const missingFromManifest = [...economicInSource].filter((k) => !manifestKeys.has(k)).sort();
    const missingFromSource = [...manifestKeys].filter((k) => !economicInSource.has(k)).sort();

    expect(missingFromManifest, "economic in the source but UNPROTECTED by the manifest").toEqual([]);
    expect(missingFromSource, "listed in the manifest but not economic in the source").toEqual([]);

    // The denominator, asserted rather than described.
    expect(economicInSource.size).toBe(37);
    expect([...nonEconomicInSource].sort()).toEqual(["sales.createDraft"]);
    expect(economicInSource.size + nonEconomicInSource.size).toBe(38);
  });

  /**
   * The other half of removing `./transactions` from the manifest above.
   *
   * A deleted manifest line and a genuinely retired command look identical from
   * inside this file. This test is what tells them apart: it holds only while
   * the legacy ledger writers actually refuse. Restore any one of them to a
   * working writer and this fails — which is the signal to put it back into
   * ECONOMIC_COMMANDS with a required identity, not to delete this test.
   */
  test("the retired legacy ledger writers stay retired, so their classification cannot lapse silently", async () => {
    const mod = (await import("./transactions")) as Record<string, unknown>;

    for (const name of ["add", "update", "remove"] as const) {
      const fn = mod[name] as { exportArgs?: () => string } | undefined;
      expect(fn, `transactions.${name} must still exist to be provably retired`).toBeDefined();
    }

    // Not "it throws somewhere" — the refusal must be the WHOLE handler, which
    // is what makes the command unable to move money regardless of arguments.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "convex/transactions.ts"), "utf8");
    for (const name of ["add", "update", "remove"] as const) {
      expect(source).toContain(`refuseLegacyLedgerWrite("transactions.${name}")`);
    }
  });
});
