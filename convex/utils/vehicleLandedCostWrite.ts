import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getOrgCurrency, hookVehicleLandedCostCapitalized } from "../accounting/workflowHooks";
import { requireActiveBankInCurrency } from "./bankAccountGuards";
import { assertFiniteNumber, toMinorUnits } from "./money";
import { assertOpeningVehicleBasis } from "./openingVehicleBasis";
import { type PaymentMethod, normalizePaymentMethod, paymentMethodValidator } from "./paymentMethods";
import { ConvexError, type ObjectType, v } from "convex/values";

export const vehicleLandedCostFields = {
  items: v.array(v.object({
    label: v.string(),
    amount: v.number(),
    /** How this specific item was paid — drives which account it capitalizes against and which account a later reduction/removal reverses against. Required for a non-zero item on a non-SOURCED vehicle. */
    paymentMethod: v.optional(paymentMethodValidator),
    bankAccountId: v.optional(v.id("bankAccounts")),
  })),
};

type LandedCostInput = ObjectType<typeof vehicleLandedCostFields> & {
  orgId: Id<"organizations">;
  vehicleId: Id<"vehicles">;
};

export async function storeVehicleLandedCosts(
  ctx: MutationCtx,
  args: LandedCostInput,
  vehicle: Doc<"vehicles">,
  actorId: Id<"users">,
  assertPaidCostChangeAllowed: () => void,
) {
  if (vehicle.status === "SOLD") {
    throw new ConvexError("Cannot edit landed costs on a sold vehicle — its inventory has already been relieved.");
  }
  if (vehicle.sourceType !== "SOURCED") {
    await assertOpeningVehicleBasis(ctx, args.orgId, args.vehicleId);
  }

  // For a non-SOURCED vehicle a NaN total blows up later in toMinorUnits and
  // rolls the mutation back, but that GL block is skipped entirely for SOURCED
  // vehicles — so NaN would land in vehicleLandedCosts.total and
  // vehicles.landedCostTotal with no error at all.
  for (const item of args.items) {
    assertFiniteNumber(item.amount, "landed cost amount");
  }

  const items = args.items
    .map((item) => ({ label: item.label.trim(), amount: item.amount, paymentMethod: item.paymentMethod, bankAccountId: item.bankAccountId }))
    .filter((item) => item.label.length > 0);
  if (vehicle.sourceType === "SOURCED" && items.some((item) => item.bankAccountId)) {
    throw new ConvexError("A physical bank account cannot be assigned to informational sourced-vehicle costs.");
  }
  // Sourced/drop-ship vehicles never sit in physical inventory — their cost
  // basis is sourceCost only, so landed costs entered against one (kept for
  // informational tracking) never capitalize into the GL, and there's no
  // account to silently default for them.
  if (vehicle.sourceType !== "SOURCED") {
    const missingMethod = items.find((item) => item.amount !== 0 && !item.paymentMethod);
    if (missingMethod) {
      throw new ConvexError(`Payment method is required for landed cost item "${missingMethod.label}".`);
    }
  }
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const now = Date.now();

  const existing = await ctx.db
    .query("vehicleLandedCosts")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
    .unique();
  const previousItems = existing?.items ?? [];

  // RT11-DOORS: owned nonzero items already carry settlement (legacy method
  // absence means CASH). Preserve every occurrence, including duplicate items.
  // SOURCED items are informational and have never capitalized or paid cash.
  if (vehicle.sourceType !== "SOURCED") {
    const itemKey = (item: Doc<"vehicleLandedCosts">["items"][number]) => JSON.stringify([
      item.label, item.amount, normalizePaymentMethod(item.paymentMethod), item.bankAccountId ?? null,
    ]);
    const remaining = new Map<string, number>();
    for (const item of items) {
      const key = itemKey(item);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const previous of previousItems) {
      if (previous.amount === 0) continue;
      const key = itemKey(previous);
      const count = remaining.get(key) ?? 0;
      if (count === 0) assertPaidCostChangeAllowed();
      else remaining.set(key, count - 1);
    }
    // A negative addition reverses settlement even when all paid rows survive.
    // Keep historical signed rows intact; only unmatched occurrences are new.
    // Nonnegative additions cannot reduce any method/bank settlement total.
    if (items.some((item) => item.amount < 0 && (remaining.get(itemKey(item)) ?? 0) > 0)) {
      assertPaidCostChangeAllowed();
    }
  }

  if (vehicle.sourceType !== "SOURCED") {
    // An old dimensionless bank cost cannot be reversed or reallocated to a
    // physical bank truthfully. Hold the whole edit for reviewed correction.
    if (previousItems.some((item) => item.amount !== 0 &&
      (item.paymentMethod === "BANK_TRANSFER" || item.paymentMethod === "CARD" || item.paymentMethod === "CHEQUE") &&
      !item.bankAccountId)) {
      throw new ConvexError("Existing bank-funded landed costs lack a physical bank identity. Have finance review them before editing.");
    }
    const currency = await getOrgCurrency(ctx, args.orgId);
    const checkedBanks = new Set<Id<"bankAccounts">>();
    for (const item of items) {
      const bankMethod = item.paymentMethod === "BANK_TRANSFER" || item.paymentMethod === "CARD" || item.paymentMethod === "CHEQUE";
      if (bankMethod && (item.amount !== 0 || item.bankAccountId)) {
        if (item.bankAccountId && checkedBanks.has(item.bankAccountId)) continue;
        const bankId = await requireActiveBankInCurrency(ctx, {
          orgId: args.orgId, bankAccountId: item.bankAccountId, currency,
          missingMessage: `Choose a bank account for landed cost item "${item.label}".`,
          currencySubject: "landed cost",
        });
        checkedBanks.add(bankId);
      } else if (item.bankAccountId) {
        throw new ConvexError(`A bank account is only valid for a bank-funded landed cost item "${item.label}".`);
      }
    }
  }

  if (existing) {
    await ctx.db.patch(existing._id, { items, total, updatedAt: now, updatedBy: actorId });
  } else {
    await ctx.db.insert("vehicleLandedCosts", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      items,
      total,
      updatedAt: now,
      updatedBy: actorId,
    });
  }
  return { items, total, now, previousItems };
}

