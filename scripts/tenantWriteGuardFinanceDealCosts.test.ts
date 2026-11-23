import path from "node:path";
import { expect, test } from "vitest";
import { readFinanceDealCostCommands } from "./financeDealCostCommandSources";
import { findUnguardedTenantWrites } from "./tenantWriteGuard";

const ENTRY = "financeDealCosts.ts";

test("still audits caller-supplied ids written by cost mutation commands", () => {
  const file = path.resolve(__dirname, "../convex", ENTRY);
  const commands = readFinanceDealCostCommands(file);
  const mutations = [...commands].filter(([, command]) => command.builder === "mutation");
  expect(new Set(mutations.map(([name]) => name))).toEqual(new Set([
    "adoptCompanyFeeTemplates",
    "recordDealFee",
    "recordTemplateFeeActual",
    "recordExecutionFeeActual",
    "bindExecutionFeeLine",
    "unbindExecutionFeeLine",
    "recordActualFeeAmount",
    "reconcileDealFee",
    "voidDealFee",
    "setFeeCustody",
    "recordDirectFeePayment",
    "openDealCustody",
    "recordCustodyMovement",
    "reconcileDealCustody",
    "migrateLegacyCustodyToLedger",
    "reopenDealCustody",
    "planCustodyHandler",
    "recordLegalInvoice",
  ]));
  const scan = (body: (source: string) => string) => mutations.flatMap(([, mutation]) =>
    findUnguardedTenantWrites("\n" + mutation.registration + "\n" + body(mutation.body.getText()), ENTRY),
  );
  expect(scan((source) => source)).toEqual([]);
  const withoutOwnership = scan((source) => source
    .replace(/\brequireOwnedRow\s*\(/g, "readUnscopedRow(")
    .replace(/\.orgId(\s*!?==)/g, ".uncheckedOrgId$1"));
  expect(Object.fromEntries(withoutOwnership.map(({ functionName, writes }) => [functionName, writes]))).toEqual({
    bindExecutionFeeLine: ["patch(args.feeId)"],
    unbindExecutionFeeLine: ["patch(args.feeId)"],
    recordActualFeeAmount: ["patch(args.feeId)"],
    reconcileDealFee: ["patch(args.feeId)"],
    voidDealFee: ["patch(args.feeId)"],
    setFeeCustody: ["patch(args.feeId)"],
    reconcileDealCustody: ["patch(args.custodyId)", "patch(args.custodyId)"],
    migrateLegacyCustodyToLedger: ["patch(args.custodyId)", "patch(args.custodyId)"],
    reopenDealCustody: ["patch(args.custodyId)"],
    planCustodyHandler: ["patch(args.applicationId)"],
    recordLegalInvoice: ["patch(args.applicationId)"],
  });
});
