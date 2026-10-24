import {
  createOpeningSettlementReader,
  type OpeningSettlementReader,
} from "./openingSettlementBasis";
import type { MutationCtx } from "../_generated/server";
import type { PostCommand } from "../accounting/postingEngine";
import { assertOpeningSupplierPosting } from "./openingSupplierPosting";
import { assertOpeningCommissionPosting } from "./openingCommissionBasis";
export async function assertOpeningPostingProof(
  ctx: MutationCtx,
  cmd: PostCommand,
  suppliedReader?: OpeningSettlementReader,
) {
  const reader =
    suppliedReader ?? createOpeningSettlementReader(ctx, cmd.orgId);
  await assertOpeningSupplierPosting(ctx, cmd, reader);
  await assertOpeningCommissionPosting(ctx, cmd, reader);
  return reader;
}
