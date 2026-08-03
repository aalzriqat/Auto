"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { PaginationStatus } from "convex/react";

/** How long a highlighted row stays visually marked after being scrolled to. */
const HIGHLIGHT_DURATION_MS = 4000;

interface UseHighlightRowPagination {
  status: PaginationStatus;
  loadMore: (numItems: number) => void;
  /** Page size for each auto-load-more call while hunting for the row. */
  batchSize?: number;
}

interface UseHighlightRowOptions<T> {
  /** The rows currently loaded on the page. `undefined` while loading. */
  rows: T[] | undefined;
  getId: (row: T) => string;
  /**
   * For usePaginatedQuery-backed tables: keeps calling `loadMore` until the
   * target row is loaded. Omit for tables that load their full dataset up front.
   */
  pagination?: UseHighlightRowPagination;
  /** Query parameter carrying the row id. */
  paramName?: string;
}

/**
 * Finds the row element that is actually on screen.
 *
 * These pages render the same record twice — a card list for mobile
 * (`md:hidden`) and a table for desktop (`hidden md:block`) — both carrying
 * `id="row-<id>"`. `getElementById` returns whichever comes first in the
 * document, which is the mobile card, so on a desktop viewport the scroll was
 * being aimed at a `display:none` element and did nothing at all. Picking the
 * rendered one is what makes the scroll work on both layouts.
 */
function findVisibleRow(rowId: string): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    `[id="row-${CSS.escape(rowId)}"]`
  );
  for (const candidate of candidates) {
    // getClientRects() is empty when the element or any ancestor is hidden.
    if (candidate.getClientRects().length > 0) return candidate;
  }
  return candidates[0] ?? null;
}

/**
 * Scrolls to and briefly highlights the row named by `?highlightId=`.
 *
 * Notifications deep-link here, and the reason they so often appeared to do
 * nothing is that the target row usually was not loaded: these tables open on
 * one page of results, and the old per-page effects looked the row up with
 * `getElementById` against whatever happened to be rendered. A notification
 * about a record outside that first page found no element and silently gave
 * up — and since `customers.list` is ordered oldest-first, a notification
 * about a *newly created* customer could essentially never resolve.
 *
 * So this pages forward until the row actually exists, then scrolls to it.
 * Returns the id to mark as highlighted, or null.
 *
 * Rows must render `id={`row-${id}`}` for the scroll to find them.
 */
export function useHighlightRow<T>({
  rows,
  getId,
  pagination,
  paramName = "highlightId",
}: UseHighlightRowOptions<T>): string | null {
  const searchParams = useSearchParams();
  const highlightId = searchParams.get(paramName);
  // Tracks which id has already had its moment, so the highlight is derived
  // rather than mirrored into state — the effect below only writes on the
  // timer, never synchronously during render.
  const [fadedId, setFadedId] = useState<string | null>(null);

  const isLoaded = !!highlightId && !!rows?.some((row) => getId(row) === highlightId);
  const paginationStatus = pagination?.status;
  const highlightedId = isLoaded && highlightId !== fadedId ? highlightId : null;

  useEffect(() => {
    if (!highlightId || isLoaded) return;
    if (paginationStatus === "CanLoadMore") {
      pagination?.loadMore(pagination.batchSize ?? 100);
    }
    // `pagination` is a fresh object each render, so it cannot be a dependency
    // without re-firing on every render. Re-run only when the target changes
    // or another page finishes loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, isLoaded, paginationStatus]);

  useEffect(() => {
    if (!highlightId || !isLoaded) return;
    // The row rendered in the same commit that made `isLoaded` true, so the
    // element is in the DOM by the time this effect runs.
    findVisibleRow(highlightId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timeout = setTimeout(() => setFadedId(highlightId), HIGHLIGHT_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [highlightId, isLoaded]);

  return highlightedId;
}
