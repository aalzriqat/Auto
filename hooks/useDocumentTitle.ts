"use client";

import { useEffect } from "react";

/**
 * Keeps the browser tab title at `title` while the caller is mounted (SCRUM-631).
 *
 * The dashboard's locale lives in client state, so a localized section title can
 * only be set here, not from server metadata. A few routes also export a static
 * English `metadata.title`, which Next may write into <head> after this effect has
 * run (streamed metadata, client navigation) — so the title is re-applied whenever
 * <head> changes. Passing `null` leaves the title to the route's own metadata.
 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (!title) return;
    const apply = () => {
      if (document.title !== title) document.title = title;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [title]);
}
