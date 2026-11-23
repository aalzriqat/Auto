// @vitest-environment node
import { describe, expect, test } from "vitest";
import { buildDraftContext, type DraftContext } from "./draftContext";
import { DRAFT_FORBIDDEN_WORDING, HANDOVER_SENTENCE_EN, decideDraft } from "./draftOutput";

const CONTEXT: DraftContext = buildDraftContext({
  org: { dealershipName: "Sunrise Motors", dealershipAddress: "Main Street", dealershipPhone: "+962 6 000 0000", currencySymbol: "SAR" },
  vehicle: {
    year: 2022,
    make: "Toyota",
    model: "Camry",
    mileage: 30000,
    color: "White",
    fuelType: "Petrol",
    transmission: "Automatic",
    sellingPrice: 100000,
    status: "AVAILABLE",
  },
  financing: { monthlyAmount: 1677, termMonths: 60, downPaymentPercent: 20 },
  messages: [{ direction: "customer", text: "How much is it?" }],
});

function decide(text: string) {
  return decideDraft({ outcome: "draft", text }, CONTEXT);
}

const HANDOVER = { status: "ready", text: HANDOVER_SENTENCE_EN, handoverFallback: true };

// Ruling 11: no discount, negotiation or promise. The wording list is checked
// in code, like a digit, so a hostile or careless model answer cannot reach staff
// as a normal draft.
const BLOCKED: ReadonlyArray<readonly [family: string, text: string]> = [
  ["price cut (ruling example)", "We can go a little under {{LISTED_PRICE}} if you come today"],
  ["negotiation (ruling example)", "السعر {{LISTED_PRICE}} وقابل للتفاوض"],
  ["discount (ruling example)", "خصم عشرة بالمئة"],
  ["commitment (ruling example)", "قسطك الشهري مضمون {{MONTHLY_PAYMENT}} بدون دفعة أولى"],
  ["hold (ruling example)", "We'll hold it for you until tomorrow"],
  ["discount en", "I can offer you a Discount on the {{VEHICLE_NAME}}."],
  ["discount en cheaper", "We can make it cheaper for you."],
  ["discount en lower price", "A lower price is possible."],
  ["discount en price cut", "There may be a price cut."],
  ["discount en reduction", "A reduction is available for you."],
  ["discount en reduce", "We can reduce it."],
  ["discount en off the price", "We can take something off the price."],
  ["discount ar takhfid", "يمكننا تخفيض السعر {{LISTED_PRICE}}."],
  ["discount ar tanzil", "ممكن تنزيل السعر."],
  ["discount ar aqall min", "نستطيع بيعها بأقل من {{LISTED_PRICE}}."],
  ["discount ar arkhas", "نوفر لك سيارة أرخص."],
  ["discount ar diacritics", "عندنا خَصْم خاص لك."],
  ["negotiation en negotiable", "The price is negotiable."],
  ["negotiation en negotiate", "We can negotiate with you."],
  ["negotiation en best price", "Our best price is on the way."],
  ["negotiation ar", "يمكننا التفاوض على السعر."],
  ["negotiation ar akhir sir", "آخر سعر لك سيكون جيدًا."],
  ["negotiation ar alef variant", "اخر سعر عندنا."],
  ["promise en guarantee", "We guarantee the monthly payment."],
  ["promise en promise", "I promise to call you back."],
  ["promise en reserve", "We can reserve it for you."],
  ["promise en set aside", "We will set the car aside for you."],
  ["promise en free", "The inspection is free."],
  ["promise en no down payment", "You can buy with no down payment."],
  ["promise ar mathmoon", "القسط مضمون لك."],
  ["promise ar nadman", "نضمن لك الجودة."],
  ["promise ar wa'd", "هذا وعد منا."],
  ["promise ar na'iduk", "نعدك بالأفضل."],
  ["promise ar hajz", "سنحجز لك السيارة."],
  ["promise ar majjanan", "الفحص مجانًا."],
  ["promise ar majjani", "الفحص مجاني."],
  ["promise ar bidun daf'a", "يمكنك الشراء بدون دفعة."],
  ["amount in words en percent", "Ten percent is the usual figure."],
  ["amount in words en per cent", "Ten per cent is the usual figure."],
  ["amount in words en hundred", "About two hundred."],
  ["amount in words en thousand", "A few thousand."],
  ["amount in words en million", "Close to a million."],
  ["amount in words ar bilmi'a", "عشرة بالمئة."],
  ["amount in words ar bilma'a", "عشرة بالمائة."],
  ["amount in words ar fil mi'a", "عشرة في المئة."],
  ["amount in words ar mi'a", "نحو مئة."],
  ["amount in words ar ma'a", "نحو مائة."],
  ["amount in words ar alf", "نحو ألف."],
  ["amount in words ar alef variant", "إلى آلاف."],
  ["amount in words ar thousands with prefix", "بآلاف قليلة."],
  ["amount in words ar million", "قرابة مليون."],
];

const CONTROLS: ReadonlyArray<readonly [label: string, text: string]> = [
  ["english facts", "The {{VEHICLE_NAME}} is available. The listed price is {{LISTED_PRICE}}."],
  ["arabic facts", "السيارة متوفرة وسعرها {{LISTED_PRICE}}."],
  ["address and phone", "You can visit us at {{ADDRESS}} or call {{PHONE}}."],
  [
    "arabic financing estimate",
    "القسط الشهري التقديري {{MONTHLY_PAYMENT}} لمدة {{TERM_MONTHS}} شهرًا مع دفعة أولى {{DOWN_PAYMENT_PERCENT}}%.",
  ],
  ["feel free is not a promise", "Feel free to visit us at {{ADDRESS}}."],
  ["arabic appointment word is not a promise", "يسعدنا تحديد موعد لزيارتك في {{ADDRESS}}."],
  ["arabic inspection is not an amount", "يمكنك الفحص عند زيارتنا."],
  ["a salesperson will follow up", "A salesperson will contact you soon with the details."],
];

describe("wording guard (ruling 11)", () => {
  test.each(BLOCKED)("%s is replaced by the handover sentence", (_family, text) => {
    expect(decide(text)).toEqual(HANDOVER);
  });

  test.each(CONTROLS)("control stays a normal draft: %s", (_label, text) => {
    expect(decide(text)).toMatchObject({ status: "ready", handoverFallback: false });
  });

  test("every term family has an English and an Arabic entry", () => {
    for (const family of ["discount", "negotiation", "promise", "amount"] as const) {
      expect(DRAFT_FORBIDDEN_WORDING[family].english.length).toBeGreaterThan(0);
      const arabic = DRAFT_FORBIDDEN_WORDING[family].arabic;
      expect(arabic.substrings.length + arabic.words.length).toBeGreaterThan(0);
    }
  });

  test("a needs_person answer is not affected", () => {
    expect(decideDraft({ outcome: "needs_person", text: "" }, CONTEXT)).toEqual({ status: "needs_person" });
  });
});
