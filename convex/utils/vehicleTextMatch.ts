import { Id } from "../_generated/dataModel";

type VehicleRecord = {
  _id: Id<"vehicles">;
  year: number;
  make: string;
  model: string;
  vin: string;
  isDeleted?: boolean;
};

/**
 * Scores vehicles against free-form post text and returns the best match id,
 * or undefined if confidence is too low to auto-select.
 *
 * Confidence tiers (highest to lowest):
 *   1. VIN — 17-char alphanumeric exact match (unique, no ambiguity)
 *   2. Year + make + at least one model word (score ≥ 5)
 *
 * Intentionally strict: better to miss a match than to link the wrong car.
 * Staff can always link manually from the Social Inbox.
 */
export function matchVehicleFromText(
  text: string,
  vehicles: VehicleRecord[]
): Id<"vehicles"> | undefined {
  if (!text.trim()) return undefined;

  const upper = text.toUpperCase();
  const lower = text.toLowerCase();
  const active = vehicles.filter((v) => !v.isDeleted);

  // 1. VIN — exactly 17 uppercase alphanumeric chars (no I, O, Q per ISO 3779)
  const vinMatch = upper.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  if (vinMatch) {
    const byVin = active.find((v) => v.vin.toUpperCase() === vinMatch[1]);
    if (byVin) return byVin._id;
  }

  let best: { id: Id<"vehicles">; score: number } | undefined;

  for (const v of active) {
    let score = 0;

    // Year — exact 4-digit word boundary match
    if (new RegExp(`\\b${v.year}\\b`).test(text)) score += 3;

    // Make — whole-word, case-insensitive
    if (
      new RegExp(`\\b${v.make.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)
    ) {
      score += 2;
    }

    // Model — each word of model (length > 2) that appears in text
    for (const word of v.model.toLowerCase().split(/\s+/)) {
      if (word.length > 2 && lower.includes(word)) score += 1;
    }

    // Require at minimum: year + make (5 pts) to avoid false positives
    if (score >= 5 && (!best || score > best.score)) {
      best = { id: v._id, score };
    }
  }

  return best?.id;
}
