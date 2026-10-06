import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { saleCompletedKey } from "./postingRules";

describe("saleCompletedKey", () => {
  test("is the SALE_COMPLETED idempotency key every reader and writer spells", () => {
    const id = "k17abc123" as Id<"sales">;
    expect(saleCompletedKey(id)).toBe("sale_completed_" + id);
  });
});
