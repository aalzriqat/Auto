/**
 * SCRUM-565 S1a — the destructive reset gate.
 *
 * INVARIANT: until every SCRUM-565 slice has shipped, a destructive
 * `resetOrgFinancialData` invocation (fresh OR continuation) refuses before it
 * writes anything.
 *
 * Deliberately NO `vi.mock` of `utils/resetProtocol`: this file proves the gate
 * is closed as shipped. The messages below are literals on purpose, so the test
 * does not pass merely because it reads the same constant as the source.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { expectAppError } from "../test-utils/expectAppError";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { RESET_PROTOCOL_INCOMPLETE_MESSAGE } from "./utils/resetProtocol";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

const GATE_CODE = "RESET_PROTOCOL_INCOMPLETE";
const GATE_MESSAGE =
  "The financial reset is temporarily disabled while its safety checks are being completed. Nothing was deleted.";
const GATE_MESSAGE_AR = "إعادة الضبط المالي معطّلة مؤقتًا حتى تكتمل فحوصات الأمان الخاصة بها. لم يُحذف أي شيء.";

type Harness = ReturnType<typeof convexTestWithComponents<typeof schema>>;

async function seedResetOrg(
  t: Harness,
  state: { suspended: boolean; financialResetGeneration?: number; financialResetCompletedGeneration?: number }
) {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Gate Org", createdAt: Date.now(), ...state });
    const expenseId = await ctx.db.insert("expenses", {
      orgId,
      title: "Survivor",
      amount: 50,
      date: Date.now(),
      category: "OTHER" as const,
    });
    return { orgId, expenseId };
  });
}

/** ZERO writes: generation untouched and the seeded reset-table row still there. */
async function expectNoWrites(
  t: Harness,
  seed: { orgId: Id<"organizations">; expenseId: Id<"expenses"> },
  expected: { generation: number | undefined; completed: number | undefined }
) {
  const org = await t.run((ctx) => ctx.db.get(seed.orgId));
  expect(org?.financialResetGeneration).toBe(expected.generation);
  expect(org?.financialResetCompletedGeneration).toBe(expected.completed);
  expect(await t.run((ctx) => ctx.db.get(seed.expenseId))).not.toBeNull();
}

describe("SCRUM-565 S1a — destructive reset gate", () => {
  test("1. a destructive FRESH run on a suspended, otherwise clean org refuses", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const seed = await seedResetOrg(t, { suspended: true });
    await expectAppError(
      t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: seed.orgId, dryRun: false }),
      GATE_CODE,
      GATE_MESSAGE
    );
    await expectNoWrites(t, seed, { generation: undefined, completed: undefined });
  });

  test("2. a destructive CONTINUATION (generation 1, completed 0) refuses too", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const seed = await seedResetOrg(t, {
      suspended: true,
      financialResetGeneration: 1,
      financialResetCompletedGeneration: 0,
    });
    await expectAppError(
      t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: seed.orgId, dryRun: false }),
      GATE_CODE,
      GATE_MESSAGE
    );
    await expectNoWrites(t, seed, { generation: 1, completed: 0 });
  });

  test("3. a dry run still succeeds, counts as before, and reports the protocol state", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const seed = await seedResetOrg(t, { suspended: true });
    const result = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: seed.orgId });
    expect(result.dryRun).toBe(true);
    expect(result.total).toBe(1);
    expect(result.perTable.expenses).toBe(1);
    expect(result.protocolComplete).toBe(false);
    expect(result.protocolVersion).toBe(1);
    await expectNoWrites(t, seed, { generation: undefined, completed: undefined });
  });

  test("4. the gate refuses BEFORE the SCRUM-559 suspension refusal", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const seed = await seedResetOrg(t, { suspended: false });
    await expectAppError(
      t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: seed.orgId, dryRun: false }),
      GATE_CODE,
      GATE_MESSAGE
    );
    await expectNoWrites(t, seed, { generation: undefined, completed: undefined });
  });

  test("5. the gate precedes the org read: a destructive call on a deleted org refuses with the gate error", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const seed = await seedResetOrg(t, { suspended: true });
    await t.run((ctx) => ctx.db.delete(seed.orgId));
    await expectAppError(
      t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: seed.orgId, dryRun: false }),
      GATE_CODE,
      GATE_MESSAGE
    );
  });
});

describe("SCRUM-565 S1a — EN/AR parity", () => {
  test("6. RESET_PROTOCOL_INCOMPLETE has English and Arabic text matching the brief exactly", async () => {
    const { dictionaries } = await import("../lib/i18n/dictionaries");
    const en = dictionaries.en as Record<string, string>;
    const ar = dictionaries.ar as Record<string, string>;
    expect(en.ServerError_RESET_PROTOCOL_INCOMPLETE).toBe(GATE_MESSAGE);
    expect(en.ServerError_RESET_PROTOCOL_INCOMPLETE).toBe(RESET_PROTOCOL_INCOMPLETE_MESSAGE);
    expect(ar.ServerError_RESET_PROTOCOL_INCOMPLETE).toBe(GATE_MESSAGE_AR);
  });
});
