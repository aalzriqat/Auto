export type GeoLookupResult = {
  country?: string;
  region?: string;
  city?: string;
} | null;

const PRIVATE_IP_PATTERN =
  /^(127\.|10\.|192\.168\.|::1$|localhost$|unknown$)|^172\.(1[6-9]|2\d|3[0-1])\./;

/**
 * Fire-and-forget IP geolocation, called once per new visitor (never per event).
 * Failures/throttling are swallowed silently — geo is a nice-to-have enrichment,
 * never a blocking dependency for recording a visit.
 */
export async function lookupGeoForIp(ip: string): Promise<GeoLookupResult> {
  if (!ip || PRIVATE_IP_PATTERN.test(ip)) {
    return null;
  }

  try {
    const response = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      error?: boolean;
      reason?: string;
      country_name?: string;
      region?: string;
      city?: string;
    };
    if (data.error) return null;

    return {
      country: data.country_name || undefined,
      region: data.region || undefined,
      city: data.city || undefined,
    };
  } catch {
    return null;
  }
}
