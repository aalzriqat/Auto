"use client";

import { useSiteVisitorTracking } from "@/hooks/useSiteVisitorTracking";

/**
 * Thin client leaf so tracking can drop into server components (e.g.
 * sign-in/sign-up pages) without converting the whole page to "use client".
 */
export function SiteVisitorTracker({ path, enabled = true }: { path: string; enabled?: boolean }) {
  const host = typeof window === "undefined" ? undefined : window.location.host;
  useSiteVisitorTracking({ host, path, enabled });
  return null;
}
