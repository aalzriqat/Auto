import { afterEach, expect, test, vi } from "vitest";
import type { FunctionArgs, FunctionReference } from "convex/server";
import {
  convexTestWithComponents,
  registerRateLimiter,
} from "../test-utils/convexTest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import {
  recordCase,
  unproven,
  summarize,
} from "../scripts/accountingPreviewRehearsal.mjs";
import { runOpeningRehearsalCases } from "../scripts/accountingOpeningRehearsal.mjs";

// Only authentication identities are inserted. Every organization, authority seat,
// chart, period, source, opening and settlement uses its actual public handler.
type Defect =
  | "source"
  | "target"
  | "amount"
  | "recoverable-amount"
  | "expense"
  | "payroll"
  | "management"
  | "credit"
  | "identity"
  | "current-scheduled"
  | "current-total"
  | "current-month"
  | "current-journal"
  | "current-cash"
  | "current-bank"
  | "current-bank-cache"
  | "current-bank-cutoff"
  | "current-prepaid"
  | "current-partner"
  | "refusal";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function execute(defect?: Defect) {
  // Only this SDK-cache control models elapsed time in the serial harness. It is not platform caching proof.
  const modelCache = defect === "current-bank-cache" || defect === "current-bank-cutoff";
  const now = new Date();
  let modeledTime = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12);
  if (modelCache) vi.spyOn(Date, "now").mockImplementation(() => modeledTime);
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  registerRateLimiter(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkId: "cloud-opening-primary",
      email: "primary@qa.example.test",
    });
    await ctx.db.insert("users", {
      clerkId: "cloud-opening-approver",
      email: "approver@qa.example.test",
    });
  });
  const primary = t.withIdentity({ subject: "cloud-opening-primary" });
  const approver = t.withIdentity({ subject: "cloud-opening-approver" });
  const refs = api as unknown as Record<
    string,
    Record<string, FunctionReference<"query" | "mutation">>
  >;
  type Row = Record<string, unknown>;
  const calls: string[] = [];
  let currentOrg: unknown, currentPlan: unknown;
  let currentApproved = false;
  const bankCache = new Map<string, unknown>();
  let firstBankResponse: unknown;
  const adapter =
    (actor: typeof primary) =>
    async (
      kind: "query" | "mutation",
      name: string,
      args: Row,
    ): Promise<unknown> => {
      const [module, method] = name.split(":");
      const reference = refs[module][method];
      calls.push(name);
      const bankCacheKey = JSON.stringify([name, args]);
      if (defect === "current-bank-cutoff" && name === "bankAccounts:getBookBalance" &&
        typeof args.asOf === "number" && firstBankResponse !== undefined)
        return structuredClone(firstBankResponse);
      if (modelCache && name === "bankAccounts:getBookBalance" && bankCache.has(bankCacheKey))
        return structuredClone(bankCache.get(bankCacheKey));
      if (modelCache && name === "openingManagementSettlement:draftFromObservation" && args.supportingReference === "QA TEST current management classification")
        modeledTime += 1;
      if (
        defect === "refusal" &&
        name === "payroll:payRun" &&
        calls.filter((value) => value === name).length === 2
      )
        throw new Error(
          "Synthetic transport failure, not the required business refusal",
        );
      const result: unknown = await (kind === "query"
        ? actor.query(reference as FunctionReference<"query">, args)
        : actor.mutation(reference as FunctionReference<"mutation">, args));
      if (modelCache && name === "bankAccounts:getBookBalance") {
        bankCache.set(bankCacheKey, structuredClone(result));
        firstBankResponse ??= structuredClone(result);
      }
      if (name === "openingManagementSettlement:draftFromObservation" && args.supportingReference === "QA TEST current management classification") {
        currentOrg = args.orgId;
        currentPlan = result;
      }
      if (name === "openingManagementSettlement:approve" && args.planId === currentPlan)
        currentApproved = true;
      if (currentApproved && args.orgId === currentOrg) {
        const value = structuredClone(result) as Row;
        if (name === "openingManagementSettlement:report") {
          if (defect === "current-scheduled") return { ...value,
            installments: (value.installments as Row[]).map(item => ({ ...item, recognition: "SCHEDULED" })) };
          if (defect === "current-total") return { ...value, recognisedMinor: 14287 };
        }
        if (defect === "current-month" && name === "openingManagementSettlement:list") {
          const plans = value as unknown as Row[];
          plans[0].approvedAt = Date.UTC(2020, 0, 1);
          return plans;
        }
        if (defect === "current-journal" && name === "accountingLedger:getJournalEntry") {
          (value.lines as Row[])[0].debitMinor = Number((value.lines as Row[])[0].debitMinor) + 1;
          return value;
        }
        if (defect === "current-cash" && name === "cashDrawer:list") {
          const sessions = value as unknown as Row[];
          sessions[0].openingFloatMinor = 1000001;
          return sessions;
        }
        if (defect === "current-bank" && name === "bankAccounts:getBookBalance") return { ...value, balanceMinor: 500001 };
        if (defect === "current-prepaid" && name === "prepaidExpenses:listSchedules") {
          const schedules = value as unknown as Row[];
          schedules[0].totalMinor = 70004;
          return schedules;
        }
        if (defect === "current-partner" && name === "partnerEquity:list") {
          (value.page as Row[])[0].balanceMinor = 1000001;
          return value;
        }
      }
      // Corrupt only the SDK response boundary. Actual handlers and economic writes
      // remain unchanged: these controls prove the cloud assertions detect defects.
      if (defect === "identity" && name === "users:getMe") return null;
      if (
        defect === "source" &&
        name === "accountingCutover:postedOpeningAllocationReadback"
      ) {
        const value = structuredClone(result) as { rows: Row[] };
        value.rows[0].recordAvailable = false;
        return value;
      }
      if (
        (defect === "target" || defect === "amount") &&
        name === "accountingLedger:getJournalEntry"
      ) {
        const value = structuredClone(result) as { lines: Row[] };
        if (defect === "target") value.lines[0].accountId = "wrong-sdk-control";
        else value.lines[0].debitMinor = Number(value.lines[0].debitMinor) + 1;
        return value;
      }
      if (defect === "expense" && name === "expenses:list")
        return { page: [{ _id: "fake-expense" }], isDone: true };
      if (defect === "recoverable-amount" && name === "supplierCostRecoveries:list") {
        const value = structuredClone(result) as { items: Row[] };
        value.items[0].amountDueMinor = "11001";
        return value;
      }
      if (defect === "payroll" && name === "payroll:listRunItems") {
        const value = structuredClone(result) as Row[];
        value[0].netMinor = 20003;
        return value;
      }
      if (
        defect === "management" &&
        name === "openingManagementSettlement:report"
      )
        return { ...(result as Row), recognisedMinor: 1 };
      if (defect === "credit" && name === "collections:listRetainedCredits") {
        const value = structuredClone(result) as { page: Row[] };
        value.page[0].remainingUnappliedMinor = 45001;
        return value;
      }
      return result;
    };
  const salesMust = adapter(primary),
    approverMust = adapter(approver);
  const orgId = await primary.mutation(api.organizations.create, {
    name: "QA TEST original rehearsal organization",
  });
  await primary.mutation(api.chartOfAccounts.initialize, { orgId });
  const results: { id: string; status: string; detail: unknown }[] = [];
  await runOpeningRehearsalCases({
    orgId,
    results,
    config: {
      salesEmail: "primary@qa.example.test",
      approverEmail: "approver@qa.example.test",
    },
    salesMust,
    approverMust,
    recordCase,
    unproven,
  });
  return { t, results, calls };
}

