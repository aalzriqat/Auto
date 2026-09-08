/**
 * SCRUM-231 — clean-slate cutover zero-state rehearsal.
 *
 * This is the non-production rehearsal the ticket's evidence floor asks for. It
 * proves the transition path WITHOUT performing the production transition: no
 * deploy, no production reset, no migration, no backfill. Everything here runs
 * against a `convex-test` harness on disposable fixtures.
 *
 * ⚠️ WHAT A PASSING RUN DOES AND DOES NOT ESTABLISH. It establishes repository
 * behaviour: the reset scope is derived rather than listed, the ordering is the
 * safe one, and the zero state is reached and PROVEN BY COUNTING ROWS. It does
 * NOT establish Convex runtime behaviour or data parity with production — the
 * harness does not enforce the platform's limits, and synthetic fixtures do not
 * have the shape of real rows. Those remain separate gates.
 *
 * ## Evidence-floor coverage, corrected
 *
 * ⚠️ AN EARLIER VERSION OF THIS HEADER CLAIMED ITEMS 1-6, 9 AND 10. That was
 * wrong about items 2 and 5, and the owner caught it: nothing in this file
 * demonstrated either. The claim is restated per item, with the test that
 * carries it, so the next reader can check the claim instead of trusting it.
 *
 * ```text
 * 1  reset leaves designated tables empty        COVERED   "reaches a proven zero state"
 * 2  stale scheduled work cannot repopulate      PENDING   → SCRUM-302, exposure DEMONSTRATED below
 * 3  empty state needs no historical migration   COVERED   "legacy migration writer refuses"
 * 4  fresh chart seeds 2110 exactly              COVERED   "2110 is seeded as a LIABILITY..."
 * 5  first fresh accounting event posts          COVERED   "the first fresh expense posts..."
 * 6  reset scope explicit, no rows preserved     COVERED   scope-derivation describe block
 * 7  target not promoted from an E2E preview     BLOCKED   → SCRUM-143 / PR #278
 * 8  no E2E marker survives on the target        BLOCKED   → SCRUM-143 / PR #278
 * 9  command authority reaches zero, safe order  COVERED   ordering + zero-state tests
 * 10 F-1 three tables zero BY EXECUTION          COVERED   counted individually after reset
 * ```
 *
 * **Item 2 is PENDING, not covered, and the exposure below is DEMONSTRATED
 * rather than assumed.** A scheduled internal job enqueued before the reset
 * still runs after it and writes into the zeroed organization. That is not a
 * defect of this module — `internalMutation` bypasses `requireTenantAuth`, so
 * the suspension that holds writes during a cutover does not reach it, which is
 * SCRUM-302. Recording it as an executed negative result is the honest form:
 * the cutover sequence's step 1 ("stop/hold user writes") is not sufficient,
 * and SCRUM-302 must close before item 2 can be claimed.
 *
 * **Items 7 and 8 cannot be written here at all.** `convex/e2eBootstrap.ts`
 * exists only on the unmerged SCRUM-143 branch, so there is no marker table in
 * the merged schema to detect. Inventing one would be a fabricated gate. See
 * the test at the bottom that fails the moment that stops being true.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  assertCutoverScopeVerifiable,
  COMMAND_AUTHORITY_TABLES,
  CUTOVER_RETAINED_BY_DESIGN,
  cutoverResetOrder,
  orgIndexFor,
  orgScopedTableNames,
} from "./cutoverZeroState";
import { ORGANIZATION_DELETION_STEPS } from "./adminOrgs";
import { SYSTEM_KEYS } from "./utils/defaultChart";

/**
 * The SCRUM-297 lifecycle tests drive real super-admin mutations, and
 * `requireSuperAdmin` reads this allowlist from the environment. Saved and
 * restored so this file cannot leak an admin allowlist into another suite.
 */
const SUPER_ADMIN_EMAIL = "admin@autoflow.dev";
const ORIGINAL_SUPER_ADMIN_EMAILS = process.env.SUPER_ADMIN_EMAILS;

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = SUPER_ADMIN_EMAIL;
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_SUPER_ADMIN_EMAILS;
});

/** A dealership with money state across the tables the cutover must clear. */
async function seedDealer(name: string, clerkId: string) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const ids = await seedInto(t, name, clerkId);
  return { t, ...ids };
}

