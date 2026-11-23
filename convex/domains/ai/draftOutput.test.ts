// @vitest-environment node
import { describe, expect, test } from "vitest";
import { buildDraftContext, type DraftContext, type DraftMessage } from "./draftContext";
import { HANDOVER_SENTENCE_AR, HANDOVER_SENTENCE_EN, decideDraft } from "./draftOutput";

const EN_HANDOVER = "Thank you for your message. One of our sales team will get back to you shortly with the details.";
const AR_HANDOVER = "شكرًا لتواصلك معنا. سيتواصل معك أحد موظفي المبيعات قريبًا لتزويدك بالتفاصيل.";

const VEHICLE = {
  year: 2022,
  make: "Toyota",
  model: "Camry",
  mileage: 30000,
  color: "White",
  fuelType: "Petrol",
  transmission: "Automatic",
  sellingPrice: 100000,
  status: "AVAILABLE",
};

function context(messages: DraftMessage[] = [{ direction: "customer", text: "How much is it?" }]): DraftContext {
  return buildDraftContext({
    org: { dealershipName: "Sunrise Motors", currencySymbol: "SAR" },
    vehicle: VEHICLE,
    financing: { monthlyAmount: 1677, termMonths: 60, downPaymentPercent: 20 },
    messages,
  });
}

function draft(text: string, ctx: DraftContext = context()) {
  return decideDraft({ outcome: "draft", text }, ctx);
}

describe("handover sentences", () => {
  test("are the fixed texts", () => {
    expect(HANDOVER_SENTENCE_EN).toBe(EN_HANDOVER);
    expect(HANDOVER_SENTENCE_AR).toBe(AR_HANDOVER);
  });
});

describe("output check", () => {
  test("a clean draft is ready and fills every token from the given values", () => {
    expect(draft("Hello from {{DEALERSHIP_NAME}}! The {{VEHICLE_NAME}} is {{LISTED_PRICE}}, about {{MONTHLY_PAYMENT}} a month.")).toEqual({
      status: "ready",
      text: "Hello from Sunrise Motors! The Toyota Camry is 100000 SAR, about 1677 SAR a month.",
      handoverFallback: false,
    });
  });

  test("the price comes from the given number, not from the model", () => {
    const cheap = buildDraftContext({
      org: { currencySymbol: "SAR" },
      vehicle: { ...VEHICLE, sellingPrice: 7 },
      financing: null,
      messages: [{ direction: "customer", text: "price?" }],
    });
    expect(draft("It is {{LISTED_PRICE}} {{LISTED_PRICE}}", cheap)).toEqual({
      status: "ready",
      text: "It is 7 SAR 7 SAR",
      handoverFallback: false,
    });
  });

  test("filling is literal, replacement patterns in a value are not interpreted", () => {
    const odd = buildDraftContext({
      org: { dealershipName: "Joe's $& $1 Cars" },
      vehicle: null,
      financing: null,
      messages: [{ direction: "customer", text: "hi" }],
    });
    expect(draft("Welcome to {{DEALERSHIP_NAME}}", odd)).toEqual({
      status: "ready",
      text: "Welcome to Joe's $& $1 Cars",
      handoverFallback: false,
    });
  });

  test("a percent sign right after the down payment token is allowed", () => {
    expect(draft("Down payment is {{DOWN_PAYMENT_PERCENT}}% of the price")).toMatchObject({
      status: "ready",
      handoverFallback: false,
    });
  });

  const REJECTED: [string, string][] = [
    ["ASCII digits with percent", "We can do 10% off"],
    ["zero percent", "0% interest"],
    ["Arabic percent sign alone", "خصم ٪ خاص"],
    ["thousand shorthand", "Only 5k"],
    ["Arabic-Indic digits U+0660 to U+0669", "السعر ٢٠٠٠"],
    ["Persian digits U+06F0 to U+06F9", "قیمت ۲۰۰۰"],
    ["fullwidth digits", "Only ２０００"],
    ["superscript digit", "Only 2² "],
    ["unknown token", "Price {{DISCOUNT_PRICE}}"],
    ["token without a value for this conversation", "Call {{PHONE}}"],
    ["malformed token", "Price {{ LISTED_PRICE }}"],
    ["single brace token", "Price {LISTED_PRICE}"],
    ["percent sign elsewhere", "Down payment is {{LISTED_PRICE}}%"],
    ["https URL", "See https://example.test/car"],
    ["scheme separator", "go to ftp://example.test"],
    ["www host", "See www.example.test"],
    ["at handle", "DM @someone"],
    ["empty text", ""],
    ["blank text", "   \n "],
  ];

  test.each(REJECTED)("%s becomes the English handover sentence", (_name, text) => {
    expect(draft(text)).toEqual({ status: "ready", text: EN_HANDOVER, handoverFallback: true });
  });

  test("more than 1,000 UTF-8 bytes after the tokens are filled becomes the handover", () => {
    const long = "ab ".repeat(333) + "ab";
    expect(new TextEncoder().encode(long).length).toBe(1001);
    expect(draft(long)).toEqual({ status: "ready", text: EN_HANDOVER, handoverFallback: true });
    expect(draft("ab ".repeat(333))).toMatchObject({ handoverFallback: false });
    // Arabic letters take two bytes each: 501 letters are 1,002 bytes.
    expect(draft("ب".repeat(501))).toEqual({ status: "ready", text: EN_HANDOVER, handoverFallback: true });
    // A short template that expands past the cap once the value is filled.
    const wide = buildDraftContext({
      org: { dealershipName: "N".repeat(1000) },
      vehicle: null,
      financing: null,
      messages: [{ direction: "customer", text: "hi" }],
    });
    expect(draft("Welcome to {{DEALERSHIP_NAME}}", wide)).toEqual({
      status: "ready",
      text: EN_HANDOVER,
      handoverFallback: true,
    });
  });

  test("Arabic letters in the customer's latest message select the Arabic handover sentence", () => {
    const arabic = context([
      { direction: "customer", text: "Hello" },
      { direction: "customer", text: "كم سعر السيارة؟" },
      { direction: "dealership", text: "Let me check" },
    ]);
    expect(draft("Only 5k", arabic)).toEqual({ status: "ready", text: AR_HANDOVER, handoverFallback: true });
    const english = context([
      { direction: "customer", text: "كم سعرها؟" },
      { direction: "customer", text: "And the mileage?" },
    ]);
    expect(draft("Only 5k", english)).toEqual({ status: "ready", text: EN_HANDOVER, handoverFallback: true });
  });

  test("Arabic digits alone in the customer message do not make it Arabic", () => {
    const digitsOnly = context([{ direction: "customer", text: "٢٠٢٢" }]);
    expect(draft("Only 5k", digitsOnly)).toMatchObject({ text: EN_HANDOVER });
  });

  test("needs_person is stored without text", () => {
    expect(decideDraft({ outcome: "needs_person", text: "ignored words" }, context())).toEqual({ status: "needs_person" });
  });
});
