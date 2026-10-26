/// <reference types="jest" />
import { fireEvent, render } from "@testing-library/react-native";
import { Alert } from "react-native";
import * as SecureStore from "expo-secure-store";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../../convexApi";
import { LocaleProvider } from "../../../providers/LocaleProvider";
import { ThemeProvider } from "../../../providers/ThemeProvider";
import { ExpensesModule } from "./expenses";

jest.mock("convex/react", () => ({ useMutation: jest.fn(), useQuery: jest.fn(), usePaginatedQuery: jest.fn() }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
const create = jest.fn();

beforeEach(() => {
  create.mockReset().mockResolvedValue("expense-id");
  jest.mocked(useMutation).mockImplementation(reference => Object.assign(reference === api.expenses.create ? create : jest.fn(), {
    withOptimisticUpdate: () => { throw new Error("Unexpected optimistic update at the expense SDK boundary"); },
  }));
  jest.mocked(useQuery).mockReturnValue([]);
  jest.mocked(usePaginatedQuery).mockReturnValue({ results: [], status: "Exhausted", loadMore: jest.fn(), isLoading: false });
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

test.each([
  { locale: "en", add: "Add expense", category: "Category", title: "Title", amount: "Amount", save: "Save", search: "Search" },
  { locale: "ar", add: "إضافة مصروف", category: "الفئة", title: "العنوان", amount: "المبلغ", save: "حفظ", search: "بحث" },
])("$locale real picker offers ordinary native categories and retains a refused intent on retry", async text => {
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async key => key === "autoflow-mobile-locale" ? text.locale : null);
  const clock = jest.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  create.mockRejectedValueOnce(new Error("Synthetic lost response"));
  const view = await render(<ThemeProvider><LocaleProvider><ExpensesModule orgId="org-test" /></LocaleProvider></ThemeProvider>);
  await fireEvent.press(await view.findByRole("button", { name: text.add }));
  await fireEvent.changeText(view.getByLabelText(text.title), "Synthetic ordinary expense");
  await fireEvent.changeText(view.getByLabelText(text.amount), "25.5");
  await fireEvent.press(view.getByRole("button", { name: text.category }));
  const search = view.getByPlaceholderText(text.search);
  // Independent business oracle: these ordinary categories are supported; prepaid requires a different form.
  for (const category of ["REPAIR", "MAINTENANCE", "DETAILING", "TRANSPORT", "MARKETING", "OFFICE", "SALARIES", "RENT", "UTILITIES", "FEES", "OTHER"]) {
    await fireEvent.changeText(search, category);
    expect(view.getByTestId(`searchable-select-option-${category}`)).toBeTruthy();
  }
  for (const category of ["INSPECTION", "REGISTRATION", "CLEANING", "INSURANCE", "PREPAID"]) {
    await fireEvent.changeText(search, category);
    expect(view.queryByTestId(`searchable-select-option-${category}`)).toBeNull();
  }
  await fireEvent.changeText(search, "DETAILING");
  await fireEvent.press(view.getByTestId("searchable-select-option-DETAILING"));
  await fireEvent.press(view.getByRole("button", { name: text.save }));
  expect(create).toHaveBeenCalledTimes(1);
  const first = create.mock.calls[0][0];
  expect(first).toMatchObject({ category: "DETAILING", amount: 25.5, date: 1_800_000_000_000 });
  expect(first).not.toHaveProperty("amortizationMonths");
  clock.mockReturnValue(1_800_000_060_000);
  await fireEvent.press(view.getByRole("button", { name: text.save }));
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1][0]).toEqual(first);
  await fireEvent.press(view.getByRole("button", { name: text.add }));
  await fireEvent.changeText(view.getByLabelText(text.title), "Next synthetic expense");
  await fireEvent.changeText(view.getByLabelText(text.amount), "12");
  await fireEvent.press(view.getByRole("button", { name: text.save }));
  expect(create).toHaveBeenCalledTimes(3);
  expect(create.mock.calls[2][0].idempotencyKey).not.toBe(first.idempotencyKey);
  expect(create.mock.calls[2][0].date).toBe(1_800_000_060_000);
});
