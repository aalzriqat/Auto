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

  // SCRUM-624: separators inside a number also sit between two numbers, so a
  // year or price written next to the mobile was glued onto it and the whole
  // run rejected — no mobile, so no lead under requires-mobile.
  test.each([
    ["Elantra 2020 0791234567", "0791234567"],
    ["15000, 0791234567", "0791234567"],
    ["السعر 15000 0791234567", "0791234567"],
    ["2020 079 123 4567", "0791234567"],
    ["0791234567 / 0781234567", "0791234567"],
    ["0791234567 0781234567", "0791234567"],
    ["15000 +962 79 123 4567", "+962791234567"],
    ["962791234567", "+962791234567"],
    ["962 79 123 4567", "+962791234567"],
    ["791234567", "0791234567"],
    ["962 0791234567", "+962791234567"],
  ])("finds the mobile beside other digits: %s", (text, expected) => {
    expect(extractSharedMobileNumber(text)?.normalized).toBe(expected);
  });

  test("a year, price or mileage on its own is still not a mobile", () => {
    for (const text of ["2020 2021", "15000, 20000", "150000 km", "12345678", "1234567890", "751234567", "Elantra 2020 15000"]) {
      expect(extractSharedMobileNumber(text)).toBeNull();
    }
  });

  // A mobile without its trunk zero is only trusted when written as one
  // number: joining groups would turn mileage + price into a phone.
  test.each(["78000 7500", "79000 1500", "2018 79000 8500", "7900 12345", "79 123 4567"])(
    "separate numbers never join into a zero-less mobile: %s",
    (text) => {
      expect(extractSharedMobileNumber(text)).toBeNull();
    }
  );

  // A foreign country code means a foreign number, not a Jordanian tail.
  test.each([
    "+213 779 123 456",
    "+212 778 123 456",
    "+33 7 79 12 34 56",
    "0033 7 79 12 34 56",
    "+971 79 123 4567",
    "+20 100 779 123 456",
    "+213 779123456",
  ])("a foreign number is not read as Jordanian: %s", (text) => {
    expect(extractSharedMobileNumber(text)).toBeNull();
  });

  test.each(["962 (0)79 910 3353", "962 0799103353", "9620799103353"])(
    "matches a dealer number stored as %s",
    (stored) => {
      const excluded = ownNumberExclusions({ dealershipPhone: stored });
      expect(excluded.size).toBe(3);
      expect(extractSharedMobileNumber(`call ${stored}`, excluded)).toBeNull();
    }
  );

  test("excludes every number in a field that holds several", () => {
    const excluded = ownNumberExclusions({ dealershipPhone: "0799103353 / 0788888888" });
    expect(extractSharedMobileNumber("Call us 0799103353 / 0788888888", excluded)).toBeNull();
    expect(extractSharedMobileNumber("Call us 0799103353 / 0788888888 — mine 0781234567", excluded)?.normalized).toBe(
      "0781234567"
    );
  });

  test("the dealer's number glued to the sender's still yields the sender's", () => {
    const excluded = ownNumberExclusions({ dealershipPhone: "0799103353" });
    expect(extractSharedMobileNumber("0799103353 / 0781234567", excluded)?.normalized).toBe("0781234567");
    expect(extractSharedMobileNumber("0799103353 0781234567", excluded)?.normalized).toBe("0781234567");
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

  test("matches a dealer number stored without a + or 00 prefix", () => {
    // dealershipPhone is stored exactly as typed and is not even trimmed on
    // write, so a bare "962..." is a real stored shape. It parses on its own
    // as neither local nor international, which silently produced an empty
    // exclusion set and reinstated the original bug.
    const excluded = ownNumberExclusions({ dealershipPhone: "962799103353" });
    expect(excluded.size).toBeGreaterThan(0);
    expect(extractSharedMobileNumber("0799103353", excluded)).toBeNull();
    expect(extractSharedMobileNumber("+962799103353", excluded)).toBeNull();
  });

  test("tolerates untrimmed stored numbers", () => {
    const excluded = ownNumberExclusions({ dealershipPhone: "  0799103353  " });
    expect(extractSharedMobileNumber("call 0799103353", excluded)).toBeNull();
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
