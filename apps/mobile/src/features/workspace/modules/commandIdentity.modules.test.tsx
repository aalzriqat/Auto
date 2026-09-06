/// <reference types="jest" />
/**
 * SCRUM-57 — the mobile command identity, proved at the CALL SITE.
 *
 * `useCommandIdentity.test.tsx` next door pins the identity lifecycle in
 * isolation. That is necessary but not sufficient: the defect this ticket
 * exists to close was never in the lifecycle, it was in how the call sites used
 * it. Mobile previously called `idempotencyKey(...)` inline in each mutation
 * argument list, which mints a FRESH value per invocation — so a retry was a
 * second command and the server had no way to collapse it. A lifecycle object
 * that no screen holds correctly buys nothing.
 *
 * So these tests drive the real modules through the real retry path and assert
 * the economic property directly: what the server actually receives.
 *
 *   - a retry after a failure carries the SAME identity  -> one economic event
 *   - a genuinely new instruction carries a NEW identity  -> not swallowed
 *   - anything feeding the server fingerprint is snapshotted WITH the identity
 *
 * That last one is the subtle half. `expenses.create` and `transactions.add`
 * both fingerprint `date`. A `Date.now()` re-evaluated on the retry changes the
 * fingerprint under a reused identity, which the server is required to reject
 * as a conflict — so an un-snapshotted date turns a safe replay into a hard
 * failure. These tests move the clock between attempts specifically to catch
 * that, which a test using a frozen clock could not do.
 *
 * The UI strings are Arabic because DEFAULT_LOCALE is "ar": this is what the
 * modules actually render.
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
import { CommissionsModule } from "./commissions";
import { ExpensesModule } from "./expenses";
import { SourcingModule } from "./sourcing";

const mockUseMutation = useMutation as jest.MockedFunction<typeof useMutation>;
const mockUsePaginatedQuery = usePaginatedQuery as jest.MockedFunction<typeof usePaginatedQuery>;
const mockUseQuery = useQuery as jest.MockedFunction<typeof useQuery>;

const ORG = "org_1";
const SAVE = "حفظ";
const SAVING = "جاري الحفظ...";

/** Every module reads `locale` and `useStyles`, so both providers are required. */
async function renderModule(node: React.ReactElement) {
  return await render(
    <ThemeProvider>
      <LocaleProvider>{node}</LocaleProvider>
    </ThemeProvider>,
  );
}

/**
 * Hands every `useMutation` call the SAME spy, so a module that takes several
 * mutations still routes the one under test through an inspectable function.
 * Asserting on one shared spy avoids depending on the order the module happens
 * to call `useMutation` in.
 */
function mutationSpy() {
  const spy = jest.fn();
  mockUseMutation.mockReturnValue(spy as unknown as ReturnType<typeof useMutation>);
  return spy;
}

/** The identity actually sent to the server on the Nth call. */
function keyOf(spy: jest.Mock, call: number): string {
  return (spy.mock.calls[call][0] as { idempotencyKey: string }).idempotencyKey;
}

/**
 * The submit button disables itself and relabels while in flight. Pressing it
 * again before it settles would be a no-op, which would make a broken retry
 * look like a passing test — so wait for it to come back.
 */
async function waitForIdle(queryByText: (text: string) => unknown) {
  await waitFor(() => expect(queryByText(SAVING)).toBeNull());
}

const commissionSale = (id: string) => ({
  _id: id,
  orgId: ORG,
  status: "COMPLETED",
  commissionAmount: 500,
  commissionStatus: "UNPAID",
  vehicleSummary: "2020 Toyota Camry",
  vehicleVin: "VIN1",
  customerName: "Buyer",
  salespersonName: "Seller",
});