async function seedInto(
  t: ReturnType<typeof convexTestWithComponents>,
  name: string,
  clerkId: string
) {
  const now = Date.now();
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name, createdAt: now })
  );
  // The accounting surfaces sit behind a plan gate, so a dealership without a
  // subscription cannot even initialize its chart.
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId, email: `${clerkId}@example.com`, name })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance",
      permissions: ["view:sales", "manage:finance", "view:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  // The three tables the cutover exists to reach, and which a "successful"
  // hardDeleteOrg or resetOrgFinancialData leaves behind today.
  await t.run((ctx) =>
    ctx.db.insert("commandIdempotency", {
      orgId,
      operation: "payroll.recoverAdvance",
      idempotencyKey: `${clerkId}-key-1`,
      status: "COMPLETED",
      result: { ok: true },
      createdAt: now,
    })
  );
  const advanceId = await t.run((ctx) =>
    ctx.db.insert("employeeAdvances", {
      orgId,
      userId,
      amountMinor: 100000,
      recoveredMinor: 40000,
      currency: "JOD",
      date: now,
      status: "OUTSTANDING",
      createdAt: now,
      updatedAt: now,
    })
  );
  await t.run((ctx) =>
    ctx.db.insert("employeeAdvanceRecoveries", {
      orgId,
      advanceId,
      userId,
      amountMinor: 40000,
      currency: "JOD",
      source: "DIRECT",
      recoveredAt: now,
      recoveredBy: userId,
    })
  );

  return { orgId, userId, clerkId };
}

/**
 * Drives the destructive reset to the end of its table order, following the
 * cursor exactly as an operator would.
 *
 * Returns the number of invocations it took and the total rows deleted, so a
 * test can assert the walk was actually BOUNDED rather than one giant pass.
 */
async function resetToZero(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  batchSize?: number
) {
  let cursor: string | null | undefined = undefined;
  let invocations = 0;
  let deleted = 0;
  const maxDeletedInOneCall: number[] = [];
  for (;;) {
    const args: {
      orgId: Id<"organizations">;
      dryRun: boolean;
      batchSize?: number;
      resumeFrom?: string;
    } = { orgId, dryRun: false };
    if (batchSize !== undefined) args.batchSize = batchSize;
    if (cursor) args.resumeFrom = cursor;
    const result = await t.mutation(internal.cutoverZeroState.resetOrgToZeroState, args);
    invocations++;
    deleted += result.deleted;
    maxDeletedInOneCall.push(result.deleted);
    cursor = result.nextCursor;
    if (cursor === null) return { invocations, deleted, maxDeletedInOneCall };
    if (invocations > 60) throw new Error("reset did not converge in 60 invocations");
  }
}

describe("SCRUM-231 cutover scope is derived, not listed", () => {
  test("the derivation actually sees the schema", () => {
    // A guard nobody has watched work is not a guard: if this came back empty
    // every zero-state assertion below would pass vacuously.
    const tables = orgScopedTableNames();
    expect(tables.length).toBeGreaterThan(100);
    expect(tables).toContain("commandIdempotency");
    expect(tables).toContain("employeeAdvances");
    expect(tables).toContain("employeeAdvanceRecoveries");
  });

  test("every in-scope table can be checked by an orgId-first index", () => {
    // The verifier fails closed on any table it cannot read. That is the right
    // behaviour, but it is only useful if the list is empty today — otherwise
    // the cutover could never prove zero. Measured: 140 of 140.
    const unverifiable = cutoverResetOrder().filter((table) => orgIndexFor(table) === null);
    expect(
      unverifiable,
      `These org-scoped tables have no index whose first field is orgId, so the ` +
        `zero-state check cannot read them without a scan:\n` +
        unverifiable.map((t) => `  - ${t}`).join("\n")
    ).toEqual([]);
  });

  test("command authority is cleared LAST, opposite to the org purge", () => {
    // Evidence-floor item 9. The purge deletes commandIdempotency at step 0;
    // doing that here would let an in-flight retry re-execute against financial
    // rows that are still live, which is SCRUM-291's F-1 exactly.
    const order = cutoverResetOrder();
    for (const table of COMMAND_AUTHORITY_TABLES) {
      expect(order).toContain(table);
      expect(order.indexOf(table)).toBe(order.length - 1);
    }

    // And the purge really does the opposite — pinned so this comment cannot
    // quietly become false.
    const firstPurgeStep = ORGANIZATION_DELETION_STEPS[0];
    expect(firstPurgeStep.kind).toBe("orgRows");
    expect(firstPurgeStep.kind === "orgRows" && firstPurgeStep.table).toBe(
      "commandIdempotency"
    );
  });

  test("the scope reaches every table the org purge is known to miss", () => {
    // Evidence-floor item 6. The SCRUM-18 omission list is INPUT to the reset
    // scope, not a substitute for proving it — so rather than copy that list,
    // assert the derived scope is a superset of everything the purge misses.
    const purgeCovers = new Set<string>();
    for (const step of ORGANIZATION_DELETION_STEPS) {
      if (step.kind === "orgRows") purgeCovers.add(step.table);
    }
    const missedByPurge = orgScopedTableNames().filter(
      (table) =>
        !purgeCovers.has(table) && !Object.hasOwn(CUTOVER_RETAINED_BY_DESIGN, table)
    );
    // Non-vacuity: the purge genuinely misses tables, so this is a real test.
    expect(missedByPurge).toContain("employeeAdvances");
    expect(missedByPurge).toContain("employeeAdvanceRecoveries");

    const scope = new Set(cutoverResetOrder());
    const stillMissed = missedByPurge.filter((table) => !scope.has(table));
    expect(
      stillMissed,
      `The cutover scope misses these too, so the clean slate would inherit the ` +
        `purge's blind spot:\n` + stillMissed.map((t) => `  - ${t}`).join("\n")
    ).toEqual([]);
  });

  test("tables that must outlive the cutover are never in the reset scope", () => {
    const scope = new Set(cutoverResetOrder());
    const wronglyInScope = Object.keys(CUTOVER_RETAINED_BY_DESIGN).filter((t) =>
      scope.has(t)
    );
    expect(
      wronglyInScope,
      `These must survive the cutover but the reset would delete them:\n` +
        wronglyInScope
          .map((t) => `  - ${t}: ${CUTOVER_RETAINED_BY_DESIGN[t]}`)
          .join("\n")
    ).toEqual([]);
  });
});

