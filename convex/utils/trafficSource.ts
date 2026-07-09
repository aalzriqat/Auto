const CLICK_ID_PARAMS: { param: string; type: string; label: string }[] = [
  { param: "fbclid", type: "fbclid", label: "Facebook Ads" },
  { param: "gclid", type: "gclid", label: "Google Ads" },
  { param: "msclkid", type: "msclkid", label: "Microsoft Ads" },
  { param: "ttclid", type: "ttclid", label: "TikTok Ads" },
  { param: "igshid", type: "igshid", label: "Instagram" },
  { param: "ig_rid", type: "ig_rid", label: "Instagram" },
];

const REFERRER_SOURCE_RULES: { pattern: RegExp; label: string }[] = [
  { pattern: /(^|\.)google\./i, label: "Google (organic search)" },
  { pattern: /(^|\.)bing\.com$/i, label: "Bing (organic search)" },
  { pattern: /(^|\.)yahoo\./i, label: "Yahoo (organic search)" },
  { pattern: /(^|\.)duckduckgo\.com$/i, label: "DuckDuckGo (organic search)" },
  { pattern: /(^|\.)(m\.|l\.)?facebook\.com$/i, label: "Facebook" },
  { pattern: /(^|\.)instagram\.com$/i, label: "Instagram" },
  { pattern: /(^|\.)(twitter\.com|t\.co|x\.com)$/i, label: "Twitter/X" },
  { pattern: /(^|\.)linkedin\.com$/i, label: "LinkedIn" },
  { pattern: /(^|\.)(wa\.me|whatsapp\.com)$/i, label: "WhatsApp" },
  { pattern: /(^|\.)tiktok\.com$/i, label: "TikTok" },
  { pattern: /(^|\.)youtube\.com$/i, label: "YouTube" },
];

export type TrafficSourceInput = {
  referrerHost?: string;
  ownHosts: string[];
  utmSource?: string;
  utmMedium?: string;
  clickIdType?: string;
};

export type TrafficSourceResult = {
  label: string;
  isInternal: boolean;
};

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

/**
 * Priority order matters: ad click-IDs (fbclid/gclid/...) are checked before the
 * Referer header because Facebook/Instagram's in-app browser frequently strips or
 * rewrites Referer, making the click-ID the only reliable signal in that case.
 */
export function classifyTrafficSource(input: TrafficSourceInput): TrafficSourceResult {
  const clickIdMatch = CLICK_ID_PARAMS.find((c) => c.type === input.clickIdType);
  if (clickIdMatch) {
    return { label: clickIdMatch.label, isInternal: false };
  }

  if (input.utmSource) {
    const medium = input.utmMedium ? ` (${input.utmMedium})` : "";
    return { label: `${input.utmSource}${medium}`, isInternal: false };
  }

  const referrerHost = input.referrerHost ? normalizeHost(input.referrerHost) : undefined;
  if (!referrerHost) {
    return { label: "Direct", isInternal: false };
  }

  const ownHosts = new Set(input.ownHosts.map(normalizeHost));
  if (ownHosts.has(referrerHost)) {
    return { label: "Internal navigation", isInternal: true };
  }

  const known = REFERRER_SOURCE_RULES.find((r) => r.pattern.test(referrerHost));
  if (known) {
    return { label: known.label, isInternal: false };
  }

  return { label: `Referral: ${referrerHost}`, isInternal: false };
}

export function extractClickId(searchParams: URLSearchParams): { type?: string; value?: string } {
  for (const candidate of CLICK_ID_PARAMS) {
    const value = searchParams.get(candidate.param);
    if (value) {
      return { type: candidate.type, value };
    }
  }
  return {};
}
