import { extractClickId } from "@/convex/utils/trafficSource";
import { getOrCreateSessionId, getOrCreateVisitorId } from "./visitorId";

const SESSION_ATTRIBUTION_KEY = "autoflow_session_attribution";

export type SiteEventType = "page_view" | "link_click";

export type SiteTrackingPayload = {
  host: string;
  visitorId: string;
  sessionId: string;
  type: SiteEventType;
  path: string;
  linkTarget?: string;
  linkLabel?: string;
  referrerUrl?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  clickIdType?: string;
  clickIdValue?: string;
  language?: string;
  timezone?: string;
  screenWidth?: number;
  screenHeight?: number;
  viewportWidth?: number;
  viewportHeight?: number;
};

type SessionAttribution = {
  referrerUrl?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  clickIdType?: string;
  clickIdValue?: string;
};

/**
 * Traffic-source attribution (referrer, UTM, ad click-IDs) belongs to how the
 * visitor *entered* the site, not to whatever page they're on right now — an
 * SPA-style dealer-site nav to /inventory has no query string of its own.
 * Captured once per browser session and reused for every event after that.
 */
function getSessionAttribution(): SessionAttribution {
  if (typeof window === "undefined") return {};

  const cached = window.sessionStorage.getItem(SESSION_ATTRIBUTION_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as SessionAttribution;
    } catch {
      // fall through and recompute
    }
  }

  const params = new URLSearchParams(window.location.search);
  const clickId = extractClickId(params);
  const attribution: SessionAttribution = {
    referrerUrl: document.referrer || undefined,
    utmSource: params.get("utm_source") ?? undefined,
    utmMedium: params.get("utm_medium") ?? undefined,
    utmCampaign: params.get("utm_campaign") ?? undefined,
    utmTerm: params.get("utm_term") ?? undefined,
    utmContent: params.get("utm_content") ?? undefined,
    clickIdType: clickId.type,
    clickIdValue: clickId.value,
  };
  window.sessionStorage.setItem(SESSION_ATTRIBUTION_KEY, JSON.stringify(attribution));
  return attribution;
}

export function buildTrackingPayload(base: {
  host: string;
  type: SiteEventType;
  path: string;
  linkTarget?: string;
  linkLabel?: string;
}): SiteTrackingPayload {
  const attribution = getSessionAttribution();
  return {
    host: base.host,
    visitorId: getOrCreateVisitorId(),
    sessionId: getOrCreateSessionId(),
    type: base.type,
    path: base.path,
    linkTarget: base.linkTarget,
    linkLabel: base.linkLabel,
    ...attribution,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

function siteEventsUrl(): string | null {
  const base = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  return base ? `${base.replace(/\/$/, "")}/site-events` : null;
}

/**
 * Fire-and-forget beacon — visitor tracking must never affect the page it's
 * measuring, so failures (missing env var, network error, blocked request)
 * are swallowed silently rather than surfaced to the user or thrown.
 */
export function sendTrackingBeacon(payload: SiteTrackingPayload): void {
  if (typeof window === "undefined") return;
  const url = siteEventsUrl();
  if (!url) return;

  // text/plain is a CORS-safelisted content type, so this beacon never
  // triggers a preflight OPTIONS round trip (sendBeacon can't wait for one).
  const blob = new Blob([JSON.stringify(payload)], { type: "text/plain" });

  if (typeof navigator.sendBeacon === "function") {
    try {
      if (navigator.sendBeacon(url, blob)) return;
    } catch {
      // fall through to fetch
    }
  }

  fetch(url, { method: "POST", body: blob, keepalive: true }).catch(() => {});
}
