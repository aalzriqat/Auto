import type { ImageSourcePropType } from "react-native";

// Bundled marque logos, keyed by a normalized make name. Each is a small
// (128px) white-ground PNG meant to sit on a light logo chip. This is a growing
// library — drop a new `<slug>.png` into assets/brand/makes and add one entry
// here (plus any spelling aliases) and every brand pill / filter that resolves
// through getMakeLogo() lights up automatically. Brands with no entry fall back
// to a text-only label, so partial coverage is fine.
const MAKE_LOGOS: Record<string, ImageSourcePropType> = {
  abarth: require("../../assets/brand/makes/abarth.png"),
  aito: require("../../assets/brand/makes/aito.png"),
  "alfa romeo": require("../../assets/brand/makes/alfa-romeo.png"),
  arcfox: require("../../assets/brand/makes/arcfox.png"),
  audi: require("../../assets/brand/makes/audi.png"),
  avatr: require("../../assets/brand/makes/avatr.png"),
  baic: require("../../assets/brand/makes/baic.png"),
  baw: require("../../assets/brand/makes/baw.png"),
  bestune: require("../../assets/brand/makes/bestune.png"),
  bmw: require("../../assets/brand/makes/bmw.png"),
};

// Spelling variants that should resolve to the same logo as their canonical key.
const MAKE_ALIASES: Record<string, string> = {
  "alfa-romeo": "alfa romeo",
  alfaromeo: "alfa romeo",
};

function normalizeMake(make: string): string {
  return make.trim().toLowerCase();
}

/**
 * Returns the bundled logo for a vehicle make, or `undefined` when we don't yet
 * have art for it. Matching is case-insensitive and tolerates a few known
 * spelling variants.
 */
export function getMakeLogo(make: string | null | undefined): ImageSourcePropType | undefined {
  if (!make) return undefined;
  const key = normalizeMake(make);
  return MAKE_LOGOS[key] ?? MAKE_LOGOS[MAKE_ALIASES[key] ?? ""];
}
