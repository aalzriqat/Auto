import { describe, expect, test } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { PaginationStatus } from "convex/react";
import { useTableControls } from "./useTableControls";

/**
 * These cover the auto-continuation, which is load-bearing rather than a
 * convenience: nine tables share this hook, and a walk that stops early
 * silently truncates their search results.
 *
 * The scripted pagination below deliberately mirrors how Convex's real
 * `usePaginatedQuery` behaves as a page resolves — CanLoadMore → LoadingMore →
 * CanLoadMore — because that cycle is what drives the walk. A version of this
 * hook that keyed its effect on a page counter and the `loadMore` identity
 * instead advanced exactly one page and then stalled, which shipped a broken
 * customer search to CI. The first test is the regression guard.
 */

type Row = { id: number; name: string };

function makePagination(pages: Row[][], { viaLoadingMore = false } = {}) {
  let index = 0;
  let loading = false;
  const calls: number[] = [];
  return {
    calls,
    get data(): Row[] {
      return pages.slice(0, index + 1).flat();
    },
    get status(): PaginationStatus {
      if (loading) return "LoadingMore";
      return index >= pages.length - 1 ? "Exhausted" : "CanLoadMore";
    },
    loadMore(n: number) {
      calls.push(n);
      if (index >= pages.length - 1) return;
      if (viaLoadingMore) {
        // Two-phase, like the real thing: the request is in flight before the
        // page lands. `deliver()` is what lands it, so the test controls the
        // timing rather than racing it.
        loading = true;
      } else {
        index += 1;
      }
    },
    /** Completes an in-flight page, taking the status back to CanLoadMore. */
    deliver() {
      if (!loading) return;
      loading = false;
      index += 1;
    },
  };
}

type Options = { exhaustWhen?: boolean; pagesMayBeEmpty?: boolean };

function renderWithPagination(
  pagination: ReturnType<typeof makePagination>,
  options: Options = {}
) {
  return renderHook(() =>
    useTableControls<Row>({
      data: pagination.data,
      searchFields: (r) => [r.name],
      pagination: {
        status: pagination.status,
        loadMore: (n: number) => pagination.loadMore(n),
        batchSize: 10,
        exhaustWhen: options.exhaustWhen,
        pagesMayBeEmpty: options.pagesMayBeEmpty,
      },
    })
  );
}

/**
 * Drives the render/deliver cycle until the scripted pagination settles: each
 * turn lets the hook react to the current status, then lands any in-flight
 * page so the status returns to CanLoadMore — the exact CanLoadMore →
 * LoadingMore → CanLoadMore sequence the real walk depends on.
 */
async function settle(
  pagination: ReturnType<typeof makePagination>,
  rerender: () => void,
  times = 30
) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      rerender();
    });
    pagination.deliver();
    await act(async () => {
      rerender();
    });
  }
}

describe("useTableControls auto-continuation", () => {
  test("walks every page while searching, through the LoadingMore phase", async () => {
    // The regression guard. Each page passes through LoadingMore before it
    // lands, exactly as Convex does, and there are more pages than any single
    // advance could cover — so a hook that stops after one page fails here.
    const pages = Array.from({ length: 8 }, (_, i) => [{ id: i, name: `Row ${i}` }]);
    pages.push([{ id: 99, name: "Needle" }]);
    const pagination = makePagination(pages, { viaLoadingMore: true });
    const { result, rerender } = renderWithPagination(pagination);

    await act(async () => {
      result.current.setSearch("Needle");
    });
    await settle(pagination, rerender);

    expect(pagination.status).toBe("Exhausted");
    expect(result.current.rows).toEqual([{ id: 99, name: "Needle" }]);
  });

  test("keeps loading while a server-side filter is active", async () => {
    const pagination = makePagination([[], [], [{ id: 1, name: "Only match" }]], {
      viaLoadingMore: true,
    });
    const { result, rerender } = renderWithPagination(pagination, { exhaustWhen: true });
    await settle(pagination, rerender);

    expect(pagination.status).toBe("Exhausted");
    expect(result.current.rows).toHaveLength(1);
  });

  test("keeps loading when a post-filtered query has nothing to show, even with no filter", async () => {
    // The default view of an org whose rows all fail the server's candidate
    // rules. Getting this wrong renders a permanent loading state.
    const pagination = makePagination([[], [], []], { viaLoadingMore: true });
    const { rerender } = renderWithPagination(pagination, { pagesMayBeEmpty: true });
    await settle(pagination, rerender);

    expect(pagination.calls.length).toBeGreaterThanOrEqual(2);
    expect(pagination.status).toBe("Exhausted");
  });

  test("an ordinary paginated table does NOT walk on just because it is empty", async () => {
    // Only a query that post-filters its pages may treat "no rows" as "keep
    // reading". Where the server paginates rows directly an empty page IS the
    // answer, and walking on would make every empty table fetch everything —
    // which is how a change made for one page broke another page's E2E test.
    const pagination = makePagination([[], [], [{ id: 1, name: "Later" }]]);
    const { rerender } = renderWithPagination(pagination);
    await settle(pagination, rerender, 5);

    expect(pagination.calls).toEqual([]);
  });

  test("does not load more when there is data and no filter or search", async () => {
    const pagination = makePagination([[{ id: 1, name: "Visible" }], [{ id: 2, name: "Later" }]]);
    const { rerender } = renderWithPagination(pagination);
    await settle(pagination, rerender, 5);

    expect(pagination.calls).toEqual([]);
  });

  test("reports whether it is walking, so a caller never re-derives it", async () => {
    // A caller that reconstructs this condition will eventually disagree with
    // the hook, and the disagreement shows up as a hidden load-more button
    // beside a banner saying rows are missing — a dead end.
    const done = makePagination([[{ id: 1, name: "Only" }]]);
    const finished = renderWithPagination(done, { exhaustWhen: true });
    await act(async () => {});
    expect(finished.result.current.isAutoLoading).toBe(false);

    // Rows on screen, no filter, no search: nothing to walk for, so the caller
    // is free to offer its own control.
    const more = makePagination([[{ id: 1, name: "One" }], [{ id: 2, name: "Two" }]]);
    const idle = renderWithPagination(more);
    await act(async () => {});
    expect(idle.result.current.isAutoLoading).toBe(false);
  });

  test("a table with no pagination never tries to load more, even while searching", async () => {
    const { result } = renderHook(() =>
      useTableControls<Row>({ data: [{ id: 1, name: "Alpha" }], searchFields: (r) => [r.name] })
    );
    await act(async () => {});
    expect(result.current.isAutoLoading).toBe(false);

    // Searching sets the "keep reading" condition, but there is nothing to read
    // from — claiming otherwise would have a caller hide its own controls
    // waiting for a load that can never arrive.
    await act(async () => {
      result.current.setSearch("Alpha");
    });
    expect(result.current.isAutoLoading).toBe(false);
    expect(result.current.rows).toEqual([{ id: 1, name: "Alpha" }]);
  });
});

describe("useTableControls saved sorting", () => {
  test("programmatic sort restores both the saved column and direction", () => {
    const data = [{ id: 1, name: "Alpha" }, { id: 2, name: "Zulu" }];
    const { result } = renderHook(() =>
      useTableControls<Row>({
        data,
        sortAccessors: { name: (row) => row.name },
      })
    );

    act(() => result.current.setSort("name", "desc"));

    expect(result.current.sortKey).toBe("name");
    expect(result.current.sortDir).toBe("desc");
    expect(result.current.rows?.map((row) => row.name)).toEqual(["Zulu", "Alpha"]);
  });
});