describe("SCRUM-231 zero state is proven, not asserted", () => {
  test("CONTROL — a populated org is NOT zero, and the failure names the tables", async () => {
    // The failing-first control. Without this, a verifier that returned
    // `zero: true` unconditionally would pass every test below.
    const { t, orgId } = await seedDealer("Control Dealer", "ctrl_user");

    const before = await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId });

    expect(before.zero).toBe(false);
    expect(Object.keys(before.residual)).toContain("commandIdempotency");
    expect(Object.keys(before.residual)).toContain("employeeAdvances");
    expect(Object.keys(before.residual)).toContain("employeeAdvanceRecoveries");
    expect(before.unverifiable).toEqual([]);
    expect(before.tablesChecked).toBeGreaterThan(100);
  });

  test("after the reset the org reaches a proven zero state", async () => {
    // Evidence-floor items 1 and 10. Proven by counting rows across every
    // org-scoped table — NOT by observing that the reset reported success.
    const { t, orgId } = await seedDealer("Cutover Dealer", "cut_user");

    await resetToZero(t, orgId);
    const after = await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId });

    expect(after.residual).toEqual({});
    expect(after.unverifiable).toEqual([]);
    expect(after.zero).toBe(true);

    // The three named in the F-1 containment gate, asserted individually so a
    // future change to the verifier cannot quietly stop covering them.
    const counts = await t.run(async (ctx) => ({
      commandIdempotency: (
        await ctx.db
          .query("commandIdempotency")
          .withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId))
          .collect()
      ).length,
      employeeAdvances: (
        await ctx.db
          .query("employeeAdvances")
          .withIndex("by_org", (q) => q.eq("orgId", orgId))
          .collect()
      ).length,
      employeeAdvanceRecoveries: (
        await ctx.db
          .query("employeeAdvanceRecoveries")
          .withIndex("by_org", (q) => q.eq("orgId", orgId))
          .collect()
      ).length,
    }));
    expect(counts).toEqual({
      commandIdempotency: 0,
      employeeAdvances: 0,
      employeeAdvanceRecoveries: 0,
    });
  });

  test("a dry run proves the scope without deleting anything", async () => {
    const { t, orgId } = await seedDealer("Dry Run Dealer", "dry_user");

    const dry = await t.mutation(internal.cutoverZeroState.resetOrgToZeroState, { orgId });
    expect(dry.dryRun).toBe(true);
    expect(dry.deleted).toBeGreaterThan(0);
    // It walked the whole order and nothing was left over budget, so the
    // destructive form of this call would finish in one invocation.
    expect(dry.nextCursor).toBeNull();

    const after = await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId });
    expect(after.zero).toBe(false);
  });

  test("dryRun defaults to the safe form when omitted entirely", async () => {
    const { t, orgId } = await seedDealer("Default Dealer", "def_user");
    const result = await t.mutation(internal.cutoverZeroState.resetOrgToZeroState, {
      orgId,
    });
    expect(result.dryRun).toBe(true);
    const after = await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId });
    expect(after.zero).toBe(false);
  });

  test("the reset is tenant-scoped — a second dealership is untouched", async () => {
    // A destructive tool that crosses tenants is worse than one that fails.
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const a = await seedInto(t, "Dealer A", "tenant_a");
    const b = await seedInto(t, "Dealer B", "tenant_b");

    await resetToZero(t, a.orgId);

    expect(
      (await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId: a.orgId }))
        .zero
    ).toBe(true);

    const other = await t.query(internal.cutoverZeroState.verifyOrgZeroState, {
      orgId: b.orgId,
    });
    expect(other.zero).toBe(false);
    expect(Object.keys(other.residual)).toContain("commandIdempotency");
    expect(Object.keys(other.residual)).toContain("employeeAdvances");
  });

  test("a reset aimed at a non-existent organization refuses", async () => {
    const { t, orgId } = await seedDealer("Refusal Dealer", "ref_user");
    await t.run((ctx) => ctx.db.delete(orgId));
    await expect(
      t.mutation(internal.cutoverZeroState.resetOrgToZeroState, { orgId, dryRun: false })
    ).rejects.toThrow(/no organization with that id exists/i);
  });
});