test("registered opening cloud callbacks execute all native public handlers and containment", async () => {
  const { results } = await execute();
  expect(results, JSON.stringify(results)).toEqual([
    expect.objectContaining({
      id: "S858-OPENING",
      status: "PASS",
      detail: expect.objectContaining({
        allocations: 12,
        closedSnapshotCompared: true,
      }),
    }),
    expect.objectContaining({
      id: "S858-CONTAINMENT",
      status: "PASS",
      detail: expect.objectContaining({
        twoPersonApproval: true,
        managementLedgerUnchanged: true,
        refusedCommandsLedgerUnchanged: true,
      }),
    }),
  ]);
}, 30000);

test("current-month opening management recognition preserves native books", async () => {
  const { results } = await execute();
  expect(results.find(value => value.id === "S858-CONTAINMENT")).toMatchObject({
    status: "PASS", detail: {
      currentManagement: {
        recognisedMinor: 14286, managementProfitMinor: -14286, distributionAvailable: false,
      },
    },
  });
}, 30000);

test("current recognition requests the approval cutoff instead of replaying same arguments", async () => {
  const { results } = await execute("current-bank-cache");
  expect(results.find(value => value.id === "S858-CONTAINMENT"), JSON.stringify(results)).toMatchObject({
    status: "PASS", detail: { currentManagement: { recognisedMinor: 14286, managementProfitMinor: -14286 } },
  });
}, 30000);

