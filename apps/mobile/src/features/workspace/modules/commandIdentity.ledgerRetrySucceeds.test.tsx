/// <reference types="jest" />
/**
 * SCRUM-57 — a ledger retry that SUCCEEDS is still ONE entry.
 *
 * The companion to `commandIdentity.ledgerRetry.test.tsx`, which stops at the
 * failing attempts. This one carries the same intent through to success, which
 * is the path that retires the identity and clears the date snapshot
 * (`accounting.tsx`). Without it that path is never executed by any test, so a
 * future edit that dropped `commandId.retire(intent)` would leave the identity
 * held into the NEXT, genuinely new ledger entry — the server would replay the
 * completed command and the new entry would silently never exist while the UI
 * reported success.
 *
 * The identity is re-sent UNCHANGED on the attempt that finally succeeds: one
 * intent, one economic event, however many attempts it took.
 *
 * That the identity is then RETIRED is asserted at call sites whose form needs
 * no typing — `commandIdentity.modules.test.tsx`, for both commissions and
 * sourcing. Observing it here would mean reopening the sheet, and a `TextInput`
 * inside RN's `Modal` cannot be remounted cleanly twice in one jest module
 * registry, which is also why this scenario has its own file.
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

test("a ledger retry that SUCCEEDS re-sends the SAME identity and date as the failed attempt", async () => {
  const spy = jest.fn();
  // Fails once, then succeeds — the ordinary lost-response retry.
  spy.mockRejectedValueOnce(new Error("network lost")).mockResolvedValue(null);
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

  // Control: real time passed between the attempts, so the date equality is
  // evidence of snapshotting rather than of both presses landing in one ms.
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CLOCK_GAP_MS);
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  expect(second.date).toBe(first.date);
});