describe("SCRUM-231 fresh chart seeds the correct unapplied-receipts account", () => {
  test("2110 is seeded as a LIABILITY control account with no manual posting", async () => {
    // Evidence-floor item 4. Existence alone is explicitly insufficient — the
    // exact definition is the requirement, because the account this replaces
    // stated the opposite of the truth.
    const { t, orgId, clerkId } = await seedDealer("Chart Dealer", "chart_user");
    const asUser = t.withIdentity({ subject: clerkId, clerkId });
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

    const account = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      return rows.find(
        (row) => row.systemKey === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY
      );
    });

    expect(account, "the fresh chart must seed the unapplied-receipts account").toBeDefined();
    expect(account!.code).toBe("2110");
    expect(account!.type).toBe("LIABILITY");
    expect(account!.normalBalance).toBe("CREDIT");
    expect(account!.isControlAccount).toBe(true);
    expect(account!.allowManualPosting).toBe(false);
  });

  test("the old unapplied-cash ASSET definition is NOT carried forward", async () => {
    // The clean slate removes legacy chart migration; it does not permit
    // seeding the previous `1220 Unapplied Customer Cash`, which booked money
    // the dealership owes as an asset it holds.
    const { t, orgId, clerkId } = await seedDealer("Legacy Chart Dealer", "legacy_chart");
    const asUser = t.withIdentity({ subject: clerkId, clerkId });
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

    const codes = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      return rows.map((row) => row.code);
    });
    expect(codes).not.toContain("1220");
  });
});

describe("SCRUM-231 the empty state needs no historical migration", () => {
  test("the legacy migration writer refuses in every dryRun state", async () => {
    // Evidence-floor item 3, and the SCRUM-234 retirement observed from this
    // lane rather than assumed: startup on the empty state cannot require a
    // historical migration, because the migration can no longer write at all.
    const { t, orgId, clerkId } = await seedDealer("Empty State Dealer", "empty_user");
    const asUser = t.withIdentity({ subject: clerkId, clerkId });

    for (const args of [
      { orgId },
      { orgId, dryRun: true },
      { orgId, dryRun: false },
    ]) {
      await expect(
        asUser.mutation(api.accountingMigration.migrateUnpostedTransactions, args)
      ).rejects.toThrow();
    }
  });
});

