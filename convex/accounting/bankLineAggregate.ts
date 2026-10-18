import { DirectAggregate } from "@convex-dev/aggregate";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type ControlKey = [Id<"chartOfAccounts">, string, number];
type AttributionKey = [Id<"chartOfAccounts">, string, Id<"bankAccounts">, number];

const control = new DirectAggregate<{
  Namespace: string;
  Key: ControlKey;
  Id: Id<"journalLines">;
}>(components.bankControlByDate);

const attribution = new DirectAggregate<{
  Namespace: string;
  Key: AttributionKey;
  Id: Id<"journalLines">;
}>(components.bankAttributionByDate);

export function bankAggregateNamespace(
  orgId: Id<"organizations">,
  resetGeneration: number,
  mappingGeneration: number,
): string {
  return `${orgId}:${resetGeneration}:${mappingGeneration}`;
}

export type BankAggregateLine = {
  id: Id<"journalLines">;
  accountId: Id<"chartOfAccounts">;
  currency: string;
  accountingDate: number;
  bankAccountId?: Id<"bankAccounts">;
  netMinor: number;
};

/** The caller has already validated the posted parent and period facts. */
export async function addBankControlLine(
  ctx: MutationCtx,
  line: BankAggregateLine,
  namespace: string,
): Promise<void> {
  if (!Number.isSafeInteger(line.netMinor)) throw new Error("Bank aggregate line amount exceeds safe integer precision.");
  await control.insertIfDoesNotExist(ctx, {
    namespace,
    key: [line.accountId, line.currency, line.accountingDate],
    id: line.id,
    sumValue: line.netMinor,
  });
  if (line.bankAccountId) {
    await attribution.insertIfDoesNotExist(ctx, {
      namespace,
      key: [line.accountId, line.currency, line.bankAccountId, line.accountingDate],
      id: line.id,
      sumValue: line.netMinor,
    });
  }
}

export async function removeBankControlLine(
  ctx: MutationCtx,
  line: BankAggregateLine,
  namespace: string,
): Promise<void> {
  await control.deleteIfExists(ctx, {
    namespace,
    key: [line.accountId, line.currency, line.accountingDate],
    id: line.id,
  });
  if (line.bankAccountId) {
    await attribution.deleteIfExists(ctx, {
      namespace,
      key: [line.accountId, line.currency, line.bankAccountId, line.accountingDate],
      id: line.id,
    });
  }
}

type Range = { fromInclusive?: number; through: number };

export async function readControlRange(
  ctx: QueryCtx,
  namespace: string,
  accountId: Id<"chartOfAccounts">,
  currency: string,
  range: Range,
): Promise<{ count: number; netMinor: number }> {
  const bounds = {
    lower: { key: [accountId, currency, range.fromInclusive ?? Number.MIN_SAFE_INTEGER] as ControlKey, inclusive: true },
    upper: { key: [accountId, currency, range.through] as ControlKey, inclusive: true },
  };
  const [count, sum] = await Promise.all([
    control.count(ctx, { namespace, bounds }),
    control.sum(ctx, { namespace, bounds }),
  ]);
  if (!Number.isSafeInteger(sum)) throw new Error("Bank aggregate control sum lost integer precision.");
  return { count, netMinor: sum };
}

export async function readAttributionRange(
  ctx: QueryCtx,
  namespace: string,
  accountId: Id<"chartOfAccounts">,
  currency: string,
  bankAccountId: Id<"bankAccounts">,
  range: Range,
): Promise<{ count: number; netMinor: number }> {
  const bounds = {
    lower: { key: [accountId, currency, bankAccountId, range.fromInclusive ?? Number.MIN_SAFE_INTEGER] as AttributionKey, inclusive: true },
    upper: { key: [accountId, currency, bankAccountId, range.through] as AttributionKey, inclusive: true },
  };
  const [count, sum] = await Promise.all([
    attribution.count(ctx, { namespace, bounds }),
    attribution.sum(ctx, { namespace, bounds }),
  ]);
  if (!Number.isSafeInteger(sum)) throw new Error("Bank aggregate attribution sum lost integer precision.");
  return { count, netMinor: sum };
}

export async function clearBankAggregateNamespace(ctx: MutationCtx, namespace: string): Promise<void> {
  await Promise.all([
    control.clear(ctx, { namespace }),
    attribution.clear(ctx, { namespace }),
  ]);
}
