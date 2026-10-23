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
  | "expense"
  | "payroll"
  | "management"
  | "credit"
  | "identity"
  | "refusal";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function execute(defect?: Defect) {
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

test.each([
  ["source", "S858-OPENING", "actual source available"],
  ["refusal", "S858-OPENING", "unexpected refusal"],
  ["target", "S858-OPENING", "one exact selected control line"],
  ["amount", "S858-OPENING", "opening debit"],
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
