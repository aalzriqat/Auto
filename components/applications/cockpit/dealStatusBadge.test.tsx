/**
 * SCRUM-629 F-08: every application is created PENDING_DOCS, so the header badge
 * said "pending documents" on deals the server proved need no document. Display
 * only — the stored status is untouched.
 */
import { describe, expect, test, vi } from "vitest";
import { dictionaries } from "@/lib/i18n/dictionaries";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));
vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ code: "JOD", symbol: "JOD", displayLabel: "JOD", format: String, formatCompact: String }),
}));
vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: () => 3,
}));

import { dealStatusBadgeKey, documentsOutstanding } from "./DealCockpit";

// The F-07 self-attack: a NOT_APPLICABLE documents stage read as "incomplete"
// would disable credit approval on every deal with no required document.
describe("documentsOutstanding", () => {
  test("a deal with no required document has nothing outstanding", () => {
    expect(documentsOutstanding("NOT_APPLICABLE")).toBe(false);
  });
  test("a complete stage, or no stage yet, has nothing outstanding", () => {
    expect(documentsOutstanding("COMPLETE")).toBe(false);
    expect(documentsOutstanding(undefined)).toBe(false);
  });
  test.each(["CURRENT", "BLOCKED", "UPCOMING"])("a %s stage still has documents outstanding", (state) => {
    expect(documentsOutstanding(state)).toBe(true);
  });
});

const delivery = (state: string) => [{ key: "DELIVERY_ACTIONS", state }];

describe("dealStatusBadgeKey", () => {
  test("PENDING_DOCS on a deal that needs no document reads Submitted", () => {
    expect(dealStatusBadgeKey("PENDING_DOCS", delivery("NOT_APPLICABLE"))).toBe("AppStatusSubmitted");
  });

  test.each(["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "COMPLETE"])(
    "PENDING_DOCS keeps Pending Documents while delivery actions are %s",
    (state) => {
      expect(dealStatusBadgeKey("PENDING_DOCS", delivery(state))).toBe("PendingDocs");
    }
  );

  test("PENDING_DOCS with no stage data keeps Pending Documents", () => {
    expect(dealStatusBadgeKey("PENDING_DOCS", [])).toBe("PendingDocs");
  });

  test("other statuses are unchanged by a not-applicable delivery stage", () => {
    expect(dealStatusBadgeKey("APPROVED", delivery("NOT_APPLICABLE"))).toBe("Approved");
  });

  test("the Submitted label exists in both languages", () => {
    const en = dictionaries.en as Record<string, string>;
    const ar = dictionaries.ar as Record<string, string>;
    expect(en.AppStatusSubmitted).toBe("Submitted");
    expect(ar.AppStatusSubmitted).toBeTruthy();
    expect(ar.AppStatusSubmitted).not.toBe(en.AppStatusSubmitted);
  });
});
