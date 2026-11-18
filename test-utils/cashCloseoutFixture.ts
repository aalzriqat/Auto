import type { recordReconciledZeroCost } from "./convexTest";

type CashFixtureArgs = Parameters<typeof recordReconciledZeroCost>;

export async function confirmCashNoCosts({
  salesperson, approver, api, orgId, applicationId,
}: {
  salesperson: CashFixtureArgs[0];
  approver: CashFixtureArgs[0];
  api: CashFixtureArgs[1];
  orgId: CashFixtureArgs[2];
  applicationId: CashFixtureArgs[3];
}): Promise<void> {
  const args = { orgId, applicationId };
  const expectedVersion = await salesperson.mutation(api.cashDealCloseout.declareNoCosts, args);
  await approver.mutation(api.cashDealCloseout.confirmNoCosts, { ...args, expectedVersion });
}
