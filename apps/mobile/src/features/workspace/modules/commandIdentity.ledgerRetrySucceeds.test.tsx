/// <reference types="jest" />
/**
 * SCRUM-57 — a ledger retry that SUCCEEDS is still ONE entry, and the NEXT
 * entry is a genuinely new command.
 *
 * The companion to `commandIdentity.ledgerRetry.test.tsx`, which stops at the
 * failing attempts. This one carries the intent through to success and then
 * enters a SECOND, different entry. That second entry is what proves the
 * success path RETIRED the identity and CLEARED the date snapshot, rather than
 * merely executing those two lines:
 *
 *   - drop `commandId.retire(intent)` and the second entry travels under a
 *     COMPLETED identity: the server replays the first command and the new
 *     entry silently never exists, while the UI reports success
 *   - drop `dateRef.current = null` and `dateRef.current ??= Date.now()` never
 *     re-arms, so every later entry in that mounted lifetime silently inherits
 *     the FIRST entry's timestamp — no error, no exception
 *
 * Both are checked here by mutation, not assumed.
 *
 * Every `fireEvent` is AWAITED. In @testing-library/react-native 14 the event
 * helpers return promises and are documented to be awaited; not awaiting them
 * leaves the renderer with unflushed state, and assertions then read a tree no
 * user could be looking at. An earlier revision of this file did not await,
 * reached its third submission through exactly that stale state, and explained
 * it with a claim about `Modal` that turned out to be false. Awaiting also
 * makes the sheet observably close on success, which is what allows the second
 * entry to be typed the way an operator would type it.
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

test("a ledger retry that succeeds keeps ONE identity, then the next entry gets a NEW one", async () => {
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

  async function fill(amount: string, description: string) {
    await fireEvent.press(getByText("إضافة قيد"));
    await waitFor(() => expect(queryByText(SAVE)).not.toBeNull());
    await fireEvent.changeText(getByLabelText("المبلغ"), amount);
    await fireEvent.changeText(getByLabelText("البيان"), description);
  }

  await fill("250", "Deposit");
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

  // A SECOND, genuinely different entry, entered the way an operator would.
  await new Promise((resolve) => setTimeout(resolve, CLOCK_GAP_MS));
  await fill("975", "Second entry");
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
