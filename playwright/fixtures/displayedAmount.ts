// A money cell as the cockpit renders it: Latin digits with "," grouping, a space, then the currency
// marker (the ISO code, or the org's own symbol such as "د.أ" in Arabic). The pattern covers the WHOLE
// cell, so "-3,000", "3,000.01", "13,000" and a bare "3,000" with no marker do not match "3,000".
const CURRENCY_MARKER = "[\\p{L}.]+";

export const displayedAmount = (figure: string) =>
  new RegExp(`^\\s*${figure.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${CURRENCY_MARKER}\\s*$`, "u");
