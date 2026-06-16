export interface CommissionTier {
  minProfitAmount: number;
  commissionPct: number;
}

export function calculateCommissionFromTiers(
  grossProfit: number,
  tiers: CommissionTier[]
): number {
  if (tiers.length === 0 || grossProfit <= 0) return 0;
  const sorted = [...tiers].sort((a, b) => a.minProfitAmount - b.minProfitAmount);
  let pct = 0;
  for (const tier of sorted) {
    if (grossProfit >= tier.minProfitAmount) pct = tier.commissionPct;
  }
  return (grossProfit * pct) / 100;
}
