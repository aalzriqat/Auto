// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  DRAFT_ANSWERS,
  HANDOVER_SENTENCE_AR,
  HANDOVER_SENTENCE_EN,
  MAX_DRAFT_BYTES,
  availableAnswers,
  chooseLocale,
  decideDraft,
  parseModelOutput,
  type DraftAnswer,
  type DraftModelOutput,
} from "./draftAnswers";
import type { DraftMessage } from "./draftContext";
import type { SentenceTable } from "./draftValidators";

const EN_HANDOVER = "Thank you for your message. One of our sales team will get back to you shortly with the details.";
const AR_HANDOVER = "شكرًا لتواصلك معنا. سيتواصل معك أحد موظفي المبيعات قريبًا لتزويدك بالتفاصيل.";

// The built-in Smart Reply sentences with the fixture's values (BYD Qin L 2025, 25000 JD, Acme Motors).
const FULL: SentenceTable = {
  en: {
    greeting: "Hi! 👋 Ask us about price, financing, or availability for any vehicle.",
    availability: "Yes, Qin L (2025) is currently available. Would you like a sales rep to contact you?",
    vehicleInfo: "Qin L (2025): 1200 km, Black, Electric, Automatic.",
    price: "Qin L (2025) is priced at 25000 JD. Would you like a sales rep to follow up?",
    financing: "Financing is available for Qin L (2025). Message us and a sales rep will share your personalized monthly rate.",
    location: "You can find us at Acme Motors, 1 Main Street.",
  },
  ar: {
    greeting: "أهلاً! 👋 اسألنا عن السعر أو التمويل أو التوفر لأي سيارة.",
    availability: "نعم، سيارة Qin L (2025) متوفرة حالياً. هل ترغب أن يتواصل معك أحد مندوبي المبيعات؟",
    vehicleInfo: "Qin L (2025): الممشى 1200 كم، اللون Black، Electric، Automatic.",
    price: "Qin L (2025) سعرها 25000 JD. هل ترغب أن يتواصل معك أحد مندوبي المبيعات؟",
    financing: "التمويل متاح لسيارة Qin L (2025). راسلنا وسيقوم أحد مندوبي المبيعات بإرسال القسط الشهري المناسب لك.",
    location: "يمكنك زيارتنا في Acme Motors, 1 Main Street.",
  },
};

const NO_VEHICLE: SentenceTable = {
  en: { ...FULL.en, availability: null, vehicleInfo: null, price: null, financing: null },
  ar: { ...FULL.ar, availability: null, vehicleInfo: null, price: null, financing: null },
};
const NO_PRICE_OR_FINANCING: SentenceTable = {
  en: { ...FULL.en, price: null, financing: null },
  ar: { ...FULL.ar, price: null, financing: null },
};

const EN_CHAT: DraftMessage[] = [{ direction: "customer", text: "Is this car still available?" }];
const AR_CHAT: DraftMessage[] = [{ direction: "customer", text: "هل السيارة متوفرة؟" }];

const draft = (...answers: DraftAnswer[]): DraftModelOutput => ({ outcome: "draft", answers });

describe("handover sentences", () => {
  test("are the fixed texts", () => {
    expect(HANDOVER_SENTENCE_EN).toBe(EN_HANDOVER);
    expect(HANDOVER_SENTENCE_AR).toBe(AR_HANDOVER);
  });
});

