import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { isChartInitialized } from "../chartAccountsRead";
import { ensureFixedAssetAccounts } from "../chartAccountsProvision";
import { type EventType } from "../postingRules";
import { postDomainEvent } from "./posting";

// ─── GL Phase 11: fixed-asset lifecycle ───────────────────────────────────────

/**
 * Unlike GENERAL_EXPENSE/AP-Suppliers (self-healed unconditionally in
 * postOrEnqueue since many event types can resolve them), the 6 fixed-asset
 * accounts are only ever needed by these 4 hooks — so the self-heal is scoped
 * here instead of added to the shared choke point, to avoid the extra lookup
 * on every unrelated posting event.
 */
async function ensureFixedAssetAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensureFixedAssetAccounts(ctx, orgId, actorId);
  }
}

interface FixedAssetHookBaseArgs {
  orgId: Id<"organizations">;
  assetId: Id<"fixedAssets">;
  currency: string;
  actorId: Id<"users">;
  occurredAt: number;
}

async function postFixedAssetEvent(
  ctx: MutationCtx,
  eventType: Extract<
    EventType,
    "ASSET_CAPITALIZED" | "DEPRECIATION_POSTED" | "ASSET_IMPAIRED" | "ASSET_DISPOSED"
  >,
  args: FixedAssetHookBaseArgs,
  details: {
    sourceId?: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }
) {
  await ensureFixedAssetAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType,
    sourceType: "fixedAssets",
    sourceId: details.sourceId ?? args.assetId.toString(),
    idempotencyKey: details.idempotencyKey,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      assetId: args.assetId.toString(),
      ...details.payload,
      currency: args.currency,
    },
  });
}

export async function hookAssetCapitalized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    costMinor: number;
    currency: string;
    paymentMethod?: string;
    bankAccountId?: Id<"bankAccounts">;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postFixedAssetEvent(ctx, "ASSET_CAPITALIZED", args, {
    idempotencyKey: `asset_capitalized_${args.assetId}`,
    payload: {
      costMinor: args.costMinor,
      paymentMethod: args.paymentMethod,
      bankAccountId: args.bankAccountId?.toString(),
    },
  });
}

export async function hookDepreciationPosted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    yearMonth: string; // "YYYY-MM", used only for the idempotency key
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postFixedAssetEvent(ctx, "DEPRECIATION_POSTED", args, {
    sourceId: `depr_${args.assetId}_${args.yearMonth}`,
    idempotencyKey: `depr_${args.assetId}_${args.yearMonth}`,
    payload: {
      amountMinor: args.amountMinor,
    },
  });
}

export async function hookAssetImpaired(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postFixedAssetEvent(ctx, "ASSET_IMPAIRED", args, {
    // No timestamp suffix: an asset can only transition ACTIVE -> IMPAIRED
    // once (impair() gates on status === "ACTIVE"), so the key must stay
    // stable across retries rather than vary with wall-clock occurredAt.
    idempotencyKey: `asset_impaired_${args.assetId}`,
    payload: {
      amountMinor: args.amountMinor,
    },
  });
}

export async function hookAssetDisposed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    costMinor: number;
    accumulatedDepreciationMinor: number;
    proceedsMinor: number;
    bankAccountId?: Id<"bankAccounts">;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postFixedAssetEvent(ctx, "ASSET_DISPOSED", args, {
    idempotencyKey: `asset_disposed_${args.assetId}`,
    payload: {
      costMinor: args.costMinor,
      accumulatedDepreciationMinor: args.accumulatedDepreciationMinor,
      proceedsMinor: args.proceedsMinor,
      bankAccountId: args.bankAccountId?.toString(),
    },
  });
}
