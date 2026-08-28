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
   * Keep loading until exhausted while this is true, for the same reason
   * searching does. Set it when a SERVER-side filter is active: the server
   * decides which rows qualify, so a page can come back short or empty while
   * matching rows remain further back.
   */
  exhaustWhen?: boolean;
  /**
   * Declares that the server's pages are post-filtered — it reads a fixed
   * number of DOCUMENTS and returns only those that qualify — so a page can
   * come back short, or empty, while matching rows remain further back. For
   * such a query "no rows yet" is not an answer, and stopping on it renders a
   * permanent empty/loading state over real data.
   *
   * A property of the query, not a preference: a table whose server paginates
   * rows directly must leave this off, because there an empty page genuinely
   * means there is nothing to find.
   */
  pagesMayBeEmpty?: boolean;
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
  /**
   * Three reasons the table must not stop at the page boundary, all of them
   * the same underlying problem — the rows on screen are not the answer:
   *
   *  - a search, which is filtered here on the client;
   *  - `exhaustWhen`, for a filter the server applies;
   *  - and, for a query that declares `pagesMayBeEmpty`, having nothing at all
   *    to show. An empty first page with more behind it otherwise renders as a
   *    permanent loading state. Gated on the declaration rather than applied
   *    to every paginated table: where the server paginates rows directly, an
   *    empty page IS the answer.
   */
  const shouldExhaust =
    isSearching ||
    pagination?.exhaustWhen === true ||
    (pagination?.pagesMayBeEmpty === true && (data?.length ?? 0) === 0);
  useEffect(() => {
    if (shouldExhaust && paginationStatus === "CanLoadMore") {
      pagination?.loadMore(pagination.batchSize ?? 200);
    }
    // Deliberately only these two. The walk is driven by the status cycling
    // CanLoadMore → LoadingMore → CanLoadMore as each page resolves; adding
    // `loadMore` or a page counter here stalled it after a single page, which
    // silently truncated search results on every paginated table in the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldExhaust, paginationStatus]);

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

  function setSort(key: string | undefined, direction: SortDir = "asc") {
    setSortKey(key);
    setSortDir(direction);
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

  /** True while the hook is walking pages by itself, so a caller does not
   *  offer a manual control that would race it — or, worse, re-derive this
   *  condition and disagree with the hook about it. A table with no pagination
   *  is never walking: `paginationStatus` is undefined there, which is not
   *  "Exhausted", so searching one would otherwise claim a load that cannot
   *  happen. */
  const isAutoLoading =
    pagination !== undefined && shouldExhaust && paginationStatus !== "Exhausted";

  return { search, setSearch, sortKey, sortDir, toggleSort, setSort, rows, isAutoLoading };
}
