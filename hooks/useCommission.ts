"use client";
import { useOrgSettings } from "./useOrgSettings";

export function useCommission() {
  const settings = useOrgSettings();
  const tiers = settings?.commissionTiers ?? [];

  function calculate(profit: number): number {
    if (tiers.length === 0) return 0;
    const sorted = [...tiers].sort((a, b) => a.minProfitAmount - b.minProfitAmount);
    let pct = 0;
    for (const tier of sorted) {
      if (profit >= tier.minProfitAmount) pct = tier.commissionPct;
    }
    return (profit * pct) / 100;
  }

  function getAppliedTier(profit: number) {
    if (tiers.length === 0) return null;
    const sorted = [...tiers].sort((a, b) => a.minProfitAmount - b.minProfitAmount);
    return [...sorted].reverse().find((t) => profit >= t.minProfitAmount) ?? null;
  }

  return { calculate, getAppliedTier, hasConfig: tiers.length > 0 };
}
