import { describe, expect, test } from "vitest";
import { GAP_RESOLUTION_CLEARED, gapResolutionTransition } from "./financingEconomics";

describe("gapResolutionTransition", () => {
  test("no gap: NOT_REQUIRED, clearing the split only when the gap moved", () => {
    expect(gapResolutionTransition(0, 500, "CUSTOMER_ABSORBS")).toEqual({
      gapResolution: "NOT_REQUIRED",
      ...GAP_RESOLUTION_CLEARED,
    });
    expect(gapResolutionTransition(0, 0, undefined)).toEqual({ gapResolution: "NOT_REQUIRED" });
  });

  test("a moved gap reopens negotiation and voids the split", () => {
    expect(gapResolutionTransition(700, 500, "CUSTOMER_ABSORBS")).toEqual({
      gapResolution: "PENDING_NEGOTIATION",
      ...GAP_RESOLUTION_CLEARED,
    });
  });

  test("an unchanged gap reopens only from unset or FAILED, and keeps the split", () => {
    expect(gapResolutionTransition(500, 500, "FAILED")).toEqual({ gapResolution: "PENDING_NEGOTIATION" });
    expect(gapResolutionTransition(500, 500, undefined)).toEqual({ gapResolution: "PENDING_NEGOTIATION" });
  });

  test("an unchanged gap with a live resolution writes nothing", () => {
    expect(gapResolutionTransition(500, 500, "PENDING_NEGOTIATION")).toBeNull();
    expect(gapResolutionTransition(500, 500, "CUSTOMER_ABSORBS")).toBeNull();
  });
});