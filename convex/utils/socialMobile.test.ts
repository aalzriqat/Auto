import { describe, expect, test } from "vitest";
import {
  extractSharedMobileNumber,
  ownNumberExclusions,
  splitDisplayName,
  hasDuplicatedName,
} from "./socialMobile";

describe("extractSharedMobileNumber", () => {
  test.each([
    ["call me at +962 79 123 4567", "+962791234567"],
    ["call me at 00962-78-123-4567", "+962781234567"],
    ["direct 0791234567", "0791234567"],
    ["direct 077 123 4567", "0771234567"],
    ["direct 078-123-4567", "0781234567"],
    ["office 06 123 4567", "061234567"],
    ["arabic digits ٠٧٩١٢٣٤٥٦٧", "0791234567"],
    ["arabic digits with spaces ٠٧٩ ١٢٣ ٤٥٦٧", "0791234567"],
    ["arabic digits with punctuation ٠٧٩/١٢٣،٤٥٦٧", "0791234567"],
    ["arabic international +٩٦٢ ٧٩ ١٢٣ ٤٥٦٧", "+962791234567"],
    ["arabic international ٠٠٩٦٢ ٧٧ ١٢٣ ٤٥٦٧", "+962771234567"],
    ["persian digits ۰۷۸ ۱۲۳ ۴۵۶۷", "0781234567"],
    ["bidi controls ‏٠٧٩‏١٢٣‏٤٥٦٧", "0791234567"],
  ])("extracts %s", (text, expected) => {
    expect(extractSharedMobileNumber(text)?.normalized).toBe(expected);
  });

  test("ignores ordinary numbers that are not accepted phone formats", () => {
    expect(extractSharedMobileNumber("The price is 25000 and the model is 2025")).toBeNull();
    expect(extractSharedMobileNumber("My number is 0751234567")).toBeNull();
  });
});

describe("ownNumberExclusions", () => {
  test("skips the dealership's own numbers quoted from its own advert", () => {
    // Replying to a post pulls the advert's caption into the DM payload, so
    // the showroom numbers printed in it were read back as "the customer
    // shared their mobile" — saving the dealer's number onto the customer,
    // satisfying the lead-requires-a-mobile gate, and auto-replying
    // "we received your number".
    const settings = {
      dealershipPhone: "0799103353",
      dealershipPhones: ["0791886203", "+962790888360"],
    };
    const excluded = ownNumberExclusions(settings);
    const advert = "زوروا معرضنا 📞 0799103353 📞 0791886203 📞 0790888360";

    expect(extractSharedMobileNumber(advert)).not.toBeNull();
    expect(extractSharedMobileNumber(advert, excluded)).toBeNull();
  });

  test("matches the dealership's number whatever format it is written in", () => {
    const excluded = ownNumberExclusions({ dealershipPhone: "0799103353" });

    for (const written of ["0799103353", "+962 79 910 3353", "00962799103353"]) {
      expect(extractSharedMobileNumber(written, excluded)).toBeNull();
    }
  });

  test("still finds the sender's own number in a message that quotes the advert", () => {
    const excluded = ownNumberExclusions({ dealershipPhone: "0799103353" });
    const reply = "شفت اعلانكم 0799103353 — رقمي 0781234567";

    expect(extractSharedMobileNumber(reply, excluded)?.normalized).toBe("0781234567");
  });

  test("no configured numbers means nothing is excluded", () => {
    expect(ownNumberExclusions(null).size).toBe(0);
    expect(extractSharedMobileNumber("call 0791234567", ownNumberExclusions(null))?.normalized).toBe(
      "0791234567"
    );
  });
});

describe("splitDisplayName", () => {
  test("a single-word name leaves the surname empty rather than repeating it", () => {
    // Instagram enrichment prefers the account's username, which is always one
    // token — the old splitter copied it into both fields, so the UI joined it
    // back into "mhty7220 mhty7220".
    expect(splitDisplayName("mhty7220")).toEqual({ firstName: "mhty7220", lastName: "" });
  });

  test("keeps multi-word names intact", () => {
    expect(splitDisplayName("Layla Al Nimri")).toEqual({
      firstName: "Layla",
      lastName: "Al Nimri",
    });
  });

  test("collapses stray whitespace", () => {
    expect(splitDisplayName("  Omar   Haddad  ")).toEqual({
      firstName: "Omar",
      lastName: "Haddad",
    });
  });
});

describe("hasDuplicatedName", () => {
  test("detects the old splitter's artifact", () => {
    expect(hasDuplicatedName({ firstName: "mhty7220", lastName: "mhty7220" })).toBe(true);
  });

  test("does not flag ordinary or empty names", () => {
    expect(hasDuplicatedName({ firstName: "Omar", lastName: "Haddad" })).toBe(false);
    expect(hasDuplicatedName({ firstName: "Cher", lastName: "" })).toBe(false);
  });
});
