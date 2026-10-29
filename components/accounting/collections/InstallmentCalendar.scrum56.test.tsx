import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InstallmentCalendar } from "./InstallmentCalendar";

vi.mock("convex/react", () => ({
  useQuery: () => [
    { _id: "invoice", dueDate: Date.now(), customerName: "Sale buyer", title: "INV-1", outstandingAmount: 123.45, currency: "USD", scale: 2, status: "PARTIALLY_PAID" },
    { _id: "legacy", dueDate: Date.now(), customerName: "Manual buyer", title: "Manual debt", outstandingAmount: 40, currency: "JOD", scale: 3, status: "OPEN" },
  ],
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org" }) }));
vi.mock("@/components/providers/LanguageProvider", () => ({ useLanguage: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (amount: number) => `${amount.toFixed(3)} JOD`,
  useCurrencyFormatterInCurrency: () => (amount: number, currency: string, scale: number) => `${amount.toFixed(scale)} ${currency}`,
}));
vi.mock("@/components/ui/calendar", () => ({ Calendar: () => <div /> }));

afterEach(cleanup);

test("SCRUM-56 calendar displays canonical and manual debt in each row's currency and scale", () => {
  render(<InstallmentCalendar />);
  expect(screen.getByText("Sale buyer")).toBeDefined();
  expect(screen.getByText("123.45 USD")).toBeDefined();
  expect(screen.getByText("Manual buyer")).toBeDefined();
  expect(screen.getByText("40.000 JOD")).toBeDefined();
});
