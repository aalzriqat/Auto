"use client";
import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

interface UseTableControlsOptions<T> {
  data: T[] | undefined;
  /** Returns the values to match the search query against. */
  searchFields?: (item: T) => Array<string | number | null | undefined>;
  /** Maps a sort key to the value used to compare rows for that column. */
  sortAccessors?: Record<string, (item: T) => string | number | null | undefined>;
  defaultSortKey?: string;
  defaultSortDir?: SortDir;
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
}: UseTableControlsOptions<T>) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSortKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaultSortDir);

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

  return { search, setSearch, sortKey, sortDir, toggleSort, rows };
}
