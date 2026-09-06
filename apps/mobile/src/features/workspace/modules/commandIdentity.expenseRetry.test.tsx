/// <reference types="jest" />
/**
 * SCRUM-57 — an expense RETRY must be one economic event, not two.
 *
 * `expenses.create` fingerprints `date`. So holding the identity across a retry
 * is only half the job: if the handler re-evaluates `Date.now()` on the second
 * attempt it sends the SAME identity with a DIFFERENT fingerprint, which the
 * server is required to reject as a conflict. A genuine retry would then fail
 * hard instead of replaying. The date has to be snapshotted WITH the identity.
 *
 * This scenario lives in its own file on purpose, but for an observed reason
 * rather than an explained one: after a test in this tree types into a form and
 * lets that update settle, a second `render()` in the same jest module registry
 * yields an empty tree, so every later query misses and the failure reads as a
 * broken assertion rather than broken teardown. Jest isolates per file, so one
 * form scenario per file is the reliable boundary.
 *
 * That is REPRODUCIBLE BUT NOT ROOT-CAUSED, and it is deliberately stated as an
 * observation. An earlier revision of this comment asserted a cause — that a
 * `TextInput` inside RN's `Modal` cannot be cleanly remounted — which was
 * disproved. Do not replace this with another mechanism unless it is measured.
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

test("a retried expense re-sends the SAME identity AND the SAME date, so it replays instead of conflicting", async () => {
  const spy = jest.fn();
  spy.mockRejectedValue(new Error("network lost"));
  mockUseMutation.mockReturnValue(spy as unknown as ReturnType<typeof useMutation>);

  const { getByLabelText, getByText, queryByText } = await render(
    <ThemeProvider>
      <LocaleProvider>
        <ExpensesModule orgId={ORG} />
      </LocaleProvider>
    </ThemeProvider>,
  );

  fireEvent.press(getByText("إضافة مصروف"));
  await waitFor(() => expect(queryByText(SAVE)).not.toBeNull());
  fireEvent.changeText(getByLabelText("العنوان"), "Tyres");
  fireEvent.changeText(getByLabelText("المبلغ"), "300");
  // Validation reads component state, so the typed values must be committed
  // before Save — otherwise the handler bails on an empty form and "no mutation
  // was called" would look like a passing idempotency test.
  await waitFor(() =>
    expect((getByLabelText("المبلغ") as unknown as { props: { value: string } }).props.value).toBe("300"),
  );

  const startedAt = Date.now();
  fireEvent.press(getByText(SAVE));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  // The button disables and relabels in flight; pressing again before it
  // settles would be a no-op and a broken retry would look like a pass.
  await waitFor(() => expect(queryByText(SAVING)).toBeNull());

  // Real time passes before the operator presses again.
  await new Promise((resolve) => setTimeout(resolve, CLOCK_GAP_MS));
  fireEvent.press(getByText(SAVE));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

  const first = spy.mock.calls[0][0] as { idempotencyKey: string; date: number };
  const second = spy.mock.calls[1][0] as { idempotencyKey: string; date: number };

  // Control: the clock really did move, so the date equality below is evidence
  // of snapshotting rather than of two presses landing in the same millisecond.
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CLOCK_GAP_MS);
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  expect(second.date).toBe(first.date);
});
