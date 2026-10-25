import { afterEach, beforeEach, expect, test, vi } from "vitest";
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

const harnessDate = Date.UTC(2026, 9, 15, 12);
const realSchedulerTimers = { setTimeout, setInterval };

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
  | "native-missing"
  | "native-duplicate"
  | "native-misallocated"
  | "native-before-missing"
  | "native-before-rewritten"
  | "native-role-allowed"
  | "native-role-restore"
  | "native-role-allowed-and-restore"
  | "native-role-overgrant"
  | "native-consumer-ap"
  | "native-consumer-deposit"
  | "native-consumer-payables"
  | "native-consumer-deposit-list"
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
beforeEach(() => {
  // Every execute caller includes current-month native use; scheduler timers must stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(harnessDate);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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
  let nativeUseOrg: unknown;
  const openingJournalByOrg = new Map<unknown, unknown>();
  const preexistingJournalByOrg = new Map<unknown, unknown>();
  const journalInventoryByOrg = new Map<unknown, Set<unknown>>();
  let nativePriorJournalIds = new Set<unknown>();
  const roleUpdatesByOrg = new Map<unknown, number>();
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
      let result: unknown;
      if ((defect === "native-role-restore" || defect === "native-role-allowed-and-restore") &&
        name === "memberships:updateRole" && roleUpdatesByOrg.get(args.orgId) === 1)
        throw new Error("Synthetic native membership restoration transport failure");
      try {
        result = await (kind === "query"
          ? actor.query(reference as FunctionReference<"query">, args)
          : actor.mutation(reference as FunctionReference<"mutation">, args));
      } catch (error) {
        if ((defect === "native-role-allowed" || defect === "native-role-allowed-and-restore") && actor === approver && kind === "mutation" &&
          error instanceof Error && error.message.includes("Missing required permissions"))
          return "synthetic-sdk-accepted";
        throw error;
      }
      if (name === "memberships:updateRole")
        roleUpdatesByOrg.set(args.orgId, (roleUpdatesByOrg.get(args.orgId) ?? 0) + 1);
      if (defect === "native-role-overgrant" && name === "memberships:getMyMembership" &&
        (result as Row).roleName === "SALES")
        return { ...(result as Row), permissions: [...((result as Row).permissions as string[]), "manage:finance"] };
      if (name === "accountingCutover:postOpeningBalanceDirect")
        openingJournalByOrg.set(args.orgId, (result as Row).journalId);
      if (name === "accountingLedger:listJournalEntries" && !preexistingJournalByOrg.has(args.orgId)) {
        const preexisting = (result as { page: Row[] }).page.find(entry =>
          entry._id !== openingJournalByOrg.get(args.orgId));
        if (preexisting) preexistingJournalByOrg.set(args.orgId, preexisting._id);
      }
      if (name === "accountingLedger:listJournalEntries")
        journalInventoryByOrg.set(args.orgId, new Set((result as { page: Row[] }).page.map(entry => entry._id)));
      if (name === "prepaidExpenses:retryAmortizationFailure" && nativeUseOrg === undefined) {
        nativeUseOrg = args.orgId;
        nativePriorJournalIds = journalInventoryByOrg.get(args.orgId) ?? new Set();
      }
      if (args.orgId === nativeUseOrg && kind === "query") {
        if (defect === "native-consumer-ap" && name === "accountingReports:supplierPayablesReconciliation") {
          const value = structuredClone(result) as { byCurrency: { JOD: Row } };
          value.byCurrency.JOD.subledgerBalanceMinor = 1;
          return value;
        }
        if (defect === "native-consumer-deposit" && name === "accountingReports:customerDepositsReconciliation") {
          const value = structuredClone(result) as { heldOpeningMinor: Row };
          value.heldOpeningMinor.JOD = 20002;
          return value;
        }
        if (defect === "native-consumer-payables" && name === "sourcingPayables:list") return [];
        if (defect === "native-consumer-deposit-list" && name === "deposits:listByVehicle") return [];
        if (defect === "native-before-missing" && name === "accountingLedger:listJournalEntries") {
          const value = structuredClone(result) as { page: Row[] };
          value.page = value.page.filter(entry => entry._id !== openingJournalByOrg.get(args.orgId));
          return value;
        }
        if (defect === "native-before-rewritten" && name === "accountingLedger:getJournalEntry" &&
          args.journalEntryId === preexistingJournalByOrg.get(args.orgId)) {
          const value = structuredClone(result) as { lines: Row[] };
          value.lines[0].debitMinor = Number(value.lines[0].debitMinor) + 1;
          value.lines[0].creditMinor = Number(value.lines[0].creditMinor) + 1;
          return value;
        }
        if (name === "accountingLedger:listJournalEntries" &&
          (defect === "native-missing" || defect === "native-duplicate")) {
          const value = structuredClone(result) as { page: Row[] };
          value.page = defect === "native-missing" ? value.page.slice(1) : [...value.page, value.page[0]];
          return value;
        }
        if (defect === "native-misallocated" && name === "accountingLedger:getJournalEntry" &&
          !nativePriorJournalIds.has(args.journalEntryId)) {
          const value = structuredClone(result) as { lines: Row[] };
          value.lines[0].accountId = "wrong-sdk-native-use-control";
          return value;
        }
      }
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

test("opening composite fixes Date while scheduler callbacks remain real", async () => {
  expect(Date.now()).toBe(harnessDate);
  expect(new Date().toISOString()).toBe("2026-10-15T12:00:00.000Z");
  expect(setTimeout).toBe(realSchedulerTimers.setTimeout);
  expect(setInterval).toBe(realSchedulerTimers.setInterval);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(Date.now()).toBe(harnessDate);
}, 1000);

test("independent opening containment executes when subsequent native use fails", async () => {
  const { results } = await execute("native-consumer-ap");
  expect(results.find(result => result.id === "S858-OPENING")).toMatchObject({
    status: "FAIL", detail: expect.stringContaining("native-use supplier consumer balance"),
  });
  expect(results.find(result => result.id === "S858-CONTAINMENT"), JSON.stringify(results)).toMatchObject({
    status: "PASS", detail: { duplicateRefused: true, foreignRefused: true, payoutRefused: true,
      twoPersonApproval: true, unknownPools: "UNALLOCATED", currentManagement: { recognisedMinor: 14286 } },
  });
  expect(summarize(results)).toMatchObject({ passed: 1, failed: 1, unproven: 0, complete: false });
}, 30000);

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

test("opening native subsequent use consumes the six selected sources once", async () => {
  const { results } = await execute();
  expect(results.find(value => value.id === "S858-OPENING"), JSON.stringify(results)).toMatchObject({
    status: "PASS", detail: { nativeUse: {
      families: 6, arRemainingMinor: 0, inventoryRemainingMinor: 0,
      prepaidRecognisedMinor: 23334, partnerBalanceMinor: 990000,
      refundableDepositRemainingMinor: 0, supplierPayableRemainingMinor: 0,
      cashDeltaMinor: 303003, closedSnapshotUnchanged: true,
      wrongRoleRefusals: 7, supplierReconciliationMinor: 0,
      heldUnknownPoolsMinor: 43002, customerDepositRemainingMinor: 0,
      customerDepositHeldMinor: 20001, unknownReceiptHeldMinor: 23001,
      roleAttestation: {
        original: { roleName: "SENIOR_ACCOUNTANT" },
        denied: { roleName: "SALES", isSystemOwnerRole: false },
        restored: { roleName: "SENIOR_ACCOUNTANT" },
      },
    } },
  });
}, 30000);

test.each([
  ["native-role-allowed", "Opening containment did not refuse"],
  ["native-role-restore", "Synthetic native membership restoration transport failure"],
  ["native-role-allowed-and-restore", "Opening containment did not refuse; native-use membership restoration also failed"],
  ["native-role-overgrant", "native-use denied role lacks manage:finance"],
  ["native-consumer-ap", "native-use supplier consumer balance"],
  ["native-consumer-deposit", "native-use held pool consumer"],
  ["native-consumer-payables", "native-use payable list source"],
  ["native-consumer-deposit-list", "native-use one sale deposit"],
] as const)("native role and consumer assertions refuse SDK %s corruption", async (defect, reason) => {
  const { results } = await execute(defect);
  expect(results.find(value => value.id === "S858-OPENING"), JSON.stringify(results)).toMatchObject({
    status: "FAIL", detail: expect.stringContaining(reason),
  });
  expect(summarize(results).complete).toBe(false);
}, 30000);

test.each([
  ["native-missing", "native-use exact journal delta"],
  ["native-duplicate", "native-use unique journal inventory"],
  ["native-misallocated", "native-use exact journal delta"],
] as const)("six-family native-use assertions refuse SDK %s results", async (defect, reason) => {
  const { results } = await execute(defect);
  expect(results.find(value => value.id === "S858-OPENING"), JSON.stringify(results)).toMatchObject({
    status: "FAIL", detail: expect.stringContaining(reason),
  });
  expect(summarize(results).complete).toBe(false);
}, 30000);

test.each([
  ["native-before-missing", "native-use preexisting journal retained"],
  ["native-before-rewritten", "native-use preexisting journal unchanged"],
] as const)("six-family native-use preserves prior journals under SDK %s corruption", async (defect, reason) => {
  const { results } = await execute(defect);
  expect(results.find(value => value.id === "S858-OPENING"), JSON.stringify(results)).toMatchObject({
    status: "FAIL", detail: expect.stringContaining(reason),
  });
  expect(summarize(results).complete).toBe(false);
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
