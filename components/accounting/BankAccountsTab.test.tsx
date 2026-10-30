/**
 * SCRUM-858 PR #715 review round 2, P1. The opening reconciliation on the native bank screen must format every
 * amount with that bank's OWN currency and that currency's own precision (ISO 4217 minor units: JOD has 3, USD has 2),
 * never with the organization's currency at zero decimals. A USD 123.45 balance read "JOD 123" and a JOD 0.001
 * difference read "JOD 0".
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";

const language = vi.hoisted(() => ({ locale: "en" as "en" | "ar" }));
const data = vi.hoisted(() => ({ opening: undefined as unknown, book: null as unknown }));

vi.mock("convex/react", async () => {
  const { getFunctionName: nameOf } = await import("convex/server");
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      if (args === "skip") return undefined;
      const name = nameOf(ref);
      if (name === "bankAccounts:list") return [];
      if (name === "bankAccounts:getBookBalance") return data.book;
      if (name === "bankAccounts:openingReconciliation") return data.opening;
      return undefined;
    },
    useMutation: () => vi.fn(),
  };
});

vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries: dicts } = await import("@/lib/i18n/dictionaries");
  return {
    useLanguage: () => ({
      locale: language.locale,
      isRtl: language.locale === "ar",
      t: (key: string) => (dicts as Record<string, Record<string, string>>)[language.locale][key] ?? key,
    }),
  };
});
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org1" }) }));
vi.mock("@/hooks/useOrgSettings", () => ({ useOrgSettings: () => ({ currency: "JOD", currencySymbol: "JOD" }) }));
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ hasPermission: () => false, isLoading: false }) }));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./bankAccounts/ReconciliationPanel", () => ({ ReconciliationPanel: () => null }));

import { BankAccountsTab } from "./BankAccountsTab";

afterEach(() => {
  cleanup();
  language.locale = "en";
  data.opening = undefined;
  data.book = null;
});

/** A JOD opening. The JOD bank is 0.001 JOD (1 fils) off its stated balance. The USD bank states USD 123.45. */
function openingWithMixedCurrencies() {
  return {
    status: "OK",
    currency: "JOD",
    asOfDate: null,
    controlOpeningMinor: 4_000_000,
    bankLinesTotalMinor: 4_000_000,
    unattributedOpeningMinor: 0,
    banks: [
      {
        bankAccountId: "jod1",
        name: "Arab Bank",
        currency: "JOD",
        openingLineMinor: 4_000_000,
        referenceOpeningMinor: 4_000_001,
        differenceMinor: 1,
      },
      {
        bankAccountId: "usd1",
        name: "Dollar Bank",
        currency: "USD",
        openingLineMinor: 0,
        referenceOpeningMinor: 12_345,
        differenceMinor: null,
      },
    ],
    unexplainedOpeningDifference: {
      label: { en: "Unexplained opening-balance reconciliation difference", ar: "فرق أرصدة افتتاحية غير مفسر قيد المطابقة" },
      currencies: [{ currency: "JOD", differenceMinor: 1, absoluteDifferenceMinor: 1 }],
    },
  };
}

function bookBalance(name: string, currency: string, balanceMinor: number) {
  return { status: "OK", bankAccountId: "book1", name, currency, balanceMinor };
}

const bookText = () => (screen.getByText(/./, { selector: "p.text-2xl" }).textContent ?? "").replace(/ /g, " ");

/**
 * PR #715 review round 3, P2-2. The selected bank's book balance read through the organization currency formatter at
 * zero decimals: USD 123.45 showed "JOD 123". It must use that bank's own currency and ISO 4217 precision.
 */