test.each([
  ["source", "S858-OPENING", "actual source available"],
  ["refusal", "S858-OPENING", "unexpected refusal"],
  ["target", "S858-OPENING", "one exact selected control line"],
  ["amount", "S858-OPENING", "opening debit"],
  ["recoverable-amount", "S858-OPENING", "Opening minor-unit readback unavailable"],
  ["expense", "S858-OPENING", "no fake sale or expense"],
  ["payroll", "S858-OPENING", "native payroll netMinor"],
  ["management", "S858-CONTAINMENT", "future management recognition zero"],
  ["credit", "S858-CONTAINMENT", "identified receipt denomination"],
] as const)(
  "native cloud assertions refuse SDK %s corruption",
  async (defect, id, reason) => {
    const { results } = await execute(defect);
    expect(results.find((value) => value.id === id)).toMatchObject({
      status: "FAIL",
      detail: expect.stringContaining(reason),
    });
    expect(summarize(results).complete).toBe(false);
  },
  30000,
);

test.each([
  ["current-scheduled", "exact first management recognition"],
  ["current-total", "current management recognised amount"],
  ["current-month", "no rollover or clock mismatch"],
  ["current-journal", "current management native books unchanged"],
  ["current-cash", "management physical cash float"],
  ["current-bank", "management physical bank balance"],
  ["current-bank-cutoff", "management bank cutoff matches request"],
  ["current-prepaid", "current management native books unchanged"],
  ["current-partner", "management partner balance"],
] as const)("current recognition refuses SDK %s corruption", async (defect, reason) => {
  const { results } = await execute(defect);
  expect(results.find(value => value.id === "S858-CONTAINMENT")).toMatchObject({
    status: "FAIL", detail: expect.stringContaining(reason),
  });
  expect(summarize(results).complete).toBe(false);
}, 30000);

test("missing authentic QA identity fails before fixture writes and leaves containment UNPROVEN", async () => {
  const { results, calls } = await execute("identity");
  expect(calls).not.toContain("memberships:add");
  expect(calls).not.toContain("accountingCutover:postOpeningBalanceDirect");
  expect(results.map((value) => value.status)).toEqual(["FAIL", "UNPROVEN"]);
  expect(summarize(results)).toMatchObject({
    total: 2,
    passed: 0,
    failed: 1,
    unproven: 1,
    complete: false,
  });
});

test("existing-member notification uses the native preview sink before any provider network", async () => {
  vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "preview");
  vi.stubEnv("CONVEX_CLOUD_URL", "https://qa-opening-rehearsal.convex.cloud");
  vi.stubEnv("CLERK_JWT_ISSUER_DOMAIN", "https://qa.example.test");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://qa.example.test");
  vi.stubEnv("RESEND_API_KEY", "re_synthetic_tripwire_not_a_credential");
  const network = vi.fn(() => {
    throw new Error("Synthetic egress tripwire: provider must not be called");
  });
  vi.stubGlobal("fetch", network);
  const { t, results } = await execute();
  expect(results.map((value) => value.status)).toEqual(["PASS", "PASS"]);
  const pending = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  const notifications = pending.filter((value) =>
    value.name.includes("email:sendNotificationEmail"),
  );
  expect(notifications.length).toBeGreaterThan(0);
  for (const notification of notifications) {
    const args = notification.args[0] as FunctionArgs<
      typeof internal.email.sendNotificationEmail
    >;
    const response = await t.action(internal.email.sendNotificationEmail, args);
    expect(response).toMatchObject({ success: true });
  }
  expect(network).not.toHaveBeenCalled();
}, 30000);

test("registered opening containment callback requires authentic positive fixture and preserves held pools", async () => {
  const { results } = await execute();
  expect(
    results.map((value) => value.status),
    JSON.stringify(results),
  ).toEqual(["PASS", "PASS"]);
  expect(results[1]).toMatchObject({
    id: "S858-CONTAINMENT",
    detail: expect.objectContaining({
      unknownPools: "UNALLOCATED",
      payoutRefused: true,
      twoPersonApproval: true,
      managementLedgerUnchanged: true,
      refusedCommandsLedgerUnchanged: true,
    }),
  });
}, 30000);
