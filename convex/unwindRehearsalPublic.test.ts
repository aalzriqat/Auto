import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FunctionArgs, FunctionReference } from "convex/server";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { runRehearsalCases } from "../scripts/accountingRehearsalCases.mjs";
import { recordCase, unproven } from "../scripts/accountingPreviewRehearsal.mjs";

beforeEach(() => {
  // A deterministic harness date, not elapsed time or a platform clock change.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 9, 15, 12));
});
afterEach(() => vi.useRealTimers());

type Defect = "missing-reversal" | "duplicate-reversal" | "bank-attribution" | "stale-trial" | "invoice-attribution" | "role-overgrant";
async function execute(defect?: Defect) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  registerRateLimiter(t);
  await t.run(async ctx => {
    await ctx.db.insert("users", { clerkId: "unwind-primary", email: "primary@qa.example.test" });
    await ctx.db.insert("users", { clerkId: "unwind-approver", email: "approver@qa.example.test" });
  });
  const primary = t.withIdentity({ subject: "unwind-primary" });
  const approver = t.withIdentity({ subject: "unwind-approver" });
  const refs = api as unknown as Record<string, Record<string, FunctionReference<"query" | "mutation">>>;
  const calls: string[] = [];
  const chart = new Map<unknown, Map<unknown, unknown>>(), priorTrial = new Map<unknown, unknown>();
  let completedOrg: unknown;
  const must = (actor: typeof primary) => async (kind: "query" | "mutation", name: string, args: Record<string, unknown>) => {
    calls.push(name);
    const [module, method] = name.split(":");
    const ref = refs[module][method];
    const result = kind === "mutation" ? await actor.mutation(ref as FunctionReference<"mutation">, args as FunctionArgs<FunctionReference<"mutation">>)
      : await actor.query(ref as FunctionReference<"query">, args as FunctionArgs<FunctionReference<"query">>);
    if (name === "chartOfAccounts:list") chart.set(args.orgId,
      new Map((result as Array<Record<string, unknown>>).map(row => [row._id, row.code])));
    if (name === "accountingReports:trialBalance" && !priorTrial.has(args.orgId)) priorTrial.set(args.orgId, structuredClone(result));
    if (name === "dealUnwind:finishDealUnwind" && completedOrg === undefined) completedOrg = args.orgId;
    // Only the SDK readback boundary is corrupted. Every underlying command/query really executes.
    if (defect === "role-overgrant" && name === "memberships:getMyMembership") {
      const role = result as { roleName?: string; permissions: string[] };
      if (role.roleName?.startsWith("QA TEST U-RET")) return { ...role,
        permissions: [...role.permissions, "cancel:closed_deal", "confirm:finance_disbursement"] };
    }
    if (kind === "query" && args.orgId === completedOrg) {
      if (defect === "stale-trial" && name === "accountingReports:trialBalance") return structuredClone(priorTrial.get(args.orgId));
      if (defect === "invoice-attribution" && name === "subledger:getReceivableBalance") {
        const copy = structuredClone(result) as { doc: Record<string, unknown> };
        copy.doc.financeCompanyId = "synthetic-sdk-wrong-financier";
        return copy;
      }
      if (name === "accountingLedger:getJournalEntry") {
        const copy = structuredClone(result) as { entry: { status: string }; lines: Array<Record<string, unknown>> };
        const index = copy.lines.findIndex(line => line.creditMinor === 12500000 && chart.get(args.orgId)?.get(line.accountId) === "1110");
        if (copy.entry.status === "POSTED" && index >= 0) {
          if (defect === "missing-reversal") copy.lines.splice(index, 1);
          if (defect === "duplicate-reversal") copy.lines.push({ ...copy.lines[index] });
          if (defect === "bank-attribution") copy.lines[index].bankAccountId = "synthetic-sdk-wrong-bank";
          return copy;
        }
      }
    }
    return result;
  };
  const salesMust = must(primary), approverMust = must(approver);
  const orgId = await salesMust("mutation", "organizations:create", { name: "QA TEST U-RET control" });
  const asSales = async (kind: "query" | "mutation", name: string, args: Record<string, unknown>) => {
    try { return { ok: true, value: await salesMust(kind, name, args) }; }
    catch (error) {
      // Shaped like the live HTTP boundary (`convexCall`): the refusal's own message text plus its machine code.
      // The throwing `*Must` wrappers on a live deployment carry the message only, never the code.
      const data = (error as { data?: { code?: unknown; message?: unknown } }).data;
      return { ok: false, error: String(data?.message ?? error), ...(typeof data?.code === "string" ? { errorCode: data.code } : {}) };
    }
  };
  const asApprover = async (kind: "query" | "mutation", name: string, args: Record<string, unknown>) => {
    try { return { ok: true, value: await approverMust(kind, name, args) }; }
    catch (error) {
      const data = (error as { data?: { code?: unknown; message?: unknown } }).data;
      return { ok: false, error: String(data?.message ?? error), ...(typeof data?.code === "string" ? { errorCode: data.code } : {}) };
    }
  };
  const results: Array<{ id: string; status: string; detail?: unknown }> = [];
  await runRehearsalCases({ orgId, results, salesMust, approverMust, asSales, asApprover, config: {
    salesEmail: "primary@qa.example.test", approverEmail: "approver@qa.example.test",
  }, unproven, recordCase: async (rows: unknown[], id: string, title: string, body: () => Promise<unknown>) => {
    // This slice selects the registered callback; it does not certify the full registry.
    if (id === "U-RET") await recordCase(rows, id, title, body);
  } });
  const proof = { result: results.find(row => row.id === "U-RET"), calls };
  const retained = process.env.AUTOFLOW_URET_PROOF_DIR;
  if (retained) {
    // Loaded only when proof retention is requested; this is a vitest file, never deployed to the Convex runtime.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    mkdirSync(retained, { recursive: true });
    writeFileSync(path.join(retained, `${defect ?? "positive"}.json`), JSON.stringify({
      scope: "LOCAL_CONVEX_TEST_PUBLIC_HANDLERS", nativeCloud: "UNAVAILABLE", ...proof,
    }, null, 2));
  }
  return proof;
}

test("registered U-RET callback executes public unwind and reconciles literal witnesses in the harness", async () => {
  const proof = await execute();
  expect(proof.result, JSON.stringify(proof.result)).toMatchObject({ id: "U-RET", status: "PASS" });
  expect(proof.calls).toContain("dealUnwind:startDealUnwind");
  expect(proof.calls).toContain("dealUnwind:recordDealUnwindForwardReturn");
  expect(proof.calls).toContain("dealUnwind:finishDealUnwind");
}, 30000);

test.each([
  ["missing-reversal", "literal journal multiset"],
  ["duplicate-reversal", "literal journal multiset"],
  ["bank-attribution", "bank-line attribution"],
  ["stale-trial", "literal public trial balance"],
  ["invoice-attribution", "invoice financier attribution"],
  ["role-overgrant", "denied capability absent"],
] as const)("U-RET SDK %s cannot pass the public financial evidence oracle", async (defect, reason) => {
  const proof = await execute(defect);
  expect(proof.result).toMatchObject({ id: "U-RET", status: "FAIL" });
  expect(proof.result?.detail).toContain(reason);
  if (defect !== "role-overgrant") expect(proof.calls).toContain("dealUnwind:finishDealUnwind");
}, 30000);
