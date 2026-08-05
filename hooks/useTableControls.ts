"use client";
import { useEffect, useMemo, useState } from "react";
import type { PaginationStatus } from "convex/react";

export type SortDir = "asc" | "desc";

interface UseTableControlsPagination {
  status: PaginationStatus;
  loadMore: (numItems: number) => void;
  /** Page size for each auto-load-more call while searching. Defaults to 200. */
  batchSize?: number;
  /**
   * Keep loading until exhausted while this is true, on top of the two rules
   * below. Set it when a SERVER-side filter is active.
   */
  exhaustWhen?: boolean;
  /**
   * Ceiling on automatic pages, so a filter click cannot fan out into an
   * unbounded request cascade over a long-lived tenant's whole history. Once
   * reached, automatic loading stops and the caller's own load-more affordance
   * takes over — the results are partial, but the UI must say so rather than
   * present them as complete. Defaults to 20.
   */
  maxAutoPages?: number;
  /**
   * Identifies the current query. The page budget resets when it changes, so
   * switching from one filter to another starts a fresh walk instead of
   * inheriting the previous one's spent budget. A boolean like "is a filter
   * active" cannot do this job: moving between two filters leaves it true, and
   * the second filter would then get no automatic pages at all.
   */
  resetKey?: string;
}

interface UseTableControlsOptions<T> {
  data: T[] | undefined;
  /** Returns the values to match the search query against. */
  searchFields?: (item: T) => Array<string | number | null | undefined>;
  /** Maps a sort key to the value used to compare rows for that column. */
  sortAccessors?: Record<string, (item: T) => string | number | null | undefined>;
  defaultSortKey?: string;
  defaultSortDir?: SortDir;
  /**
   * For usePaginatedQuery-backed tables: while `search` is non-empty, keeps
   * calling `loadMore` until the query is exhausted, so results aren't
   * silently limited to whichever page happens to be loaded already. Omit
   * for tables that load their full dataset up front.
   */
  pagination?: UseTableControlsPagination;
}

/**
 * Shared search + sort behavior for table pages. Filters are left to callers
 * since those dimensions differ per table (status, priority, role, etc).
 */
export function useTableControls<T>({
  data,
  searchFields,
  sortAccessors,
  defaultSortKey,
  defaultSortDir = "asc",
  pagination,
}: UseTableControlsOptions<T>) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSortKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaultSortDir);

  const isSearching = search.trim().length > 0;
  const paginationStatus = pagination?.status;
  const loadMore = pagination?.loadMore;
  const batchSize = pagination?.batchSize ?? 200;
  /**
   * A server that pages by documents read — rather than by matches found —
   * hands back pages that are routinely short, and often empty, while matching
   * rows remain further back. Three situations therefore must not stop at the
   * page boundary:
   *
   *  - a search, which is filtered here on the client;
   *  - `exhaustWhen`, for a filter the server applies;
   *  - and having nothing at all to show, which is the one a caller cannot be
   *    relied on to remember. It is also the dangerous one: an empty first page
   *    with more behind it renders as a permanent loading state, where the
   *    unpaginated query used to give an immediate, actionable answer.
   */
  const hasNothingToShow = pagination !== undefined && (data?.length ?? 0) === 0;
  const wantsExhaust = isSearching || pagination?.exhaustWhen === true || hasNothingToShow;

  // Bounded, so a single filter click cannot fan out into one request per page
  // of a decade's sales. `autoPages` resets whenever the reason for walking
  // changes, which is what makes a fresh filter or search start from zero
  // rather than inheriting the previous walk's budget.
  const maxAutoPages = pagination?.maxAutoPages ?? 20;
  const resetKey = pagination?.resetKey;
  const [autoPages, setAutoPages] = useState(0);
  useEffect(() => {
    setAutoPages(0);
  }, [isSearching, pagination?.exhaustWhen, resetKey]);

  const shouldExhaust = wantsExhaust && autoPages < maxAutoPages;
  useEffect(() => {
    if (shouldExhaust && paginationStatus === "CanLoadMore") {
      setAutoPages((n) => n + 1);
      loadMore?.(batchSize);
    }
    // `loadMore`'s identity changes on every call (usePaginatedQuery rebuilds
    // its status object per page), which is what actually drives the walk:
    // status can go CanLoadMore → CanLoadMore with no intermediate state when
    // the next page is already in the client store, and keying only on the
    // status would stall there. Its own in-flight guard makes a repeat call
    // against the same page a no-op, so this cannot thrash.
  }, [shouldExhaust, paginationStatus, loadMore, batchSize]);

  /**
   * True when automatic loading gave up before the query was exhausted. The
   * rows on screen are a prefix, not the whole answer, and a caller that renders
   * "nothing matches" or a total in this state would be asserting something it
   * has not established.
   */
  const autoLoadCapped = wantsExhaust && !shouldExhaust && paginationStatus === "CanLoadMore";

  /**
   * Whether the hook is walking pages by itself right now. Returned rather than
   * left for callers to re-derive: a caller reconstructing this condition will
   * eventually disagree with the hook, and the disagreement shows up as a
   * hidden load-more button beside a banner saying rows are missing — a dead
   * end with no way forward.
   */
  const isAutoLoading = shouldExhaust && paginationStatus === "CanLoadMore";

  function toggleSort(key: string) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortKey(undefined);
      setSortDir("asc");
    }
  }

  const rows = useMemo(() => {
    if (data === undefined) return undefined;
    let result = data;

    if (search.trim() && searchFields) {
      const q = search.trim().toLowerCase();
      result = result.filter((item) =>
        searchFields(item).some(
          (field) => field != null && String(field).toLowerCase().includes(q)
        )
      );
    }

    if (sortKey && sortAccessors?.[sortKey]) {
      const accessor = sortAccessors[sortKey];
      result = [...result].sort((a, b) => {
        const av = accessor(a);
        const bv = accessor(b);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === "number" && typeof bv === "number") {
          return sortDir === "asc" ? av - bv : bv - av;
        }
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      });
    }

    return result;
  }, [data, search, searchFields, sortAccessors, sortKey, sortDir]);

  return { search, setSearch, sortKey, sortDir, toggleSort, rows, autoLoadCapped, isAutoLoading };
}
