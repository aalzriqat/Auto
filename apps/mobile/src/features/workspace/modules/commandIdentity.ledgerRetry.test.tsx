/// <reference types="jest" />
/**
 * SCRUM-57 — a retried ledger entry must be one economic event, not two.
 *
 * `transactions.add` fingerprints `date`, exactly like `expenses.create`, so the
 * same rule applies: the identity is held across the retry AND the date is
 * snapshotted with it, or a genuine retry arrives as a fingerprint conflict.
 *
 * Own file for the same reason as the expense scenarios: a `TextInput` inside
 * RN's `Modal` cannot be remounted cleanly twice in one jest module registry.
 */
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { Alert } from "react-native";

jest.mock("convex/react", () => ({
  useMutation: jest.fn(),
  usePaginatedQuery: jest.fn(),
  useQuery: jest.fn(),
}));

import { LocaleProvider } from "../../../providers/LocaleProvider";
import { ThemeProvider } from "../../../providers/ThemeProvider";
import { AccountingModule } from "./accounting";

const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const mockUsePaginatedQuery = usePaginatedQuery as jest.MockedFunction<typeof usePaginatedQuery>;
const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;

const ORG = "org_1";
const SAVE = "حفظ";
const SAVING = "جاري الحفظ...";
/** Comfortably above `Date.now()` resolution, so the clock provably moves. */
const CLOCK_GAP_MS = 25;

beforeEach(() => {
  mockUseMutation.mockReset();
  mockUsePaginatedQuery.mockReset();
  mockUseQuery.mockReset();
  mockUsePaginatedQuery.mockReturnValue({
    results: [],
    status: "Exhausted",
    isLoading: false,
    loadMore: jest.fn(),
  } as unknown as ReturnType<typeof usePaginatedQuery>);
  mockUseQuery.mockReturnValue([] as unknown as ReturnType<typeof useQuery>);
  // The failure path reports through Alert + console.error by design.
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test("a retried ledger entry re-sends the SAME identity AND the SAME date", async () => {
  const spy = jest.fn();
  spy.mockRejectedValue(new Error("network lost"));
  mockUseMutation.mockReturnValue(spy as unknown as ReturnType<typeof useMutation>);

  const { getByLabelText, getByText, queryByText } = await render(
    <ThemeProvider>
      <LocaleProvider>
        <AccountingModule orgId={ORG} />
      </LocaleProvider>
    </ThemeProvider>,
  );

  fireEvent.press(getByText("إضافة قيد"));
  await waitFor(() => expect(queryByText(SAVE)).not.toBeNull());
  fireEvent.changeText(getByLabelText("المبلغ"), "250");
  fireEvent.changeText(getByLabelText("البيان"), "Deposit");
  await waitFor(() =>
    expect((getByLabelText("المبلغ") as unknown as { props: { value: string } }).props.value).toBe("250"),
  );

  const startedAt = Date.now();
  fireEvent.press(getByText(SAVE));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(queryByText(SAVING)).toBeNull());

  await new Promise((resolve) => setTimeout(resolve, CLOCK_GAP_MS));
  fireEvent.press(getByText(SAVE));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

  const first = spy.mock.calls[0][0] as { idempotencyKey: string; date: number };
  const second = spy.mock.calls[1][0] as { idempotencyKey: string; date: number };

  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CLOCK_GAP_MS);
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  expect(second.date).toBe(first.date);
});
