import { describe, it, expect } from "vitest";
import { matchIntent, normalizeText, detectLocale } from "./smartReplyIntent";

describe("matchIntent", () => {
  it("matches price intent in English", () => {
    expect(matchIntent("how much is this car")).toBe("price");
    expect(matchIntent("what's the price?")).toBe("price");
  });

  it("matches price intent in Arabic", () => {
    expect(matchIntent("بكم هاي السياره")).toBe("price");
    expect(matchIntent("كم سعرها")).toBe("price");
  });

  it("matches financing intent", () => {
    expect(matchIntent("monthly installment please")).toBe("financing");
    expect(matchIntent("بدي اقساط")).toBe("financing");
  });

  it("matches availability intent", () => {
    expect(matchIntent("is it still available?")).toBe("availability");
    expect(matchIntent("بيعت؟")).toBe("availability");
  });

  it("matches vehicleInfo intent", () => {
    expect(matchIntent("what's the mileage")).toBe("vehicleInfo");
    expect(matchIntent("كم ماشيه")).toBe("vehicleInfo");
  });

  it("matches location intent", () => {
    expect(matchIntent("where is your showroom")).toBe("location");
    expect(matchIntent("وين المعرض")).toBe("location");
  });

  it("matches complaint intent", () => {
    expect(matchIntent("there is a problem with the car")).toBe("complaint");
    expect(matchIntent("عندي شكوى")).toBe("complaint");
  });

  it("matches greeting intent only as a fallback", () => {
    expect(matchIntent("hello there")).toBe("greeting");
    expect(matchIntent("hi, how much is it")).toBe("price");
  });

  it("returns null for unrelated text", () => {
    expect(matchIntent("nice car!")).toBeNull();
    expect(matchIntent("🔥🔥🔥")).toBeNull();
  });

  it("returns null for empty/undefined input", () => {
    expect(matchIntent(undefined)).toBeNull();
    expect(matchIntent("")).toBeNull();
    expect(matchIntent("   ")).toBeNull();
  });

  it("prioritizes complaint over every other intent", () => {
    expect(matchIntent("price problem, this is wrong")).toBe("complaint");
  });

  it("prioritizes price over financing when both appear", () => {
    expect(matchIntent("price and installments?")).toBe("price");
  });
});

describe("normalizeText", () => {
  it("collapses Arabic diacritics and alef/ta-marbuta variants so spelling variants match", () => {
    expect(normalizeText("السَّيَّارَة")).toBe(normalizeText("السياره"));
    expect(normalizeText("أين")).toContain("اين");
  });

  it("lowercases English text", () => {
    expect(normalizeText("HOW MUCH")).toBe("how much");
  });
});

describe("detectLocale", () => {
  it("detects Arabic-majority text", () => {
    expect(detectLocale("بكم السياره")).toBe("ar");
  });

  it("detects Latin-majority text", () => {
    expect(detectLocale("how much is it")).toBe("en");
  });

  it("returns null for emoji-only or numeric-only text", () => {
    expect(detectLocale("🔥🔥🔥")).toBeNull();
    expect(detectLocale("12345")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(detectLocale(undefined)).toBeNull();
  });
});
