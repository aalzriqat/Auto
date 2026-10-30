// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { runPilotRouteRehearsalCases } from "../scripts/accountingUnwindRehearsal.mjs";
import { recordCase, unproven } from "../scripts/accountingPreviewRehearsal.mjs";
import schema from "./schema";
import { api } from "./_generated/api";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 9, 15, 12));
});
afterEach(() => vi.useRealTimers());

const HELD_IDS = ["CANCEL-SALE", "CANCEL-CLOSED", "RESTORE-HELD"] as const;
const IDS = [...HELD_IDS, "RETURN-FC-CHEQUE"] as const;
type CaseId = typeof IDS[number];

/** Run the registered cloud callbacks through real public handlers in convex-test.
 * This checks callback construction, not platform, OCC, production or browser behavior.
 */
// Literal test titles bind one regression record per cell; the shared bodies keep the same assertions.
type Fault = "held" | "bank" | "debt" | "payment" | "allocations" | "settlement";
async function execute(wanted: CaseId, fault?: Fault) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  registerRateLimiter(t);
  await t.run(async ctx => {
    await ctx.db.insert("users", { clerkId: "rt11-primary", email: "primary@qa.example.test" });
    await ctx.db.insert("users", { clerkId: "rt11-approver", email: "approver@qa.example.test" });
  });
  const refs = api as unknown as Record<string, Record<string, FunctionReference<"query" | "mutation">>>;
  let didReturn = false;
  const makeMust = (actor: ReturnType<typeof t.withIdentity>) =>
    async (kind: "query" | "mutation", path: string, args: Record<string, unknown>): Promise<unknown> => {
      const [module, name] = path.split(":");
      const result: unknown = kind === "query"
        ? await actor.query(refs[module][name] as FunctionReference<"query">, args)
        : await actor.mutation(refs[module][name] as FunctionReference<"mutation">, args);
      // Readback fault control: retaining the wrong paid amount must fail even with balanced journals.
      if (fault === "held" && path === "deposits:listByVehicle" && Array.isArray(result)) {
        return result.map((row: Record<string, unknown>) => row.status === "HELD" ? { ...row, amount: 0 } : row);
      }
      // Only corrupt the AFTER-return readback, so fixture preconditions remain genuine.
      if (path === "applications:returnFinanceDisbursementCheque") didReturn = true;
      if (didReturn) {
        if (fault === "allocations" && path === "subledger:listAllocations" && Array.isArray(result)) {
          return result.map((row: Record<string, unknown>) => ({ ...row, status: "ACTIVE" }));
        }
        if (result && typeof result === "object" && !Array.isArray(result)) {
          if (fault === "bank" && path === "bankAccounts:getBookBalance") return { ...result, balanceMinor: 1 };
          if (fault === "debt" && path === "subledger:getReceivableBalance") return { ...result, outstandingMinor: 0 };
          if (fault === "payment" && path === "subledger:getPaymentBalance" && "payment" in result) {
            return { ...result, payment: { ...(result.payment as Record<string, unknown>), status: "SETTLED" } };
          }
          if (fault === "settlement" && path === "applications:get") return { ...result, settlementStatus: "RECEIVED" };
        }
      }
      return result;
    };
  const salesMust = makeMust(t.withIdentity({ subject: "rt11-primary" }));
  const approverMust = makeMust(t.withIdentity({ subject: "rt11-approver" }));
  const soft = (must: typeof salesMust) => async (kind: "query" | "mutation", name: string, args: Record<string, unknown>) => {
    try { return { ok: true, value: await must(kind, name, args) }; }
    catch (error) {
      const data = (error as { data?: { code?: string; message?: string } }).data;
      return { ok: false, error: data?.message ?? String(error), errorCode: data?.code };
    }
  };
  const results: Array<{ id: string; status: string; detail?: string }> = [];
  await runPilotRouteRehearsalCases({
    results, salesMust, approverMust, asSales: soft(salesMust), asApprover: soft(approverMust),
    config: { salesEmail: "primary@qa.example.test", approverEmail: "approver@qa.example.test" }, unproven,
    recordCase: async (rows: unknown[], id: string, title: string, body: () => Promise<unknown>) => {
      if (id === wanted) await recordCase(rows, id, title, body);
    },
  });
  expect(results).toHaveLength(1);
  return results[0];
}

async function checkRegisteredCallback(id: "CANCEL-SALE" | "CANCEL-CLOSED" | "RESTORE-HELD" | "RETURN-FC-CHEQUE") {
  const result = await execute(id);
  expect(result, JSON.stringify(result)).toMatchObject({ id, status: "PASS" });
}
test("registered CANCEL-SALE preserves literal journals, subledger debt and paid funds in the harness", () => checkRegisteredCallback("CANCEL-SALE"), 60_000);
test("registered CANCEL-CLOSED preserves literal journals, subledger debt and paid funds in the harness", () => checkRegisteredCallback("CANCEL-CLOSED"), 60_000);
test("registered RESTORE-HELD preserves literal journals, subledger debt and paid funds in the harness", () => checkRegisteredCallback("RESTORE-HELD"), 60_000);
test("registered RETURN-FC-CHEQUE preserves literal journals, subledger debt and paid funds in the harness", () => checkRegisteredCallback("RETURN-FC-CHEQUE"), 60_000);

async function checkHeldDepositWitness(id: "CANCEL-SALE" | "CANCEL-CLOSED" | "RESTORE-HELD") {
  const result = await execute(id, "held");
  expect(result).toMatchObject({ id, status: "FAIL" });
  expect(result.detail).toMatch(/amount|survives/);
}
test("CANCEL-SALE cannot certify a zeroed held-deposit amount despite balanced books", () => checkHeldDepositWitness("CANCEL-SALE"), 60_000);
test("CANCEL-CLOSED cannot certify a zeroed held-deposit amount despite balanced books", () => checkHeldDepositWitness("CANCEL-CLOSED"), 60_000);
test("RESTORE-HELD cannot certify a zeroed held-deposit amount despite balanced books", () => checkHeldDepositWitness("RESTORE-HELD"), 60_000);

async function checkFinanceReturnWitness(fault: "bank" | "debt" | "payment" | "allocations" | "settlement", label: string) {
  const result = await execute("RETURN-FC-CHEQUE", fault);
  expect(result).toMatchObject({ id: "RETURN-FC-CHEQUE", status: "FAIL" });
  expect(result.detail).toContain(label);
}
test("RETURN-FC-CHEQUE refuses a corrupt bank witness after the return", () => checkFinanceReturnWitness("bank", "native bank balance"), 60_000);
test("RETURN-FC-CHEQUE refuses a corrupt debt witness after the return", () => checkFinanceReturnWitness("debt", "literal collectible financier receivable"), 60_000);
test("RETURN-FC-CHEQUE refuses a corrupt payment witness after the return", () => checkFinanceReturnWitness("payment", "RETURN-FC-CHEQUE payment voided"), 60_000);
test("RETURN-FC-CHEQUE refuses a corrupt allocations witness after the return", () => checkFinanceReturnWitness("allocations", "RETURN-FC-CHEQUE allocations reversed in full"), 60_000);
test("RETURN-FC-CHEQUE refuses a corrupt settlement witness after the return", () => checkFinanceReturnWitness("settlement", "RETURN-FC-CHEQUE settlement reopened"), 60_000);
