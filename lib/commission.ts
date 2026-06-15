export interface CommissionTier {
  minProfitAmount: number;
  commissionPct: number;
}

export function calculateCommission(profit: number, tiers: CommissionTier[]): number {
  if (tiers.length === 0) return 0;
  const sorted = [...tiers].sort((a, b) => a.minProfitAmount - b.minProfitAmount);
  let pct = 0;
  for (const tier of sorted) {
    if (profit >= tier.minProfitAmount) pct = tier.commissionPct;
  }
  return (profit * pct) / 100;
}

export function getAppliedTier(profit: number, tiers: CommissionTier[]): CommissionTier | null {
  if (tiers.length === 0) return null;
  const sorted = [...tiers].sort((a, b) => a.minProfitAmount - b.minProfitAmount);
  return [...sorted].reverse().find((t) => profit >= t.minProfitAmount) ?? null;
}
