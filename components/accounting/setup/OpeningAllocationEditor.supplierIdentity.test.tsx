import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Id } from "@/convex/_generated/dataModel";
import type { OpeningAllocationDraft, OpeningAllocationGroup } from "./openingAllocationForm";

const world = vi.hoisted(() => ({ locale: "en" as "en" | "ar", manageFinance: false,
  rows: [{ _id: "supplier-one", displayName: "شركة Canonical", status: "ACTIVE" as const }],
  creates: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries } = await import("@/lib/i18n/dictionaries");
  return { useLanguage: () => ({ t: (key: string) => (dictionaries[world.locale] as Record<string, string>)[key] ?? key,
    locale: world.locale, language: world.locale, dir: world.locale === "ar" ? "rtl" : "ltr", isRtl: world.locale === "ar" }) };
});
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ isLoading: false,
  hasPermission: (permission: string) => permission !== "manage:finance" || world.manageFinance }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => {
      if (args === "skip") return undefined;
      if (getFunctionName(ref) === "suppliers:list") return { page: world.rows };
      if (getFunctionName(ref) === "suppliers:search") return world.rows;
      return [];
    },
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useMutation: () => async (args: Record<string, unknown>) => { world.creates.push(args); return { supplierId: "supplier-new" }; },
  };
});
import { OpeningAllocationEditor } from "./OpeningAllocationEditor";
import { buildOpeningAllocationPayload, restoreOpeningAllocation } from "./openingAllocationForm";
import { dictionaries } from "@/lib/i18n/dictionaries";

afterEach(() => { cleanup(); world.manageFinance = false; world.creates = []; });
const accountId = "account-one" as Id<"chartOfAccounts">;
const base = { rowKey: "opening-one", accountId, partyId: "" as const, partyLabel: "", amount: "100.003",
  title: "Synthetic opening", dueDate: "", note: "", counterpartyName: "Legacy name" };
function mount(kind: "SUPPLIER_PAYABLE" | "SUPPLIER_RECOVERABLE" | "OTHER_PAYABLE", supplierId?: Id<"suppliers">) {
  const row: OpeningAllocationDraft = { ...base, kind, ...(supplierId ? { supplierId } : {}), ...(kind === "SUPPLIER_RECOVERABLE" ? { purpose: "CLAIM" as const } : {}) };
  const group: OpeningAllocationGroup = { accountId, kind, journalMinor: 100_003, label: "Opening control" };
  const changed = vi.fn();
  render(<OpeningAllocationEditor orgId={"org-one" as Id<"organizations">} currency="JOD" groups={[group]} rows={[row]}
    onChange={changed} canSelectCustomers={false} canSelectEmployees={false} canSelectPartners={false} />);
  return { row, changed };
}
for (const locale of ["en", "ar"] as const) {
  test.each(["SUPPLIER_PAYABLE", "SUPPLIER_RECOVERABLE"] as const)(`${locale} opening %s selects a canonical supplier and emits its id`, kind => {
    world.locale = locale;
    const copy = dictionaries[locale] as Record<string, string>;
    const { row, changed } = mount(kind);
    fireEvent.click(screen.getByRole("combobox", { name: copy.OpeningAllocationSupplier }));
    fireEvent.click(screen.getByTestId("searchable-option-supplier-one"));
    const expected = { ...row, supplierId: "supplier-one", counterpartyName: "شركة Canonical" };
    expect(changed).toHaveBeenCalledWith([expected]);
    const payload = buildOpeningAllocationPayload(changed.mock.calls[0][0], "JOD");
    expect(payload).toEqual([{ kind, rowKey: base.rowKey, accountId, amountMinor: 100_003, title: base.title,
      supplierId: "supplier-one", counterpartyName: "شركة Canonical", ...(kind === "SUPPLIER_RECOVERABLE" ? { purpose: "CLAIM" } : {}) }]);
  });
  test(`${locale} inline create needs manage finance in the opening editor`, async () => {
    world.locale = locale;
    world.manageFinance = true;
    const copy = dictionaries[locale] as Record<string, string>;
    const { row, changed } = mount("SUPPLIER_PAYABLE");
    fireEvent.click(screen.getByRole("combobox", { name: copy.OpeningAllocationSupplier }));
    fireEvent.change(screen.getByPlaceholderText(copy.SupplierPickerSearchPlaceholder), { target: { value: "New supplier" } });
    fireEvent.click(screen.getByRole("button", { name: /New supplier/ }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith([{ ...row, supplierId: "supplier-new", counterpartyName: "New supplier" }]));
    expect(world.creates.map(args => [args.orgId, args.displayName])).toEqual([["org-one", "New supplier"]]);
  });
  test(`${locale} ordinary creditor stays editable without a supplier`, () => {
    world.locale = locale;
    const { row, changed } = mount("OTHER_PAYABLE");
    const copy = dictionaries[locale] as Record<string, string>;
    fireEvent.change(screen.getByRole("textbox", { name: copy.OpeningAllocationCounterpartySnapshot }), { target: { value: "Ordinary creditor" } });
    expect(changed).toHaveBeenCalledWith([{ ...row, counterpartyName: "Ordinary creditor" }]);
    expect(buildOpeningAllocationPayload([row], "JOD")).toEqual([{ kind: "OTHER_PAYABLE", rowKey: base.rowKey, accountId,
      amountMinor: 100_003, counterpartyName: "Legacy name", title: base.title }]);
  });
  test(`${locale} optional supplier creditor can return to an ordinary creditor explicitly`, () => {
    world.locale = locale;
    const { row, changed } = mount("OTHER_PAYABLE", "supplier-one" as Id<"suppliers">);
    const copy = dictionaries[locale] as Record<string, string>;
    const name = screen.getByRole("textbox", { name: copy.OpeningAllocationCounterpartySnapshot }) as HTMLInputElement;
    expect(name.readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: copy.OpeningAllocationOrdinaryCreditor }));
    expect(changed).toHaveBeenCalledWith([{ ...row, supplierId: undefined, counterpartyName: "" }]);
  });
}

test("rehydration retains supplier identity and supplier rows cannot submit free text only", () => {
  const row = { kind: "SUPPLIER_PAYABLE" as const, rowKey: base.rowKey, accountId, amountMinor: 100_003,
    title: base.title, counterpartyName: "Snapshot", supplierId: "supplier-one" as Id<"suppliers"> };
  const restored = restoreOpeningAllocation(row, "JOD");
  expect(buildOpeningAllocationPayload([restored], "JOD")).toEqual([row]);
  expect(buildOpeningAllocationPayload([{ ...base, kind: "SUPPLIER_PAYABLE" }], "JOD")).toBeNull();
});