export async function postVehicleLandedCosts(
  ctx: MutationCtx,
  args: LandedCostInput,
  vehicle: Doc<"vehicles">,
  actorId: Id<"users">,
  plan: Awaited<ReturnType<typeof storeVehicleLandedCosts>>,
) {
  const { items, now, previousItems } = plan;

  if (vehicle.sourceType !== "SOURCED") {
    const currency = await getOrgCurrency(ctx, args.orgId);
    // Group old vs. new items by settlement account and diff per account —
    // not just old-total vs. new-total — so moving an item between accounts
    // (or removing one paid from a different account than the others) posts
    // against the accounts actually affected, even when the net total is
    // unchanged.
    const sumsByMethodAndBank = (list: ReadonlyArray<{ amount: number; paymentMethod?: PaymentMethod; bankAccountId?: Id<"bankAccounts"> }>) => {
      const sums = new Map<string, { paymentMethod: PaymentMethod; bankAccountId?: Id<"bankAccounts">; amount: number }>();
      for (const item of list) {
        const paymentMethod = item.paymentMethod ?? normalizePaymentMethod(undefined);
        const key = JSON.stringify([paymentMethod, item.bankAccountId ?? null]);
        const prior = sums.get(key);
        sums.set(key, { paymentMethod, bankAccountId: item.bankAccountId, amount: (prior?.amount ?? 0) + item.amount });
      }
      return sums;
    };
    const oldSums = sumsByMethodAndBank(previousItems);
    const newSums = sumsByMethodAndBank(items);
    const allAccounts = new Set([...oldSums.keys(), ...newSums.keys()]);
    const accountDeltas = Array.from(allAccounts)
      .map((key) => ({
        paymentMethod: (newSums.get(key) ?? oldSums.get(key))!.paymentMethod,
        bankAccountId: (newSums.get(key) ?? oldSums.get(key))!.bankAccountId,
        deltaMinor: toMinorUnits((newSums.get(key)?.amount ?? 0) - (oldSums.get(key)?.amount ?? 0), currency),
      }))
      .filter((d) => d.deltaMinor !== 0);

    if (accountDeltas.length > 0) {
      await hookVehicleLandedCostCapitalized(ctx, {
        orgId: args.orgId,
        vehicleId: args.vehicleId,
        // A durable unique token, not a timestamp — two edits to the same
        // vehicle's landed costs landing in the same millisecond must not
        // collide on idempotencyKey and suppress a legitimate GL posting.
        editToken: crypto.randomUUID(),
        accountDeltas,
        currency,
        actorId: actorId,
        occurredAt: now,
      });
    }
  }
}
