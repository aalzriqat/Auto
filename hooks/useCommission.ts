"use client";
import { useOrgSettings } from "./useOrgSettings";
import { calculateCommission, getAppliedTier as getAppliedTierPure } from "@/lib/commission";

export function useCommission() {
  const settings = useOrgSettings();
  const tiers = settings?.commissionTiers ?? [];

  return {
    calculate: (profit: number) => calculateCommission(profit, tiers),
    getAppliedTier: (profit: number) => getAppliedTierPure(profit, tiers),
    hasConfig: tiers.length > 0,
  };
}
