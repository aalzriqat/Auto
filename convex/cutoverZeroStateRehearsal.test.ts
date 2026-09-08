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
 * Evidence-floor coverage in this file: items 1, 2, 3, 4, 5, 6, 9 and 10.
 * Items 7 and 8 (the E2E-promotion preflight) are NOT covered and cannot be:
 * `convex/e2eBootstrap.ts` exists only on the unmerged SCRUM-143 branch, so
 * there is no marker table in the merged schema to detect. Inventing one would
 * be a fabricated gate. See the test at the bottom that records this.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  COMMAND_AUTHORITY_TABLES,
  CUTOVER_RETAINED_BY_DESIGN,
  cutoverResetOrder,
  orgIndexFor,
  orgScopedTableNames,
} from "./cutoverZeroState";
import { ORGANIZATION_DELETION_STEPS } from "./adminOrgs";
import { SYSTEM_KEYS } from "./utils/defaultChart";

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

/** Runs the destructive reset until it reports nothing remaining. */
async function resetToZero(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">
) {
  let guard = 0;
  for (;;) {
    const result = await t.mutation(internal.cutoverZeroState.resetOrgToZeroState, {
      orgId,
      dryRun: false,
    });
    if (result.remaining === 0) return result;
    if (++guard > 20) throw new Error("reset did not converge in 20 passes");
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
    expect(dry.total).toBeGreaterThan(0);
    // Everything it counted is still there, so `remaining` must not claim the
    // org is one pass from clean.
    expect(dry.remaining).toBeGreaterThanOrEqual(dry.total);

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
