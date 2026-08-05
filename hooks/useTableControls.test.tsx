import { describe, expect, test, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { PaginationStatus } from "convex/react";
import { useTableControls } from "./useTableControls";

/**
 * These cover the auto-continuation, which is load-bearing rather than a
 * convenience. A server that pages by DOCUMENTS READ hands back pages that are
 * routinely short and often empty while matching rows remain further back, so
 * a table that stops at the first page reports "nothing matches" over real
 * work. On the commissions page that is the exact closed loop the whole feature
 * exists to open — and every server-side test still passes when the wiring is
 * deleted, because the tests do their own paging.
 */

type Row = { id: number; name: string };

/**
 * A scripted `usePaginatedQuery`. `loadMore` gets a fresh identity per call, as
 * Convex's does (its status object is rebuilt per page), because that identity
 * change is what actually advances the loop.
 */
function makePagination(pages: Row[][]) {
  let index = 0;
  const calls: number[] = [];
  const state = {
    calls,
    get data(): Row[] {
      return pages.slice(0, index + 1).flat();
    },
    get status(): PaginationStatus {
      return index >= pages.length - 1 ? "Exhausted" : "CanLoadMore";
    },
    loadMore: (n: number) => {
      calls.push(n);
      if (index < pages.length - 1) index += 1;
    },
  };
  return state;
}

function renderWithPagination(
  pagination: ReturnType<typeof makePagination>,
  options: { exhaustWhen?: boolean; maxAutoPages?: number } = {}
) {
  return renderHook(() =>
    useTableControls<Row>({
      data: pagination.data,
      searchFields: (r) => [r.name],
      pagination: {
        status: pagination.status,
        // A new function identity per render, mirroring Convex.
        loadMore: (n: number) => pagination.loadMore(n),
        batchSize: 10,
        exhaustWhen: options.exhaustWhen,
        maxAutoPages: options.maxAutoPages,
      },
    })
  );
}

describe("useTableControls auto-continuation", () => {
  test("keeps loading while a server-side filter is active", async () => {
    // Three pages, and only the last has anything on it — the shape a filtered
    // page-by-documents query produces for a worked-down review queue.
    const pagination = makePagination([[], [], [{ id: 1, name: "Only match" }]]);
    const { result, rerender } = renderWithPagination(pagination, { exhaustWhen: true });

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        rerender();
      });
    }

    expect(pagination.calls.length).toBeGreaterThanOrEqual(2);
    expect(pagination.status).toBe("Exhausted");
    expect(result.current.rows).toHaveLength(1);
  });

  test("keeps loading when there is nothing to show, even with no filter", async () => {
    // The default view of an org whose sales all fail the candidate rules. This
    // is the case a caller cannot be relied on to opt into, and getting it
    // wrong renders a permanent loading state where the unpaginated query gave
    // an immediate answer.
    const pagination = makePagination([[], [], []]);
    renderWithPagination(pagination);

    for (let i = 0; i < 5; i++) {
      await act(async () => {
        // no-op rerender
      });
    }

    expect(pagination.calls.length).toBeGreaterThanOrEqual(2);
    expect(pagination.status).toBe("Exhausted");
  });

  test("does not load more when there is data and no filter or search", async () => {
    const pagination = makePagination([[{ id: 1, name: "Visible" }], [{ id: 2, name: "Later" }]]);
    renderWithPagination(pagination);

    await act(async () => {});

    expect(pagination.calls).toEqual([]);
  });

  test("stops at the page ceiling instead of walking the whole history", async () => {
    const pages = Array.from({ length: 30 }, () => [] as Row[]);
    pages.push([{ id: 99, name: "Deep" }]);
    const pagination = makePagination(pages);
    const { result } = renderWithPagination(pagination, { exhaustWhen: true, maxAutoPages: 3 });

    for (let i = 0; i < 10; i++) {
      await act(async () => {});
    }

    // Bounded fan-out: a filter click must not turn into one request per page
    // of a decade's sales.
    expect(pagination.calls.length).toBe(3);
    // And the caller is told the answer is a prefix, not the whole of it.
    expect(result.current.autoLoadCapped).toBe(true);
  });

  test("searching exhausts too, so results are not limited to the loaded page", async () => {
    const pagination = makePagination([
      [{ id: 1, name: "Alpha" }],
      [{ id: 2, name: "Beta" }],
      [{ id: 3, name: "Needle" }],
    ]);
    const { result, rerender } = renderWithPagination(pagination);

    await act(async () => {
      result.current.setSearch("Needle");
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        rerender();
      });
    }

    expect(result.current.rows).toEqual([{ id: 3, name: "Needle" }]);
  });

  test("a table with no pagination never tries to load more", async () => {
    const { result } = renderHook(() =>
      useTableControls<Row>({ data: [], searchFields: (r) => [r.name] })
    );
    await act(async () => {});
    expect(result.current.rows).toEqual([]);
    expect(result.current.autoLoadCapped).toBe(false);
  });
});
