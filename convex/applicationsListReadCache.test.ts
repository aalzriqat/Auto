import { describe, expect, test, vi } from "vitest";
import { memoizePointRead } from "./applications";

describe("applications.list point reads", () => {
  test("coalesces concurrent reads of one document while retaining distinct and missing documents", async () => {
    const read = vi.fn(async (id: string) => id === "missing" ? null : { id });
    const get = memoizePointRead(read);

    const results = await Promise.all([
      get("shared"), get("shared"), get("other"), get("missing"), get("missing"),
    ]);

    expect(results).toEqual([
      { id: "shared" }, { id: "shared" }, { id: "other" }, null, null,
    ]);
    expect(read.mock.calls.map(([id]) => id)).toEqual(["shared", "other", "missing"]);
  });

  test("does not reuse a document across query executions", async () => {
    const read = vi.fn(async (id: string) => ({ id }));

    expect(await memoizePointRead(read)("shared")).toEqual({ id: "shared" });
    expect(await memoizePointRead(read)("shared")).toEqual({ id: "shared" });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
