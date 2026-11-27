import type { MutationCtx } from "../_generated/server";
import { LATE_BANK_OPENING_EVENT, requireLateBankOpeningPosting } from "./lateBankOpening";
import { PREPAID_RECLASS_EVENT, requirePrepaidReclassPosting } from "./prepaidReclassification";
import { requireTreasuryPosting, TREASURY_TRANSFER_EVENT } from "./treasuryTransfer";

type HookCommand =
  & Parameters<typeof requireTreasuryPosting>[1]
  & Parameters<typeof requireLateBankOpeningPosting>[1]
  & Parameters<typeof requirePrepaidReclassPosting>[1]
  & { eventType: string };

/**
 * Event-type proofs the posting engine runs after the replay check and before the rule. Each one re-derives what the
 * event may carry from stored records, so no caller, internal or public, chooses the figures of these events.
 */
export async function requireEventPosting(ctx: MutationCtx, cmd: HookCommand): Promise<void> {
  if (cmd.eventType === TREASURY_TRANSFER_EVENT) await requireTreasuryPosting(ctx, cmd);
  if (cmd.eventType === LATE_BANK_OPENING_EVENT) await requireLateBankOpeningPosting(ctx, cmd);
  if (cmd.eventType === PREPAID_RECLASS_EVENT) await requirePrepaidReclassPosting(ctx, cmd);
}