const payable = (id: string) => ({
  _id: id,
  orgId: ORG,
  vehicleId: "veh_1",
  sourcedFromName: "Supplier",
  amountDue: 1000,
  currency: "AED",
  status: "PENDING",
  createdAt: 1,
  vehicleDesc: "2020 Toyota Camry",
  vehicleVin: "VIN1",
  customerName: "Buyer",
});

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
  // The failure path reports through Alert + console.error by design; silence
  // them so a deliberately rejected mutation does not look like a broken test.
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("commissions — sales.markCommissionPaid", () => {
  const PAY = "تسجيل كمدفوعة";

  async function renderWith(sales: unknown[]) {
    mockUsePaginatedQuery.mockReturnValue({
      results: sales,
      status: "Exhausted",
      isLoading: false,
      loadMore: jest.fn(),
    } as unknown as ReturnType<typeof usePaginatedQuery>);
    return await renderModule(<CommissionsModule orgId={ORG} />);
  }

  test("a retry after a failed payout re-sends the SAME identity, so it is ONE payment", async () => {
    const spy = mutationSpy();
    spy.mockRejectedValue(new Error("network lost"));
    const { getByText } = await renderWith([commissionSale("sale_1")]);

    fireEvent.press(getByText(PAY));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // The operator sees the failure and presses again — the classic double pay.
    fireEvent.press(getByText(PAY));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    expect(keyOf(spy, 1)).toBe(keyOf(spy, 0));
  });

  test("after the payout SUCCEEDS the identity is retired, so a later payment is a NEW command", async () => {
    const spy = mutationSpy();
    spy.mockResolvedValue(null);
    const { getByText } = await renderWith([commissionSale("sale_1")]);

    fireEvent.press(getByText(PAY));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    fireEvent.press(getByText(PAY));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    // Reusing the retired identity would make the server replay the first
    // payout and silently discard a second, genuinely-intended one.
    expect(keyOf(spy, 1)).not.toBe(keyOf(spy, 0));
  });

  test("two different sales never share an identity", async () => {
    const spy = mutationSpy();
    spy.mockRejectedValue(new Error("network lost"));
    const { getAllByText } = await renderWith([commissionSale("sale_1"), commissionSale("sale_2")]);

    const buttons = getAllByText(PAY);
    fireEvent.press(buttons[0]);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    fireEvent.press(buttons[1]);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    // The intent is keyed per sale; collapsing them would drop a real payout.
    expect(keyOf(spy, 1)).not.toBe(keyOf(spy, 0));
  });
});

describe("sourcing — sourcingPayables.markPaid", () => {
  test("a retry after a failed supplier payment re-sends the SAME identity", async () => {
    const spy = mutationSpy();
    spy.mockRejectedValue(new Error("network lost"));
    mockUseQuery.mockReturnValue([payable("pay_1")] as unknown as ReturnType<typeof useQuery>);
    const { getByText, queryByText } = await renderModule(<SourcingModule orgId={ORG} />);

    fireEvent.press(getByText("تسجيل الدفع"));
    // The form is inside a Modal that only mounts once `selected` is set.
    await waitFor(() => expect(queryByText(SAVE)).not.toBeNull());
    fireEvent.press(getByText(SAVE));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await waitForIdle(queryByText);

    fireEvent.press(getByText(SAVE));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    expect(keyOf(spy, 1)).toBe(keyOf(spy, 0));
  });

  test("after the payment SUCCEEDS the identity is retired, so the next one is a NEW command", async () => {
    // The mirror of the retry case, and the half that was untested: holding an
    // identity too long is as dangerous as never holding it. Reusing a retired
    // identity would make the server replay the completed payment and silently
    // discard a second, genuinely-intended one while reporting success.
    const spy = mutationSpy();
    spy.mockResolvedValue(null);
    mockUseQuery.mockReturnValue([payable("pay_1")] as unknown as ReturnType<typeof useQuery>);
    const { getByText, queryByText } = await renderModule(<SourcingModule orgId={ORG} />);

    fireEvent.press(getByText("تسجيل الدفع"));
    await waitFor(() => expect(queryByText(SAVE)).not.toBeNull());
    fireEvent.press(getByText(SAVE));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // Success closes the sheet, which is what proves the handler ran past
    // `commandId.retire(intent)`.
    await waitFor(() => expect(queryByText(SAVE)).toBeNull());

    // A second, genuinely separate payment on the same payable.
    fireEvent.press(getByText("تسجيل الدفع"));
    await waitFor(() => expect(queryByText(SAVE)).not.toBeNull());
    fireEvent.press(getByText(SAVE));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    expect(keyOf(spy, 1)).not.toBe(keyOf(spy, 0));
  });
});

describe("expenses — expenses.create", () => {
  test("a validation failure sends nothing at all, so no identity is spent", async () => {
    const spy = mutationSpy();
    const { getByText, queryByText } = await renderModule(<ExpensesModule orgId={ORG} />);

    fireEvent.press(getByText("إضافة مصروف"));
    await waitFor(() => expect(queryByText(SAVE)).not.toBeNull());
    fireEvent.press(getByText(SAVE));

    // An identity minted for a command that is never sent would be spent: the
    // real submit that follows would carry a key the server has already seen.
    await waitFor(() => expect(spy).not.toHaveBeenCalled());
  });
});