describe("BankAccountsTab book balance money", () => {
  test("English: a USD bank of 123.45 shows dollars with cents, never the organization's JOD at zero decimals", () => {
    data.book = bookBalance("Dollar Bank", "USD", 12_345);
    render(<BankAccountsTab />);

    expect(bookText()).toBe("$123.45");
  });

  test("English: a JOD bank holding one fils shows three decimals, not JOD 0", () => {
    data.book = bookBalance("Arab Bank", "JOD", 1);
    render(<BankAccountsTab />);

    expect(bookText()).toBe("JOD 0.001");
  });

  test("Arabic: USD 123.45 and one JOD fils keep Western digits, each in its own currency and precision", () => {
    language.locale = "ar";
    data.book = bookBalance("Dollar Bank", "USD", 12_345);
    const view = render(<BankAccountsTab />);
    const usd = bookText();
    expect(usd).toContain("123.45");
    expect(usd).toContain("US$");
    expect(usd).not.toContain("د.أ");
    view.unmount();

    data.book = bookBalance("Arab Bank", "JOD", 1);
    render(<BankAccountsTab />);
    const jod = bookText();
    expect(jod).toContain("0.001");
    expect(jod).toContain("د.أ");
    expect(`${usd}${jod}`).not.toMatch(/[٠-٩۰-۹]/);
  });

  test("a book balance in a currency whose scale is unknown shows a dash, never a guessed scale", () => {
    data.book = bookBalance("Odd Bank", "XXX", 12_345);
    render(<BankAccountsTab />);

    expect(bookText()).toBe("—");
  });
});

describe("BankAccountsTab opening reconciliation money", () => {
  test("a bank currency whose scale is unknown shows a dash instead of crashing or guessing a scale", () => {
    const opening = openingWithMixedCurrencies();
    opening.banks[1] = { ...opening.banks[1], currency: "XXX" };
    data.opening = opening;
    render(<BankAccountsTab />);

    const row = within(screen.getByTestId("opening-bank-panel")).getByTestId("opening-bank-row-usd1");
    expect(row.textContent).toBe("Dollar Bank———");
  });

  test("English: each bank amount uses the bank's own currency and precision", () => {
    data.opening = openingWithMixedCurrencies();
    render(<BankAccountsTab />);
    const panel = screen.getByTestId("opening-bank-panel");

    const usd = within(panel).getByTestId("opening-bank-row-usd1").textContent?.replace(/\u00a0/g, " ") ?? "";
    expect(usd).toContain("$123.45");
    expect(usd).not.toContain("JOD");

    const jod = within(panel).getByTestId("opening-bank-row-jod1").textContent?.replace(/\u00a0/g, " ") ?? "";
    expect(jod).toContain("JOD 4,000.000");
    expect(jod).toContain("JOD 4,000.001");
    // The one-fils difference is not rounded away to "JOD 0".
    expect(jod).toContain("JOD 0.001");

    const difference = within(panel).getByTestId("opening-bank-difference").textContent?.replace(/\u00a0/g, " ") ?? "";
    expect(difference).toContain("JOD 0.001");
  });

  test("Arabic: same currencies and precision, Western digits, the dinar symbol for JOD", () => {
    language.locale = "ar";
    data.opening = openingWithMixedCurrencies();
    render(<BankAccountsTab />);
    const panel = screen.getByTestId("opening-bank-panel");

    const usd = within(panel).getByTestId("opening-bank-row-usd1").textContent?.replace(/\u00a0/g, " ") ?? "";
    expect(usd).toContain("123.45");
    expect(usd).toContain("US$");
    expect(usd).not.toContain("د.أ");

    const jod = within(panel).getByTestId("opening-bank-row-jod1").textContent?.replace(/\u00a0/g, " ") ?? "";
    expect(jod).toContain("4,000.000");
    expect(jod).toContain("4,000.001");
    expect(jod).toContain("0.001");
    expect(jod).toContain("د.أ");

    const difference = within(panel).getByTestId("opening-bank-difference").textContent?.replace(/\u00a0/g, " ") ?? "";
    expect(difference).toContain("0.001");
    // ECMA-402 numbering system pinned to latn: no Arabic-Indic digits in any amount.
    expect(panel.textContent ?? "").not.toMatch(/[٠-٩۰-۹]/);
  });
});
