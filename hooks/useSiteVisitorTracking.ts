"use client";

import { useEffect } from "react";
import { buildTrackingPayload, sendTrackingBeacon } from "@/lib/analytics/payload";

type UseSiteVisitorTrackingOptions = {
  host: string | null | undefined;
  path: string;
  enabled?: boolean;
};

function resolveLinkTarget(anchor: HTMLAnchorElement): string {
  return anchor.getAttribute("href") ?? anchor.href;
}

function resolveLinkLabel(el: HTMLElement): string | undefined {
  const dataLabel = el.dataset.trackLabel;
  if (dataLabel) return dataLabel;
  const text = el.textContent?.trim().replace(/\s+/g, " ");
  return text ? text.slice(0, 200) : undefined;
}

/**
 * Fires a page_view beacon whenever host/path changes, and attaches a single
 * delegated capture-phase click listener for link_click beacons — this app's
 * marketing/dealer-site pages have dozens of plain <a> tags, so tracking each
 * one individually isn't viable; inspecting the clicked element's closest
 * anchor (or an explicit data-track-id) covers all of them from one place.
 */
export function useSiteVisitorTracking({ host, path, enabled = true }: UseSiteVisitorTrackingOptions): void {
  useEffect(() => {
    if (!enabled || !host) return;
    sendTrackingBeacon(buildTrackingPayload({ host, type: "page_view", path }));
  }, [enabled, host, path]);

  useEffect(() => {
    if (!enabled || !host || typeof document === "undefined") return;

    function handleClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const trackedEl = target.closest<HTMLElement>("a[href], [data-track-id]");
      if (!trackedEl) return;

      const linkTarget =
        trackedEl instanceof HTMLAnchorElement
          ? resolveLinkTarget(trackedEl)
          : trackedEl.dataset.trackId;
      if (!linkTarget) return;

      sendTrackingBeacon(
        buildTrackingPayload({
          host: host as string,
          type: "link_click",
          path,
          linkTarget,
          linkLabel: resolveLinkLabel(trackedEl),
        })
      );
    }

    document.addEventListener("click", handleClick, { capture: true });
    return () => document.removeEventListener("click", handleClick, { capture: true });
    // Re-attached on path change too, so handleClick's closure never reports a
    // stale path after in-page (SPA-style) navigation without a host change.
  }, [enabled, host, path]);
}
