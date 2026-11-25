import type { ManagementProfitLine } from "./financingEconomics";

/**
 * SCRUM-613: the management-profit line for an approval excess (financing plus customer money above the
 * approved value). It is dealer income by default, and absent when there is none so existing profit lines
 * and totals are unchanged. The posting leg that books the same excess is `approvalExcessLeg.ts`.
 */
export function approvalExcessLines(excessMinor: number | undefined): ManagementProfitLine[] {
  const amountMinor = excessMinor ?? 0;
  return amountMinor > 0 ? [{ key: "APPROVAL_EXCESS", sign: 1, amountMinor }] : [];
}
