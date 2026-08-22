/// <reference types="jest" />

import { render, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";

const mockUsePaginatedQuery = jest.fn();

jest.mock("convex/react", () => ({
  usePaginatedQuery: (...args: unknown[]) => mockUsePaginatedQuery(...args),
  // Deliberately provided even though this screen must never call it. Without
  // it, reintroducing a mutation makes the module blow up with an unrelated
  // TypeError; with it, the module renders and the affordance test below fails
  // for the reason a reader would want to see.
  useMutation: () => jest.fn(),
}));

import { LocaleProvider } from "../../../providers/LocaleProvider";
import { ThemeProvider } from "../../../providers/ThemeProvider";
import { AccountingModule } from "./accounting";

/**
 * SCRUM-53 — the mobile Accounting screen is a read-only cashbook view.
 *
 * It used to offer Add / Edit / Delete over `api.transactions.*` and call the
 * rows "قيود" / "ledger entries", while `convex/transactions.ts` is the
 * operational cashbook and the real books are `journalEntries` + `journalLines`.
 * A finance user could correct cash from their phone, watch it succeed, and
 * leave the authoritative GL holding a different number.
 *
 * These tests pin the two halves of that fix as user-visible behaviour: the
 * screen offers no way to write, and it does not present itself as the general
 * ledger. Both are things a future edit could silently undo — restoring a write
 * affordance, or "tidying" the header back to the shorter, wrong word.
 */

const CASH_MOVEMENT = {
  _id: "txn_1",
  orgId: "org_1",
  type: "INCOME",
  amount: 4500,
  date: 1_755_000_000_000,
  category: "SALE",
  description: "Deposit against Camry reservation",
  vehicleLabel: "2021 Toyota Camry",
};

function mockCashbook(results: unknown[]) {
  mockUsePaginatedQuery.mockReturnValue({
    results,
    status: "Exhausted",
    loadMore: jest.fn(),
  });
}

async function renderAccounting() {
  return render(
    <ThemeProvider>
      <LocaleProvider>
        <AccountingModule orgId="org_1" />
      </LocaleProvider>
    </ThemeProvider>,
  );
}

/** The provider reads the stored locale asynchronously, so English needs a tick. */
async function renderAccountingInEnglish() {
  (SecureStore.getItemAsync as jest.MockedFunction<typeof SecureStore.getItemAsync>)
    .mockResolvedValueOnce("en");
  const result = await renderAccounting();
  await waitFor(() => {
    expect(result.queryByText(/general ledger/i)).toBeTruthy();
  });
  return result;
}

describe("AccountingModule — the legacy cashbook is read-only (SCRUM-53)", () => {
  // Every test arms the cashbook itself. An earlier version armed it once in
  // beforeEach and cleared mocks in afterEach, and the shared state silently
  // broke later renders in the file: the write-affordance test below reported
  // zero pressables because nothing had rendered at all, which read exactly
  // like the guard passing.
  test("offers no pressable control at all, so there is no way to write", async () => {
    mockCashbook([CASH_MOVEMENT]);
    const { getByText, queryAllByRole } = await renderAccounting();

    // Anti-vacuity control FIRST. "No buttons found" is also what an empty
    // render looks like, so without this the guard reports success when it has
    // examined nothing — which it demonstrably did: run after the other tests
    // in this file it found zero buttons even against the pre-fix module that
    // renders three, and only found them when run alone. Proving a row is on
    // screen makes the count below a statement about the screen.
    expect(getByText("Deposit against Camry reservation")).toBeTruthy();

    // Asserted by ROLE, not by button text. The first version of this test
    // listed the old labels — "إضافة قيد", "تعديل", "حذف", "Add entry" — and
    // passed against the pre-fix module rendering all three, because
    // PrimaryButton puts its label inside a Pressable that queryByText does not
    // reach. This asks what the user experiences: is there anything to press?
    expect(queryAllByRole("button")).toHaveLength(0);
  });

  test("shows the cash movements the cashbook returns", async () => {
    mockCashbook([CASH_MOVEMENT]);
    const { getByText, unmount } = await renderAccounting();

    expect(getByText("Deposit against Camry reservation")).toBeTruthy();
    expect(getByText(/2021 Toyota Camry/)).toBeTruthy();
    unmount();
  });

  test("reads the cashbook for the organisation it was given", async () => {
    mockCashbook([CASH_MOVEMENT]);
    await renderAccounting();

    // Tenancy is the caller's argument, not something the screen infers.
    expect(mockUsePaginatedQuery).toHaveBeenCalledWith(
      expect.anything(),
      { orgId: "org_1" },
      expect.objectContaining({ initialNumItems: expect.any(Number) }),
    );
  });

  test("says in Arabic that this is a view-only cash record and not the general ledger", async () => {
    mockCashbook([CASH_MOVEMENT]);
    const { getByText, unmount } = await renderAccounting();

    // The defect was a screen that let the reader believe these rows WERE the
    // general ledger. The disclaimer is the correction, so it is load-bearing.
    expect(getByText(/ليس دفتر الأستاذ العام/)).toBeTruthy();
    expect(getByText(/للعرض فقط/)).toBeTruthy();
    unmount();
  });

  test("says in English that this is a view-only cash record and not the general ledger", async () => {
    mockCashbook([CASH_MOVEMENT]);
    const { getByText, unmount } = await renderAccountingInEnglish();

    expect(getByText(/not the general ledger/i)).toBeTruthy();
    expect(getByText(/view only/i)).toBeTruthy();
    unmount();
  });

  test("never calls these rows ledger entries, in either language", async () => {
    mockCashbook([CASH_MOVEMENT]);
    const arabic = await renderAccounting();
    expect(arabic.queryByText(/^قيود/)).toBeNull();
    arabic.unmount();

    mockCashbook([CASH_MOVEMENT]);
    const english = await renderAccountingInEnglish();
    expect(english.queryByText(/ledger entr/i)).toBeNull();
    english.unmount();
  });

  // There is deliberately NO test for the empty cashbook here. Under this
  // harness, an empty `results` renders neither the ListHeaderComponent that
  // carries the "not the general ledger" disclaimer nor the empty-state copy —
  // the FlatList produces no text at all. That is very likely a VirtualizedList
  // artifact of rendering without layout in jest rather than device behaviour,
  // and asserting either outcome would be pinning the harness instead of the
  // product. If it turns out to be real, an empty cashbook shows the disclaimer
  // nowhere, which would matter, so it is written down rather than dropped.
});
