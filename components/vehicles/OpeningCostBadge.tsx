"use client";

import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/components/providers/LanguageProvider";

/**
 * SCRUM-858 S2 (owner ruling SCRUM-858#c23884): an owned car whose cost came from an approved opening balance.
 * The vehicle record is the native inventory screen for it. A consigned vehicle never carries this marker, so it is
 * also hidden for SOURCED whatever the stored fields say. Display only: the server owns the refusal.
 */
export function hasOpeningCost(vehicle: { openingBalanceDraftId?: unknown; sourceType?: string | null }): boolean {
  return vehicle.openingBalanceDraftId !== undefined && vehicle.openingBalanceDraftId !== null && vehicle.sourceType !== "SOURCED";
}

export function OpeningCostBadge() {
  const { t } = useLanguage();
  return (
    <Badge variant="secondary" className="mt-2 w-fit text-xs" data-testid="opening-cost-badge">
      {t("VehicleOpeningCostBadge" as any)}
    </Badge>
  );
}
