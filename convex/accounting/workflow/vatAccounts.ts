import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { isChartInitialized } from "../chartAccountsRead";
import { ensureVatReceivableAccount } from "../chartAccountsProvision";

/**
 * Phase 41 self-heal, scoped like ensureFixedAssetAccountsIfChartReady: only
 * expense-posting and supplier-payment-settling ever debit VAT_RECEIVABLE, so
 * this isn't added to the shared postOrEnqueue choke point.
 */
export async function ensureVatReceivableAccountIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensureVatReceivableAccount(ctx, orgId, actorId);
  }
}
