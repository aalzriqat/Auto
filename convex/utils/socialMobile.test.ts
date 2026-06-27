import { describe, expect, test } from "vitest";
import { extractSharedMobileNumber } from "./socialMobile";

describe("extractSharedMobileNumber", () => {
  test.each([
    ["call me at +962 79 123 4567", "+962791234567"],
    ["call me at 00962-78-123-4567", "+962781234567"],
    ["direct 0791234567", "0791234567"],
    ["direct 077 123 4567", "0771234567"],
    ["direct 078-123-4567", "0781234567"],
    ["office 06 123 4567", "061234567"],
    ["arabic digits ٠٧٩١٢٣٤٥٦٧", "0791234567"],
  ])("extracts %s", (text, expected) => {
    expect(extractSharedMobileNumber(text)?.normalized).toBe(expected);
  });

  test("ignores ordinary numbers that are not accepted phone formats", () => {
    expect(extractSharedMobileNumber("The price is 25000 and the model is 2025")).toBeNull();
    expect(extractSharedMobileNumber("My number is 0751234567")).toBeNull();
  });
});
