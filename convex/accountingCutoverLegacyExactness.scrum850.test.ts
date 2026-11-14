import { expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";

type Direction = Doc<"transactions">["type"];
type RetainedRow = Pick<Doc<"transactions">, "amount"> & Partial<Pick<Doc<"transactions">, "date" | "isDeleted">>;
const fromDate = Date.UTC(2026, 0, 1);
const toDate = Date.UTC(2026, 0, 31);

async function fixture(type: Direction, rows: readonly RetainedRow[]) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST legacy exactness", createdAt: fromDate });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const userId = await ctx.db.insert("users", { clerkId: "legacy-exactness-owner", email: "legacy@example.test" });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: fromDate, updatedAt: fromDate });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    // Retained legacy history. The public legacy writer is retired; no GL events
    // are seeded, so these tests isolate the comparison's legacy cashflow totals.
    for (const row of rows) {
      await ctx.db.insert("transactions", {
        orgId, type, category: "OTHER", description: "Retained synthetic cashflow",
        ...row, date: row.date ?? fromDate,
      });
    }
    return orgId;
  });
  const owner = t.withIdentity({ subject: "legacy-exactness-owner" });
  return () => owner.query(api.accountingCutover.compareLegacyToGL, { orgId, fromDate, toDate });
}

async function unsafeTotal(type: Direction) {
  const compare = await fixture(type, [
    { amount: 4_503_599_627_370.496 }, { amount: 4_503_599_627_370.496 }, { amount: 0.001 },
  ]);
  // Exact minor operands are 4503599627370496, 4503599627370496, 1.
  // Their mathematical total is 9007199254740993, outside the safe Number range.
  await expect(compare()).rejects.toThrow(/CUTOVER_UNSAFE_TOTAL/);
}

async function exactTotal(type: Direction, boundary: boolean) {
  const compare = await fixture(type, boundary
    ? [{ amount: 4_503_599_627_370.496 }, { amount: 4_503_599_627_370.494 }]
    : [{ amount: 1.001 }, { amount: 2.002 }]);
  const result = await compare();
  const expected = boundary ? 9_007_199_254_740_990 : 3_003;
  expect(result.legacy).toEqual({
    transactionCount: 2, totalInMinor: type === "IN" ? expected : 0, totalOutMinor: type === "OUT" ? expected : 0,
  });
  expect(result.currency).toBe("JOD");
  expect(result.multiCurrencyWarning).toBe(false);
  expect(result.gl).toMatchObject({ migratedEventCount: 0, totalDebitMinor: 0, totalCreditMinor: 0, isBalanced: true });
  expect(result.unmigratedCount).toBe(2);
}

async function excludedLargeRow(type: Direction, exclusion: "before" | "after" | "deleted") {
  const compare = await fixture(type, [
    { amount: 4_503_599_627_370.496, date: fromDate },
    { amount: 4_503_599_627_370.494, date: toDate },
    { amount: 4_503_599_627_370.496,
      date: exclusion === "before" ? fromDate - 1 : exclusion === "after" ? toDate + 1 : fromDate,
      isDeleted: exclusion === "deleted" },
  ]);
  const result = await compare();
  expect(result.legacy).toEqual({
    transactionCount: 2,
    totalInMinor: type === "IN" ? 9_007_199_254_740_990 : 0,
    totalOutMinor: type === "OUT" ? 9_007_199_254_740_990 : 0,
  });
  expect(result.unmigratedCount).toBe(2);
  expect(result.unmigratedTransactionIds).toHaveLength(2);
}

// Literal registrations bind permanent scenario records to named tests.
test("SCRUM-850 R5 unsafe legacy IN total refuses with CUTOVER_UNSAFE_TOTAL", () => unsafeTotal("IN"));
test("SCRUM-850 R5 unsafe legacy OUT total refuses with CUTOVER_UNSAFE_TOTAL", () => unsafeTotal("OUT"));
test("SCRUM-850 R5 ordinary legacy IN total returns exact 3003", () => exactTotal("IN", false));
test("SCRUM-850 R5 ordinary legacy OUT total returns exact 3003", () => exactTotal("OUT", false));
test("SCRUM-850 R5 safe boundary legacy IN total returns exact 9007199254740990", () => exactTotal("IN", true));
test("SCRUM-850 R5 safe boundary legacy OUT total returns exact 9007199254740990", () => exactTotal("OUT", true));
test("SCRUM-850 R5 legacy IN excludes large row before date range", () => excludedLargeRow("IN", "before"));
test("SCRUM-850 R5 legacy OUT excludes large row before date range", () => excludedLargeRow("OUT", "before"));
test("SCRUM-850 R5 legacy IN excludes large row after date range", () => excludedLargeRow("IN", "after"));
test("SCRUM-850 R5 legacy OUT excludes large row after date range", () => excludedLargeRow("OUT", "after"));
test("SCRUM-850 R5 legacy IN excludes large deleted row", () => excludedLargeRow("IN", "deleted"));
test("SCRUM-850 R5 legacy OUT excludes large deleted row", () => excludedLargeRow("OUT", "deleted"));