describe("parseModelOutput is strict", () => {
  test("accepts exactly outcome and answers, removes duplicates and orders them", () => {
    expect(parseModelOutput(JSON.stringify({ outcome: "draft", answers: ["location", "price", "price", "handover"] }))).toEqual({
      outcome: "draft",
      answers: ["price", "location", "handover"],
    });
    expect(parseModelOutput(JSON.stringify({ answers: ["greeting"], outcome: "draft" }))).toEqual({
      outcome: "draft",
      answers: ["greeting"],
    });
    expect(parseModelOutput(JSON.stringify({ outcome: "needs_person", answers: [] }))).toEqual({
      outcome: "needs_person",
      answers: [],
    });
  });

  test.each([
    ["invalid JSON", "not json"],
    ["a JSON array", "[]"],
    ["null", "null"],
    ["a string", JSON.stringify("price")],
    ["an unknown outcome", JSON.stringify({ outcome: "send_it", answers: ["price"] })],
    ["an unknown answer", JSON.stringify({ outcome: "draft", answers: ["discount"] })],
    ["a known answer in another case", JSON.stringify({ outcome: "draft", answers: ["Price"] })],
    ["a sentence in place of an answer", JSON.stringify({ outcome: "draft", answers: ["We can go below that"] })],
    ["a non-array answers", JSON.stringify({ outcome: "draft", answers: "price" })],
    ["an object as answers", JSON.stringify({ outcome: "draft", answers: { 0: "price" } })],
    ["a number inside answers", JSON.stringify({ outcome: "draft", answers: ["price", 5] })],
    ["missing answers", JSON.stringify({ outcome: "draft" })],
    ["missing outcome", JSON.stringify({ answers: ["price"] })],
    ["a text field next to valid answers", JSON.stringify({ outcome: "draft", answers: ["price"], text: "half the price" })],
    ["the old text-only shape", JSON.stringify({ outcome: "draft", text: "We will deliver it tomorrow" })],
    ["any extra property", JSON.stringify({ outcome: "draft", answers: ["price"], note: "x" })],
    ["a text field on needs_person", JSON.stringify({ outcome: "needs_person", answers: [], text: "x" })],
    ["draft with no answers", JSON.stringify({ outcome: "draft", answers: [] })],
    ["a proto key", '{"outcome":"draft","answers":["price"],"__proto__":{"text":"x"}}'],
  ])("%s is refused", (_label, text) => {
    expect(parseModelOutput(text)).toBeNull();
  });

  // Every string either seat stored as a normal draft at head ad05bf8a9: with no text field they have nowhere to go.
  test.each([
    "We can go below that",
    "نقدر نعطيك سعر أفضل",
    "السعر بعد الحسم خمسين",
    "You can have it for half the listed price",
    "ادفع خمسين دينارا فقط",
    "We will deliver it tomorrow",
    "See example.com for payment",
    "Ｆｒｅｅ delivery",
    "fr​ee delivery",
    "The final total price is {{MONTHLY_PAYMENT}}",
    "السعر {{LISTED_PRICE}} وقابل للتفاوض",
    "We'll hold it for you until tomorrow",
  ])("the seats' string %j cannot reach a draft", (text) => {
    for (const shape of [
      { outcome: "draft", text },
      { outcome: "draft", answers: [text] },
      { outcome: "draft", answers: ["price"], text },
      { outcome: "draft", answers: [], text },
    ]) {
      expect(parseModelOutput(JSON.stringify(shape))).toBeNull();
    }
  });
});

describe("the language is decided by code", () => {
  test.each([
    ["an Arabic latest message", AR_CHAT, "ar"],
    ["an English latest message", EN_CHAT, "en"],
    [
      "English after earlier Arabic",
      [{ direction: "customer", text: "هل متوفرة؟" }, { direction: "customer", text: "Price please" }] satisfies DraftMessage[],
      "en",
    ],
    [
      "Arabic after earlier English, whatever the dealership wrote last",
      [
        { direction: "customer", text: "Price please" },
        { direction: "customer", text: "كم السعر" },
        { direction: "dealership", text: "Hello" },
      ] satisfies DraftMessage[],
      "ar",
    ],
    ["Arabic-Indic digits alone", [{ direction: "customer", text: "٢٠٢٠" }] satisfies DraftMessage[], "en"],
    ["no customer message", [{ direction: "dealership", text: "مرحبا" }] satisfies DraftMessage[], "en"],
  ] as const)("%s", (_label, conversation, locale) => {
    expect(chooseLocale(conversation)).toBe(locale);
  });
});

describe("what the model is offered", () => {
  test("only answers with a sentence in the customer's language, and always the handover", () => {
    expect(availableAnswers(FULL, "en")).toEqual([...DRAFT_ANSWERS]);
    expect(availableAnswers(NO_VEHICLE, "ar")).toEqual(["greeting", "location", "handover"]);
    expect(availableAnswers(NO_PRICE_OR_FINANCING, "en")).toEqual(["greeting", "availability", "vehicleInfo", "location", "handover"]);
  });
});