describe("SCRUM-231 the reset is bounded by ONE budget, not one per table", () => {
  test("CONTROL + BOUND — a single invocation never exceeds the global budget", async () => {
    // FAILING-FIRST against the shape this replaced. The previous reset spent
    // `batchSize` on EVERY table, so with a budget of 2 across three populated
    // tables it deleted 6 rows in one mutation, and the real ceiling scaled
    // with the number of tables — 138 of them here. That is how a reset
    // discovers a Convex transaction limit on a populated tenant: mid-run.
    const { t, orgId } = await seedDealer("Budget Dealer", "budget_user");

    const populated = await t.query(internal.cutoverZeroState.verifyOrgZeroState, {
      orgId,
    });
    // The control: more than two tables hold rows, so a per-table budget would
    // visibly exceed the global one.
    expect(Object.keys(populated.residual).length).toBeGreaterThan(2);

    const first = await t.mutation(internal.cutoverZeroState.resetOrgToZeroState, {
      orgId,
      dryRun: false,
      batchSize: 2,
    });
    expect(first.budget).toBe(2);
    expect(first.deleted).toBeLessThanOrEqual(2);
    // It stopped early, so there is somewhere to resume from.
    expect(first.nextCursor).not.toBeNull();
  });

  test("the cursor resumes where the budget ran out and the walk converges", async () => {
    const { t, orgId } = await seedDealer("Cursor Dealer", "cursor_user");

    const walk = await resetToZero(t, orgId, 1);

    // One row per invocation means the walk had to take several, and every
    // single one stayed inside its budget.
    expect(walk.invocations).toBeGreaterThan(1);
    for (const deleted of walk.maxDeletedInOneCall) {
      expect(deleted).toBeLessThanOrEqual(1);
    }
    expect(
      (await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId })).zero
    ).toBe(true);
  });

  test("a cursor naming a table outside the scope refuses rather than guessing", async () => {
    const { t, orgId } = await seedDealer("Bad Cursor Dealer", "badcur_user");
    await expect(
      t.mutation(internal.cutoverZeroState.resetOrgToZeroState, {
        orgId,
        dryRun: false,
        resumeFrom: "organizations",
      })
    ).rejects.toThrow(/not in the reset scope/i);

    // The refusal deleted nothing: silently restarting the walk and silently
    // skipping the rest of it are both worse than stopping.
    expect(
      (await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId })).zero
    ).toBe(false);
  });
});

describe("SCRUM-231 the scope is preflighted before the first delete", () => {
  test("the preflight names every table it cannot read, and refuses", () => {
    // `organizations` has no `orgId` field at all — its own id IS the org — so
    // this is a real table with no orgId-first index, not a fabricated one.
    expect(() => assertCutoverScopeVerifiable(["organizations"])).toThrow(
      /cannot be read by an orgId-first index/i
    );
    expect(() => assertCutoverScopeVerifiable(["organizations"])).toThrow(
      /Nothing was deleted/i
    );
  });

  test("the real cutover scope passes the preflight, so the gate is not vacuous", () => {
    // ⚠️ AND THIS IS ALSO WHY ONE MUTANT SURVIVES, STATED RATHER THAN HIDDEN.
    // Replacing the mutation's `assertCutoverScopeVerifiable` call with the
    // non-throwing `resolveCutoverIndexes` leaves all 28 tests green (measured,
    // not assumed). No executed test can kill it, because every in-scope table
    // IS verifiable today — which is exactly what the assertion below proves.
    // The refusal's behaviour is covered by the test above; its USE by the
    // mutation is covered only by inspection. Closing that would need a test
    // seam widening the scope from outside, and a destructive tool is the last
    // place to add one.
    const resolved = assertCutoverScopeVerifiable(cutoverResetOrder());
    expect(resolved.size).toBe(cutoverResetOrder().length);
    expect(resolved.size).toBeGreaterThan(100);
  });

  test("a refusal during preflight commits ZERO destructive writes", async () => {
    // The executed half of the ordering claim: a mutation that refuses in the
    // preflight block leaves every row exactly where it was. In Convex an
    // UNCAUGHT exception rolls the transaction back — a caught one commits —
    // which is why every refusal here throws instead of returning a report.
    const { t, orgId } = await seedDealer("Preflight Dealer", "pre_user");
    const before = await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId });

    await expect(
      t.mutation(internal.cutoverZeroState.resetOrgToZeroState, {
        orgId,
        dryRun: false,
        batchSize: 0,
      })
    ).rejects.toThrow(/positive whole number/i);
    await expect(
      t.mutation(internal.cutoverZeroState.resetOrgToZeroState, {
        orgId,
        dryRun: false,
        batchSize: 2.5,
      })
    ).rejects.toThrow(/positive whole number/i);

    const after = await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId });
    expect(after.residual).toEqual(before.residual);
    expect(after.zero).toBe(false);
  });
});

