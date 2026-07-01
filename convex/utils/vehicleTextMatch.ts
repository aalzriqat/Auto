import { Id } from "../_generated/dataModel";

type VehicleRecord = {
  _id: Id<"vehicles">;
  year: number;
  make: string;
  model: string;
  trim?: string;
  vin?: string;
  status?: string;
  isDeleted?: boolean;
};

type VehicleAnalysis = {
  vehicle: VehicleRecord;
  score: number;
  hasYear: boolean;
  hasMake: boolean;
  hasModel: boolean;
  hasTrim: boolean;
  matchedDetails: string[];
  missingDetails: string[];
};

export type VehicleTextSuggestion = {
  vehicleId: Id<"vehicles">;
  summary: string;
  status?: string;
  score: number;
  matchedDetails: string[];
  missingDetails: string[];
};

function normalizeDigits(text: string): string {
  return text
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(text: string): string {
  return normalizeDigits(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function extractHashtagSlugs(text: string): string[] {
  const normalized = normalizeDigits(text).normalize("NFKC");
  const matches = normalized.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return Array.from(new Set(matches.map((tag) => slugify(tag.slice(1))).filter(Boolean)));
}

function wordsForMatch(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2);
}

function vehicleDetailHashtagSlugs(vehicle: VehicleRecord): Set<string> {
  const make = slugify(vehicle.make);
  const model = slugify(vehicle.model);
  const trim = vehicle.trim ? slugify(vehicle.trim) : "";
  const year = String(vehicle.year);

  const slugs = new Set<string>();
  for (const value of [
    `${year}${make}${model}`,
    `${make}${model}${year}`,
    `${year}${make}${model}${trim}`,
    `${make}${model}${trim}${year}`,
  ]) {
    if (value.length >= 4) slugs.add(value);
  }
  return slugs;
}

function matchVehicleFromHashtags(
  hashtags: string[],
  vehicles: VehicleRecord[]
): Id<"vehicles"> | undefined {
  for (const hashtag of hashtags) {
    const matches = vehicles.filter((vehicle) => vehicleDetailHashtagSlugs(vehicle).has(hashtag));
    if (matches.length === 1) return matches[0]._id;
  }
  return undefined;
}

function analyzeVehicleText(text: string, vehicle: VehicleRecord): VehicleAnalysis {
  const searchable = normalizeDigits(text).normalize("NFKC");
  const lower = searchable.toLowerCase();
  const hashtags = extractHashtagSlugs(searchable);
  const compact = slugify(searchable);
  const detailText = [compact, ...hashtags].join(" ");

  const makeSlug = slugify(vehicle.make);
  const modelSlug = slugify(vehicle.model);
  const trimSlug = vehicle.trim ? slugify(vehicle.trim) : "";
  const year = String(vehicle.year);

  const hasYear = new RegExp(`\\b${vehicle.year}\\b`).test(searchable) || detailText.includes(year);
  const hasMake = new RegExp(`\\b${escapeRegex(vehicle.make)}\\b`, "i").test(searchable) || detailText.includes(makeSlug);
  const modelWords = wordsForMatch(vehicle.model);
  const matchedModelWords = modelWords.filter((word) => lower.includes(word));
  const hasModel = matchedModelWords.length > 0 || (modelSlug.length > 0 && detailText.includes(modelSlug));
  const trimWords = vehicle.trim ? wordsForMatch(vehicle.trim) : [];
  const matchedTrimWords = trimWords.filter((word) => lower.includes(word));
  const hasTrim = Boolean(
    vehicle.trim &&
    (matchedTrimWords.length > 0 || (trimSlug.length > 0 && detailText.includes(trimSlug)))
  );

  let score = 0;
  if (hasYear) score += 3;
  if (hasMake) score += 2;
  if (hasModel) score += Math.max(1, matchedModelWords.length);
  if (hasTrim) score += 1;

  const matchedDetails: string[] = [];
  const missingDetails: string[] = [];

  if (hasYear) matchedDetails.push(year);
  else missingDetails.push("year");
  if (hasMake) matchedDetails.push(vehicle.make);
  else missingDetails.push("make");
  if (hasModel) matchedDetails.push(vehicle.model);
  else missingDetails.push("model");
  if (vehicle.trim) {
    if (hasTrim) matchedDetails.push(vehicle.trim);
    else missingDetails.push("trim");
  }

  return {
    vehicle,
    score,
    hasYear,
    hasMake,
    hasModel,
    hasTrim,
    matchedDetails,
    missingDetails,
  };
}

function vehicleSummary(vehicle: VehicleRecord): string {
  return `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""}`;
}

export function suggestVehiclesFromText(
  text: string,
  vehicles: VehicleRecord[],
  limit = 3
): VehicleTextSuggestion[] {
  if (!text.trim()) return [];

  return vehicles
    .filter((vehicle) => !vehicle.isDeleted)
    .map((vehicle) => analyzeVehicleText(text, vehicle))
    .filter((analysis) => analysis.hasModel || (analysis.hasMake && analysis.hasYear))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.missingDetails.length - b.missingDetails.length;
    })
    .slice(0, limit)
    .map((analysis) => ({
      vehicleId: analysis.vehicle._id,
      summary: vehicleSummary(analysis.vehicle),
      status: analysis.vehicle.status,
      score: analysis.score,
      matchedDetails: analysis.matchedDetails,
      missingDetails: analysis.missingDetails,
    }));
}

/**
 * Scores vehicles against free-form post text and returns the best match id,
 * or undefined if confidence is too low to auto-select.
 *
 * Confidence tiers (highest to lowest):
 *   1. VIN — 17-char alphanumeric exact match (unique, no ambiguity)
 *   2. Vehicle-detail hashtag — e.g. #BYDSongPro2025 or #BYDSongProZero2025
 *   3. Year + make + at least one model word (score ≥ 5)
 *
 * Intentionally strict: better to miss a match than to link the wrong car.
 * Staff can always link manually from the Social Inbox.
 */
export function matchVehicleFromText(
  text: string,
  vehicles: VehicleRecord[]
): Id<"vehicles"> | undefined {
  if (!text.trim()) return undefined;

  const searchable = normalizeDigits(text).normalize("NFKC");
  const upper = searchable.toUpperCase();
  const active = vehicles.filter((v) => !v.isDeleted);

  // 1. VIN — exactly 17 uppercase alphanumeric chars (no I, O, Q per ISO 3779)
  const vinMatch = upper.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  if (vinMatch) {
    const byVin = active.find((v) => v.vin?.toUpperCase() === vinMatch[1]);
    if (byVin) return byVin._id;
  }

  const byHashtag = matchVehicleFromHashtags(extractHashtagSlugs(searchable), active);
  if (byHashtag) return byHashtag;

  let best: { id: Id<"vehicles">; score: number } | undefined;
  let tiedBest = false;

  for (const v of active) {
    const analysis = analyzeVehicleText(searchable, v);
    const autoMatchEligible =
      analysis.hasYear && analysis.hasMake && analysis.hasModel && analysis.score >= 6;

    // Require at minimum: year + make + one model word to avoid false positives.
    if (autoMatchEligible && (!best || analysis.score > best.score)) {
      best = { id: v._id, score: analysis.score };
      tiedBest = false;
    } else if (autoMatchEligible && best && analysis.score === best.score) {
      tiedBest = true;
    }
  }

  return tiedBest ? undefined : best?.id;
}