describe("decideDraft builds the draft from approved sentences only", () => {
  test("English draft: price then handover, joined with a line break, in the fixed order", () => {
    expect(decideDraft(draft("handover", "price"), FULL, EN_CHAT)).toEqual({
      status: "ready",
      text: `Qin L (2025) is priced at 25000 JD. Would you like a sales rep to follow up?\n${EN_HANDOVER}`,
      handoverFallback: false,
    });
  });

  test("Arabic draft for an Arabic customer", () => {
    expect(decideDraft(draft("availability", "price"), FULL, AR_CHAT)).toEqual({
      status: "ready",
      text:
        "نعم، سيارة Qin L (2025) متوفرة حالياً. هل ترغب أن يتواصل معك أحد مندوبي المبيعات؟\n" +
        "Qin L (2025) سعرها 25000 JD. هل ترغب أن يتواصل معك أحد مندوبي المبيعات؟",
      handoverFallback: false,
    });
  });

  test("the order is fixed whatever order the model lists", () => {
    const text = decideDraft(draft("handover", "location", "financing", "price", "vehicleInfo", "availability", "greeting"), FULL, EN_CHAT);
    expect(text).toEqual({
      status: "ready",
      text: [FULL.en.greeting, FULL.en.availability, FULL.en.vehicleInfo, FULL.en.price, FULL.en.financing, FULL.en.location, EN_HANDOVER].join("\n"),
      handoverFallback: false,
    });
  });

  test("a chosen answer with no sentence contributes nothing and adds the handover", () => {
    expect(decideDraft(draft("greeting", "price"), NO_VEHICLE, EN_CHAT)).toEqual({
      status: "ready",
      text: `${FULL.en.greeting}\n${EN_HANDOVER}`,
      handoverFallback: false,
    });
  });

  test("a draft that is only the handover sentence is flagged as the fallback, in either language", () => {
    expect(decideDraft(draft("price"), NO_VEHICLE, EN_CHAT)).toEqual({ status: "ready", text: EN_HANDOVER, handoverFallback: true });
    expect(decideDraft(draft("handover"), FULL, AR_CHAT)).toEqual({ status: "ready", text: AR_HANDOVER, handoverFallback: true });
  });

  test("needs_person stores no text and a draft with no answers renders nothing", () => {
    expect(decideDraft({ outcome: "needs_person", answers: [] }, FULL, EN_CHAT)).toEqual({ status: "needs_person" });
    expect(decideDraft({ outcome: "draft", answers: [] }, FULL, EN_CHAT)).toEqual({ status: "needs_person" });
  });

  test("over the byte cap trailing sentences are dropped whole and the handover is kept", () => {
    const long = (mark: string) => `${mark} ${"a".repeat(398)}`; // 400 bytes
    const table: SentenceTable = {
      en: { ...FULL.en, greeting: long("G"), availability: long("A"), vehicleInfo: long("V") },
      ar: FULL.ar,
    };
    const result = decideDraft(draft("greeting", "availability", "vehicleInfo", "handover"), table, EN_CHAT);
    // Three 400-byte sentences and the handover exceed 1,000 bytes; the last answer sentence is dropped whole.
    expect(result).toEqual({ status: "ready", text: `${long("G")}\n${long("A")}\n${EN_HANDOVER}`, handoverFallback: false });
    const without = decideDraft(draft("greeting", "availability", "vehicleInfo"), table, EN_CHAT);
    expect(without).toEqual({ status: "ready", text: `${long("G")}\n${long("A")}`, handoverFallback: false });
  });

  test("a single sentence over the cap becomes the handover sentence alone", () => {
    const table: SentenceTable = { en: { ...FULL.en, greeting: "x".repeat(1200) }, ar: FULL.ar };
    expect(decideDraft(draft("greeting"), table, EN_CHAT)).toEqual({ status: "ready", text: EN_HANDOVER, handoverFallback: true });
  });

  test("counts bytes, not characters", () => {
    const table: SentenceTable = { en: FULL.en, ar: { ...FULL.ar, greeting: "ش".repeat(400), availability: "ش".repeat(400) } };
    const result = decideDraft(draft("greeting", "availability"), table, AR_CHAT);
    // 400 Arabic letters are 800 bytes: the second sentence does not fit beside the first.
    expect(result).toEqual({ status: "ready", text: "ش".repeat(400), handoverFallback: false });
  });
});

describe("by construction: no string outside the approved sentences can appear", () => {
  const SUBSETS: DraftAnswer[][] = Array.from({ length: 1 << DRAFT_ANSWERS.length }, (_, mask) =>
    DRAFT_ANSWERS.filter((_answer, index) => (mask & (1 << index)) !== 0)
  );
  const TABLES: [string, SentenceTable][] = [
    ["a vehicle with price and financing", FULL],
    ["a vehicle without price or financing", NO_PRICE_OR_FINANCING],
    ["no vehicle", NO_VEHICLE],
  ];
  const CHATS: [string, DraftMessage[], "en" | "ar"][] = [
    ["English", EN_CHAT, "en"],
    ["Arabic", AR_CHAT, "ar"],
  ];

  test("covers every subset of the seven answers", () => {
    // guardrail-4-fixture: two to the power of the seven answers
    expect(SUBSETS).toHaveLength(128);
  });

  test("every line of every rendered draft is a pre-rendered sentence or the handover sentence, in the fixed order", () => {
    let rendered = 0;
    for (const [, table] of TABLES) {
      for (const [, chat, locale] of CHATS) {
        const handover = locale === "ar" ? AR_HANDOVER : EN_HANDOVER;
        const approved = [...Object.values(table[locale]).filter((sentence): sentence is string => sentence !== null), handover];
        const order = [
          table[locale].greeting,
          table[locale].availability,
          table[locale].vehicleInfo,
          table[locale].price,
          table[locale].financing,
          table[locale].location,
          handover,
        ];
        for (const answers of SUBSETS) {
          const decision = decideDraft(draft(...answers), table, chat);
          if (answers.length === 0) {
            expect(decision).toEqual({ status: "needs_person" });
            continue;
          }
          if (decision.status !== "ready") throw new Error(`no draft for ${answers.join(",")}`);
          const lines = decision.text.split("\n");
          let last = -1;
          for (const line of lines) {
            expect(approved).toContain(line);
            const position = order.indexOf(line);
            expect(position).toBeGreaterThan(last);
            last = position;
          }
          expect(decision.handoverFallback).toBe(lines.length === 1 && lines[0] === handover);
          expect(new TextEncoder().encode(decision.text).length).toBeLessThanOrEqual(MAX_DRAFT_BYTES);
          rendered += 1;
        }
      }
    }
    // 127 non-empty subsets x 3 tables x 2 languages.
    expect(rendered).toBe(762);
  });
});