describe("SCRUM-231 the zeroed tenant is bootable into first real use", () => {
  test("a fresh organization created after the cutover posts its first accounting event", async () => {
    // Evidence-floor item 5, executed: reset → bootstrap → chart → open period
    // → a real operational record → a balanced journal entry.
    const { t, orgId } = await seedDealer("Outgoing Dealer", "outgoing_user");
    await resetToZero(t, orgId);
    expect(
      (await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId })).zero
    ).toBe(true);

    // The bootstrap is the ordinary tenant-creation path, not a cutover-only
    // one: `organizations.create` seeds the default roles, the owner
    // membership and the subscription in the same mutation.
    const asFounder = t.withIdentity({ subject: "fresh_owner", clerkId: "fresh_owner" });
    const freshOrgId = await asFounder.mutation(api.organizations.create, {
      name: "Fresh Motors",
    });

    await asFounder.mutation(api.chartOfAccounts.initialize, { orgId: freshOrgId });
    const now = Date.now();
    await asFounder.mutation(api.accountingPeriods.create, {
      orgId: freshOrgId,
      fiscalYear: new Date(now).getUTCFullYear(),
      periodNumber: 1,
      startDate: now - 86_400_000,
      endDate: now + 86_400_000,
      openImmediately: true,
    });

    const expenseId = await asFounder.mutation(api.expenses.create, {
      orgId: freshOrgId,
      title: "First fresh operating expense",
      amount: 100,
      date: now,
      category: "OFFICE",
      status: "PAID",
    });
    expect(expenseId).toBeDefined();

    const posted = await t.run(async (ctx) => {
      const events = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", freshOrgId))
        .collect();
      const entries = await ctx.db
        .query("journalEntries")
        .withIndex("by_org", (q) => q.eq("orgId", freshOrgId))
        .collect();
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_org", (q) => q.eq("orgId", freshOrgId))
        .collect();
      return { events, entries, lines };
    });

    // It posted under the redesigned rules, immediately — not deferred to the
    // outbox, which is what a missing chart or a closed period would have done.
    expect(posted.events.length).toBeGreaterThan(0);
    expect(posted.events.some((e) => e.sourceType === "expenses")).toBe(true);
    expect(posted.events.every((e) => e.status === "POSTED")).toBe(true);
    expect(posted.entries.length).toBeGreaterThan(0);
    expect(posted.lines.length).toBeGreaterThan(1);

    // Double entry actually balances. A "first fresh event posted" that does
    // not balance is not a smoke test, it is a bug report.
    const debits = posted.lines.reduce((sum, l) => sum + (l.debitMinor ?? 0), 0);
    const credits = posted.lines.reduce((sum, l) => sum + (l.creditMinor ?? 0), 0);
    expect(debits).toBe(credits);
    expect(debits).toBeGreaterThan(0);
  });

  test("an idempotency key used BEFORE the reset executes freshly after it", async () => {
    // The consequence of evidence-floor item 9, executed on the real command
    // path rather than derived from reading `runWithIdempotency`.
    //
    // `expenses.create` runs through the shared command log. If a
    // `commandIdempotency` row survived the cutover, this second call would
    // replay the stored success and return an expense id that no longer
    // resolves — silently, with no error at the boundary. Because the command
    // authority is driven to zero, the key is free again and the command
    // actually executes.
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const founder = t.withIdentity({ subject: "reuse_owner", clerkId: "reuse_owner" });
    const orgId = await founder.mutation(api.organizations.create, { name: "Reuse Motors" });
    const now = Date.now();

    const firstExpenseId = await founder.mutation(api.expenses.create, {
      orgId,
      title: "Pre-cutover expense",
      amount: 50,
      date: now,
      category: "OFFICE",
      status: "PAID",
      idempotencyKey: "cutover-reused-key",
    });

    // The command log really is the thing being relied on here.
    const commandRows = await t.run((ctx) =>
      ctx.db
        .query("commandIdempotency")
        .withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId))
        .collect()
    );
    expect(commandRows.length).toBeGreaterThan(0);

    await resetToZero(t, orgId);
    expect(
      (await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId })).zero
    ).toBe(true);

    // The reset removed the roles and memberships too, so the tenant has to be
    // re-provisioned before anyone can act in it. That is the honest cost of
    // reusing an organization id, and it is one reason fresh-org creation is
    // the recommended post-cutover path.
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", "reuse_owner"))
        .unique();
      const roleId = await ctx.db.insert("roles", {
        orgId,
        name: "OWNER",
        permissions: ["create:expenses", "manage:finance", "view:finance"],
        isSystemOwnerRole: true,
      });
      await ctx.db.insert("memberships", { orgId, userId: user!._id, roleId });
      await ctx.db.insert("subscriptions", {
        orgId,
        plan: "enterprise",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const secondExpenseId = await founder.mutation(api.expenses.create, {
      orgId,
      title: "Post-cutover expense",
      amount: 50,
      date: now,
      category: "OFFICE",
      status: "PAID",
      idempotencyKey: "cutover-reused-key",
    });

    // A replayed stale success would have returned the OLD id, which no longer
    // resolves. A fresh execution returns a new, resolvable one.
    expect(secondExpenseId).not.toBe(firstExpenseId);
    expect(await t.run((ctx) => ctx.db.get(firstExpenseId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(secondExpenseId))).not.toBeNull();
  });

  test("the reset strips the tenant's own roles and memberships, so reuse is not free", async () => {
    // Stated as an executed fact rather than a caveat: after zero the
    // organization row still exists but nobody is a member of it, so no
    // ordinary mutation can be performed in it until it is re-provisioned.
    const { t, orgId, clerkId } = await seedDealer("Reuse Cost Dealer", "reusecost_user");
    await resetToZero(t, orgId);

    const survivors = await t.run(async (ctx) => ({
      org: await ctx.db.get(orgId),
      roles: (
        await ctx.db
          .query("roles")
          .withIndex("by_org", (q) => q.eq("orgId", orgId))
          .collect()
      ).length,
      memberships: (
        await ctx.db
          .query("memberships")
          .withIndex("by_org", (q) => q.eq("orgId", orgId))
          .collect()
      ).length,
    }));
    expect(survivors.org).not.toBeNull();
    expect(survivors.roles).toBe(0);
    expect(survivors.memberships).toBe(0);

    const asUser = t.withIdentity({ subject: clerkId, clerkId });
    await expect(
      asUser.mutation(api.chartOfAccounts.initialize, { orgId })
    ).rejects.toThrow();
  });
});

