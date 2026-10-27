import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FunctionArgs, FunctionReference } from "convex/server";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { runRehearsalCases } from "../scripts/accountingRehearsalCases.mjs";
import { runUnwindRehearsalCases } from "../scripts/accountingUnwindRehearsal.mjs";
import { recordCase, unproven } from "../scripts/accountingPreviewRehearsal.mjs";

/**
 * Local harness for the registered CC-CASH callback and the customer-credit payout refusal inside U-RET
 * (SCRUM-486 / SCRUM-760). Every command and query really executes through the public Convex handlers in
 * convex-test; only the SDK readback boundary is corrupted for the controls. This is a HARNESS: it is not a
 * Convex platform run, so it proves the callbacks are correct by construction against the real handlers and
 * proves nothing about the cloud deployment itself.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 9, 15, 12));
});
afterEach(() => vi.useRealTimers());

type Defect = "payout-accepted" | "payout-wrong-code" | "cc-missing-inventory-leg" | "cc-stale-cost" | "cc-sold-accepted"
  | "cc-extra-balance-pair" | "cc-extra-journal-entry";

async function execute(wanted: "U-RET" | "CC-CASH", defect?: Defect) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  registerRateLimiter(t);
  await t.run(async ctx => {
    await ctx.db.insert("users", { clerkId: "cc-primary", email: "primary@qa.example.test" });
    await ctx.db.insert("users", { clerkId: "cc-approver", email: "approver@qa.example.test" });
  });
  const primary = t.withIdentity({ subject: "cc-primary" });
  const approver = t.withIdentity({ subject: "cc-approver" });
  const refs = api as unknown as Record<string, Record<string, FunctionReference<"query" | "mutation">>>;
  const calls: string[] = [];
  // Set once the CC-CASH sale has really been created: only the post-sale readbacks are corrupted by the
  // extra-posting controls, so every earlier gate of the case still runs on honest data.
  let saleCreated = false;
  const chartCodes = new Map<string, unknown>();
  const must = (actor: typeof primary) => async (kind: "query" | "mutation", name: string, args: Record<string, unknown>) => {
    calls.push(name);
    // Control: a payout request is refused with a DIFFERENT machine code whose message merely mentions the pilot
    // code. The real command is not run; the refusal wrongly looks right to a text-only matcher.
    if (defect === "payout-wrong-code" && name === "dealUnwind:finishDealUnwind" && args.customerRefundMethod !== undefined) {
      throw Object.assign(new Error("synthetic wrong-code refusal"), {
        data: { code: "FORBIDDEN", message: "Not permitted. (CUSTOMER_CREDIT_PAYOUT_DISABLED is mentioned but is not the code)" },
      });
    }
    // Control: a customer-credit payout request is accepted without running the command.
    if (defect === "payout-accepted" && name === "dealUnwind:finishDealUnwind" && args.customerRefundMethod !== undefined) {
      return "synthetic-accepted";
    }
    // Control: the correction of the SOLD car is accepted without running the command.
    if (defect === "cc-sold-accepted" && name === "vehicles:correctAcquisitionCost" && args.newCost === 9000) {
      return { previousCost: 9800, newCost: 9000 };
    }
    const [module, method] = name.split(":");
    const ref = refs[module][method];
    const result = kind === "mutation"
      ? await actor.mutation(ref as FunctionReference<"mutation">, args as FunctionArgs<FunctionReference<"mutation">>)
      : await actor.query(ref as FunctionReference<"query">, args as FunctionArgs<FunctionReference<"query">>);
    // Only the SDK readback boundary is corrupted below. Every underlying command/query really executed.
    if (name === "sales:create") saleCreated = true;
    if (name === "chartOfAccounts:list") {
      for (const row of result as Array<{ _id: unknown; code: string }>) chartCodes.set(row.code, row._id);
    }
    // Control: after the sale the books carry a balance-sheet-only pair (Dr 2220 / Cr 1110, 1.000 JOD) that none of
    // the six named accounts shows. Only a whole-chart comparison can see it.
    if (defect === "cc-extra-balance-pair" && saleCreated && name === "accountingReports:trialBalance") {
      const copy = structuredClone(result) as { rows: Array<Record<string, unknown>> };
      copy.rows.push({ accountId: chartCodes.get("2220"), code: "2220", currency: "JOD", netMinor: -1000 });
      copy.rows.push({ accountId: chartCodes.get("1110"), code: "1110", currency: "JOD", netMinor: -1000 });
      return copy;
    }
    // Control: after the sale the journal census holds one extra, balanced entry that nets to zero everywhere.
    if (defect === "cc-extra-journal-entry" && saleCreated && name === "accountingLedger:listJournalEntries") {
      const copy = structuredClone(result) as { isDone: boolean; page: Array<Record<string, unknown>> };
      if (copy.isDone) copy.page.push({ _id: "synthetic-extra-balanced-entry", sourceType: "manualJournal" });
      return copy;
    }
    if (defect === "cc-stale-cost" && name === "vehicles:get" && (result as { purchasePrice?: number } | null)?.purchasePrice === 9800) {
      return { ...(result as object), purchasePrice: 12500 };
    }
    if (defect === "cc-missing-inventory-leg" && name === "accountingLedger:getJournalEntry") {
      const copy = structuredClone(result) as { entry: { sourceType: string }; lines: Array<Record<string, unknown>> };
      if (copy.entry.sourceType === "vehicleCostCorrections") {
        copy.lines = copy.lines.filter(line => line.creditMinor !== 2700000);
        return copy;
      }
    }
    return result;
  };
  const salesMust = must(primary), approverMust = must(approver);
  const orgId = await salesMust("mutation", "organizations:create", { name: "QA TEST CC-CASH control" });
  // Shaped like the live HTTP boundary (`convexCall`): the refusal's own message text plus its machine code.
  // The throwing `*Must` wrappers on a live deployment carry the message only, never the code.
  const soft = (hard: ReturnType<typeof must>) => async (kind: "query" | "mutation", name: string, args: Record<string, unknown>) => {
    try { return { ok: true, value: await hard(kind, name, args) }; }
    catch (error) {
      const data = (error as { data?: { code?: unknown; message?: unknown } }).data;
      return { ok: false, error: String(data?.message ?? error), ...(typeof data?.code === "string" ? { errorCode: data.code } : {}) };
    }
  };
  const asSales = soft(salesMust), asApprover = soft(approverMust);
  const results: Array<{ id: string; status: string; detail?: unknown }> = [];
  // U-RET is its own callback: the trusted driver runs it after the cleanup cases, not inside runRehearsalCases (SCRUM-486).
  const run = wanted === "U-RET" ? runUnwindRehearsalCases : runRehearsalCases;
  await run({ orgId, results, salesMust, approverMust, asSales, asApprover, config: {
    salesEmail: "primary@qa.example.test", approverEmail: "approver@qa.example.test",
  }, unproven, recordCase: async (rows: unknown[], id: string, title: string, body: () => Promise<unknown>) => {
    // This slice selects one registered callback; it does not certify the full registry.
    if (id === wanted) await recordCase(rows, id, title, body);
  } });
  return { result: results.find(row => row.id === wanted), calls };
}

test("registered CC-CASH callback lowers an unsold car's cost, inventory and cash together and refuses a sold car, in the harness", async () => {
  const proof = await execute("CC-CASH");
  expect(proof.result, JSON.stringify(proof.result)).toMatchObject({ id: "CC-CASH", status: "PASS" });
  expect(proof.calls).toContain("vehicles:correctAcquisitionCost");
  expect(proof.calls).toContain("vehicles:getAcquisitionCostCorrectionContext");
}, 60000);

test.each([
  ["cc-missing-inventory-leg", "journal lines are not exactly the expected posting"],
  ["cc-stale-cost", "CC-CASH corrected vehicle cost"],
  ["cc-sold-accepted", "CC-CASH sold-car correction"],
  ["cc-extra-balance-pair", "CC-CASH the sale moves only the expected accounts across the whole chart"],
  ["cc-extra-journal-entry", "CC-CASH unexpected journal entry after the sale: added journal entry count"],
] as const)("CC-CASH SDK %s cannot pass the public evidence oracle", async (defect, reason) => {
  const proof = await execute("CC-CASH", defect);
  expect(proof.result).toMatchObject({ id: "CC-CASH", status: "FAIL" });
  expect(proof.result?.detail).toContain(reason);
}, 60000);

test("U-RET refuses every customer-credit payout request with the pilot code and nothing changed; an accepted payout cannot pass", async () => {
  const green = await execute("U-RET");
  expect(green.result, JSON.stringify(green.result)).toMatchObject({ id: "U-RET", status: "PASS" });
  // The refusal is exercised with real handlers, three ways, before the finishing step.
  expect(green.calls.filter(name => name === "dealUnwind:finishDealUnwind").length).toBeGreaterThanOrEqual(4);
  const attacked = await execute("U-RET", "payout-accepted");
  expect(attacked.result).toMatchObject({ id: "U-RET", status: "FAIL" });
  expect(attacked.result?.detail).toContain("CUSTOMER_CREDIT_PAYOUT_DISABLED");
}, 120000);

test("U-RET payout refusal with a different machine code cannot pass on a message that merely mentions the pilot code", async () => {
  const attacked = await execute("U-RET", "payout-wrong-code");
  expect(attacked.result).toMatchObject({ id: "U-RET", status: "FAIL" });
  expect(attacked.result?.detail).toContain("U-RET missing or wrong refusal: CUSTOMER_CREDIT_PAYOUT_DISABLED");
}, 120000);
