/**
 * SCRUM-1013 — every structured journal fact the server can return has a label
 * in BOTH locales.
 *
 * The journal screen builds `JournalSource_<family>`, `JournalEvent_<eventType>`
 * and `JournalStatus_<status>` keys at runtime, so the literal-key scan in
 * keyCoverage.test.ts cannot see them. This enumerates the closed sets from the
 * server module itself (the event list is exhaustive over EventType by
 * `satisfies`), so a new event type without an Arabic label fails here instead of
 * rendering as a raw enum inside an Arabic, RTL screen.
 */
import { describe, expect, test } from "vitest";
import { dictionaries } from "./dictionaries";
import { JOURNAL_DISPLAY_EVENT_TYPES, JOURNAL_SOURCE_FAMILIES } from "../../convex/accounting/journalDisplay";

const ARABIC_LETTER = /[؀-ۿ]/;
const JOURNAL_STATUSES = ["DRAFT", "VALIDATED", "POSTED", "REVERSED"] as const;
const FIXED_KEYS = [
  "JournalReversalOf", "JournalReversalEntry", "JournalReversesEntry", "JournalReversedByEntry", "JournalNote",
  "JournalRecordedText", "JournalPeriod", "JournalLineBank", "JournalLineReversal", "JournalTransferIn",
  "JournalTransferOut", "JournalUnnamedBank",
] as const;

function label(locale: "en" | "ar", key: string): string | undefined {
  return (dictionaries[locale] as Record<string, string>)[key];
}

describe("SCRUM-1013 journal display labels", () => {
  const keys = [
    ...JOURNAL_SOURCE_FAMILIES.map((family) => `JournalSource_${family}`),
    ...JOURNAL_DISPLAY_EVENT_TYPES.map((eventType) => `JournalEvent_${eventType}`),
    ...JOURNAL_STATUSES.map((status) => `JournalStatus_${status}`),
    ...FIXED_KEYS,
  ];

  test("enumerates the server's closed sets, not an empty list", () => {
    expect(JOURNAL_SOURCE_FAMILIES.length).toBeGreaterThanOrEqual(19);
    expect(JOURNAL_DISPLAY_EVENT_TYPES).toContain("TREASURY_TRANSFER");
    expect(JOURNAL_DISPLAY_EVENT_TYPES.length).toBeGreaterThanOrEqual(60);
  });

  test("every key has English text and Arabic text, and the Arabic is Arabic", () => {
    const problems = keys.flatMap((key) => {
      const en = label("en", key);
      const ar = label("ar", key);
      if (!en) return [`missing EN: ${key}`];
      if (!ar) return [`missing AR: ${key}`];
      if (!ARABIC_LETTER.test(ar)) return [`AR is not Arabic: ${key} = ${ar}`];
      return [];
    });
    expect(problems).toEqual([]);
  });

  test("the reversal template keeps its placeholder in both locales", () => {
    expect(label("en", "JournalReversalOf")).toContain("{event}");
    expect(label("ar", "JournalReversalOf")).toContain("{event}");
  });
});