describe("SCRUM-231 purge history dead-ends same-org reuse (SCRUM-297)", () => {
  test("an org carrying destructivePurgeStartedAt can never be returned to service", async () => {
    // The owner's question, answered by execution: does the chosen post-cutover
    // lifecycle dead-end behind SCRUM-297? For SAME-ORG reuse of an org with
    // irreversible purge history, YES — permanently, and by design.
    const { t, orgId } = await seedDealer("Purged Dealer", "purged_user");
    await t.run((ctx) =>
      ctx.db.patch(orgId, { suspended: true, destructivePurgeStartedAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "dev_admin", email: SUPER_ADMIN_EMAIL })
    );

    await resetToZero(t, orgId);
    expect(
      (await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId })).zero
    ).toBe(true);

    // The marker lives on the `organizations` row, which is NOT org-scoped —
    // its own id is the org — so the cutover reset never touches it. The
    // dealership ends up zeroed AND permanently un-reactivatable.
    const asAdmin = t.withIdentity({ subject: "dev_admin", clerkId: "dev_admin" });
    await expect(asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId })).rejects.toThrow(
      /begun destructive deletion|cannot be returned to service/i
    );

    const stillMarked = await t.run((ctx) => ctx.db.get(orgId));
    expect(stillMarked?.destructivePurgeStartedAt).toEqual(expect.any(Number));
    expect(stillMarked?.suspended).toBe(true);
  });

  test("a FAILED deletion request survives the reset by design and also refuses", async () => {
    // `organizationDeletionRequests` is RETAINED_BY_DESIGN, so the conservative
    // half of the SCRUM-297 guard outlives the cutover too. Both conditions
    // survive the zero state.
    const { t, orgId, userId } = await seedDealer("Failed Purge Dealer", "failed_user");
    await t.run((ctx) => ctx.db.patch(orgId, { suspended: true }));
    await t.run((ctx) =>
      ctx.db.insert("organizationDeletionRequests", {
        orgId,
        orgName: "Failed Purge Dealer",
        status: "FAILED",
        requestedBy: userId,
        requestedAt: Date.now(),
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "dev_admin", email: SUPER_ADMIN_EMAIL })
    );

    await resetToZero(t, orgId);

    const request = await t.run((ctx) =>
      ctx.db
        .query("organizationDeletionRequests")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "FAILED"))
        .first()
    );
    expect(
      request,
      "retained by design, so the SCRUM-297 evidence outlives the reset"
    ).not.toBeNull();

    const asAdmin = t.withIdentity({ subject: "dev_admin", clerkId: "dev_admin" });
    await expect(asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId })).rejects.toThrow(
      /cannot be returned to service|failed deletion/i
    );
  });

  test("fresh-org creation is unaffected by another org's purge history", async () => {
    // The escape hatch, executed: the dead-end is per-organization, so the
    // post-cutover lifecycle for a purge-marked tenant is a NEW organization —
    // which bootstraps normally.
    const { t, orgId } = await seedDealer("Dead End Dealer", "deadend_user");
    await t.run((ctx) =>
      ctx.db.patch(orgId, { suspended: true, destructivePurgeStartedAt: Date.now() })
    );
    await resetToZero(t, orgId);

    const asFounder = t.withIdentity({ subject: "successor", clerkId: "successor" });
    const successorId = await asFounder.mutation(api.organizations.create, {
      name: "Successor Motors",
    });
    await asFounder.mutation(api.chartOfAccounts.initialize, { orgId: successorId });

    const chart = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org", (q) => q.eq("orgId", successorId))
        .collect()
    );
    expect(chart.length).toBeGreaterThan(0);
    const successor = await t.run((ctx) => ctx.db.get(successorId));
    expect(successor?.destructivePurgeStartedAt).toBeUndefined();
    expect(successor?.suspended).toBeUndefined();
  });
});

