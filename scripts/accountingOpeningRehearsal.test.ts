import { describe, expect, test, vi } from "vitest";
import { journals } from "./accountingOpeningRehearsal.mjs";

type Must = (kind: string, endpoint: string, args: Record<string, unknown>) => Promise<unknown>;

interface PaginationArgs {
  orgId: string;
  paginationOpts: { numItems: number; cursor: string | null };
}

describe("SCRUM-762: opening rehearsal multi-page bounded journal inventory readback", () => {
  const makeEntry = (id: string, memo = "rehearsal journal") => ({
    _id: id,
    memo,
    accountingDate: 1729000000000,
    periodId: "period_1",
    status: "POSTED",
  });

  test("single-page inventory returns complete journal rows without subsequent queries", async () => {
    const entries = Array.from({ length: 45 }, (_, i) => makeEntry(`j_${i + 1}`));
    const must = vi.fn().mockResolvedValue({
      page: entries,
      isDone: true,
      continueCursor: "cursor_45",
    });

    const result = await journals(must as unknown as Must, "org_single_page");
    expect(must).toHaveBeenCalledTimes(1);
    expect(must).toHaveBeenCalledWith("query", "accountingLedger:listJournalEntries", {
      orgId: "org_single_page",
      paginationOpts: { numItems: 100, cursor: null },
    });
    expect(result).toHaveLength(45);
    expect(result[0]._id).toBe("j_1");
    expect(result[44]._id).toBe("j_45");
  });

  test("multi-page boundary inventory walks all pages to terminal isDone: true (cloud failure reproduction)", async () => {
    // 250 entries across 3 pages: 100 on page 1, 100 on page 2, 50 on page 3.
    const page1Entries = Array.from({ length: 100 }, (_, i) => makeEntry(`j_${i + 1}`));
    const page2Entries = Array.from({ length: 100 }, (_, i) => makeEntry(`j_${i + 101}`));
    const page3Entries = Array.from({ length: 50 }, (_, i) => makeEntry(`j_${i + 201}`));

    const must = vi.fn().mockImplementation(async (_kind: string, _endpoint: string, rawArgs: unknown) => {
      const args = rawArgs as PaginationArgs;
      if (args.paginationOpts.cursor === null) {
        return { page: page1Entries, isDone: false, continueCursor: "c_100" };
      }
      if (args.paginationOpts.cursor === "c_100") {
        return { page: page2Entries, isDone: false, continueCursor: "c_200" };
      }
      if (args.paginationOpts.cursor === "c_200") {
        return { page: page3Entries, isDone: true, continueCursor: "c_250" };
      }
      throw new Error(`Unexpected cursor: ${args.paginationOpts.cursor}`);
    });

    const result = await journals(must as unknown as Must, "org_multi_page");
    expect(must).toHaveBeenCalledTimes(3);
    expect(must).toHaveBeenNthCalledWith(1, "query", "accountingLedger:listJournalEntries", {
      orgId: "org_multi_page",
      paginationOpts: { numItems: 100, cursor: null },
    });
    expect(must).toHaveBeenNthCalledWith(2, "query", "accountingLedger:listJournalEntries", {
      orgId: "org_multi_page",
      paginationOpts: { numItems: 100, cursor: "c_100" },
    });
    expect(must).toHaveBeenNthCalledWith(3, "query", "accountingLedger:listJournalEntries", {
      orgId: "org_multi_page",
      paginationOpts: { numItems: 100, cursor: "c_200" },
    });

    expect(result).toHaveLength(250);
    expect(result[0]._id).toBe("j_1");
    expect(result[99]._id).toBe("j_100");
    expect(result[100]._id).toBe("j_101");
    expect(result[199]._id).toBe("j_200");
    expect(result[200]._id).toBe("j_201");
    expect(result[249]._id).toBe("j_250");
  });

  test("hard page budget refusal fails closed when inventory exceeds maxPages without completion", async () => {
    let callCount = 0;
    const must = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        page: [makeEntry(`j_${callCount}`)],
        isDone: false,
        continueCursor: `c_${callCount}`,
      };
    });

    await expect(journals(must as unknown as Must, "org_budget_pages", { maxPages: 4 })).rejects.toThrow(
      "Opening assertion refused: bounded journal inventory complete"
    );
    expect(must).toHaveBeenCalledTimes(4);
  });

  test("hard row budget refusal fails closed when total inventory exceeds maxEntries", async () => {
    const page = Array.from({ length: 80 }, (_, i) => makeEntry(`j_${i + 1}`));
    let pageNum = 0;
    const must = vi.fn().mockImplementation(async () => {
      pageNum++;
      return {
        page,
        isDone: pageNum >= 3,
        continueCursor: `c_${pageNum}`,
      };
    });

    await expect(journals(must as unknown as Must, "org_budget_rows", { maxEntries: 150 })).rejects.toThrow(
      "Opening assertion refused: journal inventory exceeded row budget"
    );
  });

  test("repeated cursor detection prevents infinite loops and fails closed", async () => {
    let callCount = 0;
    const must = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        page: [makeEntry(`j_${callCount}`)],
        isDone: false,
        continueCursor: "stuck_cursor",
      };
    });

    await expect(journals(must as unknown as Must, "org_stuck_cursor")).rejects.toThrow(
      "Opening assertion refused: repeated cursor in journal pagination"
    );
    expect(must).toHaveBeenCalledTimes(2);
  });

  test("non-progress detection fails closed on empty non-terminal page", async () => {
    const must = vi.fn().mockResolvedValue({
      page: [],
      isDone: false,
      continueCursor: "empty_non_terminal",
    });

    await expect(journals(must as unknown as Must, "org_empty_page")).rejects.toThrow(
      "Opening assertion refused: non-progress in journal pagination"
    );
  });

  test("missing continuation cursor on non-terminal page fails closed", async () => {
    const must = vi.fn().mockResolvedValue({
      page: [makeEntry("j_1")],
      isDone: false,
      continueCursor: "",
    });

    await expect(journals(must as unknown as Must, "org_missing_cursor")).rejects.toThrow(
      "Opening assertion refused: missing continuation cursor"
    );
  });

  test("malformed completion status fails closed", async () => {
    const must = vi.fn().mockResolvedValue({
      page: [makeEntry("j_1")],
      isDone: "not-a-boolean",
      continueCursor: "c_1",
    });

    await expect(journals(must as unknown as Must, "org_malformed_done")).rejects.toThrow(
      "Opening assertion refused: malformed pagination completion status"
    );
  });

  test("malformed row set fails closed", async () => {
    const must = vi.fn().mockResolvedValue({
      page: "not-an-array",
      isDone: true,
    });

    await expect(journals(must as unknown as Must, "org_malformed_page")).rejects.toThrow(
      "Opening public row set unavailable"
    );
  });

  test("malformed readback response fails closed", async () => {
    const must = vi.fn().mockResolvedValue(null);

    await expect(journals(must as unknown as Must, "org_null_readback")).rejects.toThrow(
      "Opening public readback unavailable"
    );
  });
});
