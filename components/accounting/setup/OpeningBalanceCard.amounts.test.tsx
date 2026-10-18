import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, locale: "en" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "test-org" }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => getFunctionName(reference) === "accountingCutover:openingBalanceStatus"
      ? { canManageFinance: true, canPostDirectly: true, posted: false, pendingDraftId: null, currency: "USD" }
      : [],
    useMutation: () => vi.fn(),
  };
});

import { OpeningBalanceCard } from "./OpeningBalanceCard";

afterEach(cleanup);

test("opening amount fields reject unsupported precision without crashing the setup screen", () => {
  render(<OpeningBalanceCard />);
  fireEvent.click(screen.getByRole("button", { name: "OpeningBalanceSet" }));
  const debit = screen.getAllByRole("spinbutton", { name: "OpeningBalanceDebit" })[0];

  fireEvent.change(debit, { target: { value: "1.234" } });
  expect(screen.getByText("OpeningBalanceAmountInvalid")).toBeTruthy();
  expect(screen.getByRole("button", { name: "OpeningBalancePost" }).hasAttribute("disabled")).toBe(true);

  fireEvent.change(debit, { target: { value: "900719925474099100000" } });
  expect(screen.getByText("OpeningBalanceAmountInvalid")).toBeTruthy();
  expect(screen.getByRole("button", { name: "OpeningBalancePost" }).hasAttribute("disabled")).toBe(true);

  fireEvent.change(debit, { target: { value: "90071992547409.90" } });
  expect(screen.getByText("OpeningBalanceAmountInvalid")).toBeTruthy();
  expect(screen.getByRole("button", { name: "OpeningBalancePost" }).hasAttribute("disabled")).toBe(true);

  fireEvent.change(debit, { target: { value: "1.23" } });
  expect(screen.queryByText("OpeningBalanceAmountInvalid")).toBeNull();
  expect(debit.getAttribute("step")).toBe("0.01");
});
