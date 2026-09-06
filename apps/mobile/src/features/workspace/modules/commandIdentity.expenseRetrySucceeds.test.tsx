/// <reference types="jest" />
/**
 * SCRUM-57 — an expense retry that SUCCEEDS is still ONE expense, and the NEXT
 * expense is a genuinely new command.
 *
 * The companion to `commandIdentity.expenseRetry.test.tsx`, which stops at the
 * failing attempts. This one carries the intent through to success and then
 * enters a SECOND, different expense. That second expense is what proves the
 * success path RETIRED the identity and CLEARED the date snapshot, rather than
 * merely executing those two lines:
 *
 *   - drop `commandId.retire(intent)` and the second expense travels under a
 *     COMPLETED identity: the server replays the first command and the new
 *     expense silently never exists, while the UI reports success
 *   - drop `dateRef.current = null` and `dateRef.current ??= Date.now()` never
 *     re-arms, so every later expense in that mounted lifetime silently
 *     inherits the FIRST expense's timestamp — no error, no exception
 *
 * Both are checked here by mutation, not assumed. The first is not
 * hypothetical: `commandId.retire(intent)` was briefly lost from `expenses.tsx`
 * during this ticket, and this assertion is what turned CI red.
 *
 * Every `fireEvent` is AWAITED. In @testing-library/react-native 14 the event
 * helpers return promises and are documented to be awaited; not awaiting them
 * leaves the renderer with unflushed state, and assertions then read a tree no
 * user could be looking at. An earlier revision of this file did not await,
 * reached its third submission through exactly that stale state, and explained
 * it with a claim about `Modal` that turned out to be false. Awaiting also
 * makes the sheet observably close on success, which is what allows the second
 * expense to be typed the way an operator would type it.
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
import { ExpensesModule } from "./expenses";

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

test("an expense retry that succeeds keeps ONE identity, then the next expense gets a NEW one", async () => {
  const spy = jest.fn();
  // Fails once, then succeeds — the ordinary lost-response retry.
  spy.mockRejectedValueOnce(new Error("network lost")).mockResolvedValue(null);
  mockUseMutation.mockReturnValue(spy as unknown as ReturnType<typeof useMutation>);

  const { getByLabelText, getByText, queryByText } = await render(
    <ThemeProvider>
      <LocaleProvider>
        <ExpensesModule orgId={ORG} />
      </LocaleProvider>
    </ThemeProvider>,
  );

  async function fill(amount: string, title: string) {
    await fireEvent.press(getByText("إضافة مصروف"));
    await waitFor(() => expect(queryByText(SAVE)).not.toBeNull());
    await fireEvent.changeText(getByLabelText("العنوان"), title);
    await fireEvent.changeText(getByLabelText("المبلغ"), amount);
  }

  await fill("300", "Tyres");
  const startedAt = Date.now();
  await fireEvent.press(getByText(SAVE));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(queryByText(SAVING)).toBeNull());

  // The clock MOVES before the retry. An un-snapshotted `Date.now()` would send
  // a later date here — same identity, different fingerprint — which the server
  // must reject as a conflict instead of replaying.
  await new Promise((resolve) => setTimeout(resolve, CLOCK_GAP_MS));
  await fireEvent.press(getByText(SAVE));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

  // Success closes the sheet: the observable end of this command.
  await waitFor(() => expect(queryByText(SAVE)).toBeNull());

  // A SECOND, genuinely different expense, entered the way an operator would.
  await new Promise((resolve) => setTimeout(resolve, CLOCK_GAP_MS));
  await fill("450", "Brakes");
  await fireEvent.press(getByText(SAVE));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));

  const first = spy.mock.calls[0][0] as { idempotencyKey: string; date: number; amount: number };
  const second = spy.mock.calls[1][0] as { idempotencyKey: string; date: number };
  const third = spy.mock.calls[2][0] as { idempotencyKey: string; date: number; amount: number };

  // Control: real time passed, so the date equality below is evidence of
  // snapshotting rather than of two presses landing in the same millisecond.
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CLOCK_GAP_MS);

  // One intent, one economic event, however many attempts it took.
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  expect(second.date).toBe(first.date);

  // A different economic instruction must never travel under a completed
  // identity, and must carry its own date.
  expect(third.amount).not.toBe(first.amount);
  expect(third.idempotencyKey).not.toBe(first.idempotencyKey);
  expect(third.date).toBeGreaterThan(first.date);
});
