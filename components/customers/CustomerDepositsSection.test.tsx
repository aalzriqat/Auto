/**
 * SCRUM-858 (c23884): the customer's deposits on their record. Real LanguageProvider, so every string is
 * the shipped EN / AR dictionary text; a missing key would render as the key itself and fail here.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { CustomerDepositsSection } from "./CustomerDepositsSection";
import {
  depositClassificationKey,
  depositStatusKey,
  formatDepositAmount,
  sortDepositsNewestFirst,
  type CustomerDepositRow,
} from "./customerDepositsPresentation";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function row(over: Partial<CustomerDepositRow> & { _id: string }): CustomerDepositRow {
  return { status: "HELD", amount: 0, amountMinor: 100_000, currency: "JOD", createdAt: 1_700_000_000_000, ...over };
}

function renderSection(
  locale: "en" | "ar",
  props: Partial<React.ComponentProps<typeof CustomerDepositsSection>> = {}
) {
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
  return render(
    <LanguageProvider>
      <CustomerDepositsSection deposits={[]} truncated={false} canView organizationCurrency="JOD" {...props} />
    </LanguageProvider>
  );
}

const SAMPLE: CustomerDepositRow[] = [
  row({ _id: "old", openingDepositKind: "SECURITY", origin: "OPENING", createdAt: 1_700_000_000_000, amountMinor: 100_000 }),
  row({
    _id: "new",
    openingDepositKind: "RESERVATION",
    origin: "OPENING",
    vehicleId: "veh_1",
    vehicleDesc: "2024 Synthetic Opening reservation car",
    createdAt: 1_800_000_000_000,
    amountMinor: 123_457,
    status: "APPLIED",
  }),
];

const EXPECTED = {
  en: {
    title: "Deposits",
    security: "Security deposit (refundable guarantee)",
    reservation: "Reservation deposit",
    held: "Held",
    applied: "Applied",
    badge: "Opening",
    amountSecurity: "100.000 JOD",
    amountReservation: "123.457 JOD",
    empty: "This customer has no deposits.",
    truncated: "Showing only the newest 100 deposits. Older deposits are not listed here.",
  },
  ar: {
    title: "العربونات",
    security: "تأمين (ضمان قابل للاسترداد)",
    reservation: "عربون حجز",
    held: "معلقة",
    applied: "مطبقة",
    badge: "افتتاحي",
    amountSecurity: "100.000 دينار اردني",
    amountReservation: "123.457 دينار اردني",
    empty: "لا توجد عربونات لهذا العميل.",
    truncated: "تُعرض أحدث 100 عربونًا فقط. العربونات الأقدم غير مدرجة هنا.",
  },
} as const;

describe.each(["en", "ar"] as const)("customer deposits section in %s", (locale) => {
  const text = EXPECTED[locale];

  test("shows classification, three-decimal amount, currency, status, linked vehicle and the opening badge, newest first", () => {
    renderSection(locale, { deposits: SAMPLE });
    expect(screen.getByRole("heading", { name: text.title })).toBeTruthy();
    const table = screen.getByRole("table");
    expect(table.getAttribute("aria-labelledby")).toBe("customer-deposits-heading");
    const bodyRows = within(table).getAllByRole("row").slice(1);
    expect(bodyRows).toHaveLength(2);
    // Newest first: the reservation row (created later) precedes the security row.
    expect(bodyRows[0].textContent).toContain(text.reservation);
    expect(bodyRows[0].textContent).toContain(text.amountReservation);
    expect(bodyRows[0].textContent).toContain(text.applied);
    expect(bodyRows[0].textContent).toContain("2024 Synthetic Opening reservation car");
    expect(bodyRows[1].textContent).toContain(text.security);
    expect(bodyRows[1].textContent).toContain(text.amountSecurity);
    expect(bodyRows[1].textContent).toContain(text.held);
    expect(within(bodyRows[1]).getByText("—")).toBeTruthy();
    expect(screen.getAllByText(text.badge)).toHaveLength(2);
    // Western digits in both languages, isolated left-to-right inside the amount cell.
    expect(table.textContent).not.toMatch(/[٠-٩]/);
    for (const bdi of table.querySelectorAll("bdi")) expect(bdi.getAttribute("dir")).toBe("ltr");
    // Read-only: the pilot containment forbids refunding or forfeiting an opening deposit.
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("an empty list says so and renders no table", () => {
    renderSection(locale, { deposits: [] });
    expect(screen.getByText(text.empty)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("renders the exact localized date with Western digits and without forcing LTR", () => {
    renderSection(locale, {
      deposits: [row({ _id: "dated", createdAt: new Date(2026, 0, 13, 12).getTime() })],
    });
    const depositRow = within(screen.getByRole("table")).getAllByRole("row")[1];
    const dateCell = within(depositRow).getAllByRole("cell")[4];
    // ar-JO emits RTL marks around the separators; a forced LTR wrapper scrambles their display.
    expect(dateCell.textContent).toBe(locale === "ar" ? "13\u200f/01\u200f/2026" : "Jan 13, 2026");
    expect(dateCell.querySelector('[dir="ltr"]')).toBeNull();
    expect(dateCell.closest("[dir]")?.getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
  });

  test("a truncated page tells the reader the list is only the newest 100", () => {
    renderSection(locale, { deposits: SAMPLE, truncated: true });
    expect(screen.getByRole("note").textContent).toBe(text.truncated);
    expect(screen.getByRole("table")).toBeTruthy();
  });

  test("not truncated shows no notice", () => {
    renderSection(locale, { deposits: SAMPLE, truncated: false });
    expect(screen.queryByRole("note")).toBeNull();
  });

  test("without the permission the section renders nothing at all, not even an empty state", () => {
    const { container } = renderSection(locale, { deposits: SAMPLE, canView: false });
    expect(screen.queryByText(text.title)).toBeNull();
    expect(screen.queryByText(text.empty)).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.textContent).not.toContain("100.000");
    expect(container.querySelector("[data-testid=customer-deposits]")).toBeNull();
  });
});

test("while the relations query is loading the section shows a status, never an empty claim", () => {
  renderSection("en", { deposits: undefined });
  expect(screen.getByRole("status").textContent).toBe("Loading deposits…");
  expect(screen.queryByText("This customer has no deposits.")).toBeNull();
});

describe("presentation rules", () => {
  test("amounts keep the currency's full scale: whole dinars show 100.000, fils are never rounded away", () => {
    expect(formatDepositAmount({ amountMinor: 100_000, amount: 100, currency: "JOD" }, undefined)).toEqual({ amount: "100.000", currency: "JOD" });
    expect(formatDepositAmount({ amountMinor: 123_457, amount: 123.457, currency: "JOD" }, undefined).amount).toBe("123.457");
    expect(formatDepositAmount({ amountMinor: 1_234_500, amount: 1234.5, currency: "JOD" }, undefined).amount).toBe("1,234.500");
    expect(formatDepositAmount({ amountMinor: 1, amount: 0.001, currency: "JOD" }, undefined).amount).toBe("0.001");
  });

  test("a two-decimal currency keeps its own scale and a legacy row falls back to the organization currency and major units", () => {
    expect(formatDepositAmount({ amountMinor: 12_345, amount: 123.45, currency: "USD" }, "JOD")).toEqual({ amount: "123.45", currency: "USD" });
    expect(formatDepositAmount({ amount: 50, currency: undefined }, "JOD")).toEqual({ amount: "50.000", currency: "JOD" });
    expect(formatDepositAmount({ amount: Number.NaN, currency: "JOD" }, undefined).amount).toBe("—");
  });

  test("classification names an opening deposit and never guesses an ordinary one", () => {
    expect(depositClassificationKey({ openingDepositKind: "SECURITY" })).toBe("OpeningDepositType_SECURITY");
    expect(depositClassificationKey({ openingDepositKind: "RESERVATION" })).toBe("OpeningDepositType_RESERVATION");
    expect(depositClassificationKey({})).toBe("CustomerDepositKindOrdinary");
  });

  test("every deposit status has a label key", () => {
    expect(["HELD", "APPLIED", "REFUNDED", "FORFEITED", "VOIDED"].map((s) => depositStatusKey(s as never))).toEqual([
      "DepositStatusHeld",
      "DepositStatusApplied",
      "DepositStatusRefunded",
      "DepositStatusForfeited",
      "CustomerDepositStatusVoided",
    ]);
  });

  test("sorting is newest first and does not mutate the input", () => {
    const input = [{ createdAt: 1 }, { createdAt: 3 }, { createdAt: 2 }];
    expect(sortDepositsNewestFirst(input).map((r) => r.createdAt)).toEqual([3, 2, 1]);
    expect(input.map((r) => r.createdAt)).toEqual([1, 3, 2]);
  });
});
