import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { outstandingFromReceivableDoc } from "../subledger";
import { assertCustomerGapToDealerCollectable } from "./financedGapPilotRule";
import { FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED } from "./financedGapPilotSwitch";
import { refuseSaleDebt } from "./saleDebtContainment";

/**
 * SCRUM-571 ruling 10 (owner ruling c23812 on SCRUM-760): while `FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED` is on,
 * a FINANCED deal whose customer still owes the dealership a gap R is refused, because no certified door can collect the
 * invoice it would open. See `financedGapPilotSwitch.ts` for the ruling and for why the switch is a module of its own.
 *
 * R is the plan's `customerReceivableMinor`: the customer's cash plus instalment gap owed to the dealership, in minor
 * units. A gap the customer pays to the finance company (confirmed evidence) or that the dealership absorbs is not part
 * of R. A held deposit does not pay R either: on a plan-governed sale the deposit is forwarded to the finance company
 * and is never allocated to the customer invoice.
 *
 * The pre-write rule. Pure and read-free: `finalizeDeal` calls it with the plan it is about to freeze, after the plan is
 * resolved and before any other refusal that would ask the operator to spend money (the finance-company forward), so a
 * deal that cannot close is never asked to pay first. An absent plan (cash, no named financier) is not this rule's
 * business. Anything but exactly zero refuses, so an unreadable (NaN, fractional, negative) gap fails closed.
 *
 * The rule itself is `financedGapPilotRule.ts`, which the earlier doors (choosing the route, handover) and the readiness
 * check ask as well. This is the completion door's copy, for a deal whose gap was agreed before those refusals existed.
 */
export function assertFinancedCustomerGapCollectable(
  plan: { customerReceivableMinor: number } | null | undefined
): void {
  if (!plan) return;
  assertCustomerGapToDealerCollectable({ readable: true, amountMinor: plan.customerReceivableMinor });
}

/**
 * The backstop on the money that actually exists. Call it inside the completing mutation once the canonical customer
 * invoice is created, so a plan and an invoice that disagree (an extra billed line, a rounding fault) cannot leave an
 * open customer invoice behind: the throw rolls back the sale, the journal and the invoice. A completion with no
 * financed plan is judged by the cash rule instead.
 */
export async function assertFinancedInvoiceFullyPaid(
  ctx: MutationCtx,
  args: { financedSalePlan?: unknown; saleReceivableId: Id<"receivableDocuments"> }
): Promise<void> {
  if (!FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED || !args.financedSalePlan) return;
  const doc = await ctx.db.get(args.saleReceivableId);
  if (!doc || (await outstandingFromReceivableDoc(ctx, doc)) > 0) refuseSaleDebt("FINANCED_CUSTOMER_GAP_UNCOLLECTABLE_REFUSED");
}
