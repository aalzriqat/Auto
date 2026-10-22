import { describe, expect, it } from "vitest";
import { chartKeysById, syntheticVin } from "./browserSwarmSeedHelpers";

describe("MONEY_BOUNDARY seed helpers", () => {
  it("builds a 17-character VIN from the prefix and nonce, without the letters a VIN forbids", () => {
    const vin = syntheticVin("FEEV1", "run-1");
    expect(vin).toMatch(/^FEEV1[0-9A-F]{12}$/);
    expect(vin).toHaveLength(17);
    expect(syntheticVin("FEEV1", "run-1")).toBe(vin);
    expect(syntheticVin("FEEV1", "run-2")).not.toBe(vin);
    expect(syntheticVin("MNYB1", "run-1")).not.toBe(vin);
  });

  it("keys the chart by system key, falling back to the code, and skips accounts it cannot key", () => {
    const keys = chartKeysById([
      { _id: "a", systemKey: "BANK_ACCOUNT", code: "1100" },
      { _id: "b", code: "5200" },
      { _id: "c" },
      { systemKey: "NO_ID" },
      "not a record",
      null,
    ]);
    expect([...keys]).toEqual([
      ["a", "BANK_ACCOUNT"],
      ["b", "5200"],
    ]);
  });
});