describe("SCRUM-231 evidence-floor item 2 is PENDING behind SCRUM-302", () => {
  test("DEMONSTRATED — the reset cancels no scheduled work and the zero proof cannot see it", async () => {
    // ⚠️ THIS TEST RECORDS A GAP, NOT A GUARANTEE. Evidence-floor item 2 asks
    // that stale scheduled work from before the reset cannot create a new
    // accounting footprint after it. Nothing in this module establishes that,
    // and an earlier version of this file's header claimed item 2 was covered.
    // It was not.
    //
    // Two executed facts, together sufficient to show item 2 is unmet:
    //
    //   1. `_scheduled_functions` is a SYSTEM table carrying no `orgId`, so the
    //      schema-derived scope can never reach it and the reset cancels
    //      nothing — the scheduled job's ARGUMENTS are org-scoped state living
    //      outside every org-scoped table.
    //   2. `verifyOrgZeroState` reports `zero: true` while a job scheduled
    //      before the reset is still pending against that same organization.
    //
    // Closing this needs a hold on internal/scheduled execution across the
    // cutover boundary, which is SCRUM-302: `requireTenantAuth` is the only
    // suspension gate and `internalMutation` bypasses it by construction, so
    // "stop/hold user writes" (cutover sequence step 1) does not reach it.
    const { t, orgId } = await seedDealer("Scheduled Dealer", "sched_user");

    // A real internal mutation, scheduled with real org-scoped arguments. The
    // reset itself is used deliberately: it is the one function in this lane
    // whose arguments are provably org-scoped, and in dry-run form it is inert.
    await t.run(async (ctx) => {
      await ctx.scheduler.runAfter(
        60 * 60 * 1000,
        internal.cutoverZeroState.resetOrgToZeroState,
        { orgId, dryRun: true }
      );
    });

    const scheduledBefore = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    );
    expect(scheduledBefore.length).toBeGreaterThan(0);

    await resetToZero(t, orgId);

    const proof = await t.query(internal.cutoverZeroState.verifyOrgZeroState, { orgId });
    expect(proof.zero, "the zero proof passes...").toBe(true);

    const scheduledAfter = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    );
    // ...while work scheduled before the reset is still pending against the
    // organization the proof just certified as empty.
    expect(
      scheduledAfter.filter((job) => job.state.kind === "pending").length,
      "item 2 is NOT satisfied: pre-reset scheduled work survives the cutover"
    ).toBeGreaterThan(0);

    // And it can never come into scope, because the scope is derived from orgId.
    expect(orgScopedTableNames()).not.toContain("_scheduled_functions");
    expect(cutoverResetOrder()).not.toContain("_scheduled_functions");
  });
});

describe("SCRUM-231 items 7 and 8 are NOT covered here, and why", () => {
  test("the E2E bootstrap marker does not exist in the merged schema", () => {
    // Evidence-floor items 7 and 8 require a preflight that fails closed when
    // the cutover target shows evidence it was ever an E2E bootstrap target.
    // That evidence is a marker written by `convex/e2eBootstrap.ts`, which
    // lives only on the unmerged SCRUM-143 branch (PR #278).
    //
    // This test exists so the gap is recorded as a FACT that fails the moment
    // it stops being true, rather than as a sentence in a report. When #278
    // merges, this test starts failing and whoever sees it must implement the
    // preflight instead of deleting the assertion.
    const tables = Object.keys(schema.tables);
    const markerish = tables.filter((name) => /e2e/i.test(name));
    expect(
      markerish,
      `An E2E-related table now exists in the schema. Evidence-floor items 7 and 8 ` +
        `are no longer un-implementable: build the cutover preflight that fails ` +
        `closed on an E2E-marked or E2E-seeded target, and replace this test.`
    ).toEqual([]);
  });
});
