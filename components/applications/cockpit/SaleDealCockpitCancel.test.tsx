/**
 * SCRUM-969 -- "Cancel deal" on the CASH deal screen, decided at the CONTAINER.
 *
 * `sales.update({ status: "CANCELLED" })` is the one server door that cancels a
 * cash sale. The server stays the only authority (edit:sales + approve:requests,
 * a separate actor from the salesperson, no linked application, customer-credit
 * disposition for a completed sale); the screen only has to (a) not offer the
 * action to a caller who lacks the two permissions, (b) send exactly the request
 * the Sales page sends, once, and (c) show the server's refusal in the user's
 * language, in the dialog, leaving the deal as it was.
 *
 * Like `DealCockpitSupplierAuthority.test.tsx`, this renders the real container
 * against the real permission hook; only the Convex SDK boundary is simulated.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render as renderTree, renderHook, screen, waitFor, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import type { ReactElement } from "react";
import { OrgProvider } from "@/components/providers/OrgProvider";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stubs = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  queryResults: new Map<string, unknown>(),
  membership: undefined as { roleName: string; isSystemOwnerRole?: boolean; permissions: string[] } | undefined,
  /** Every mutation call: [function name, args]. */
  mutationCalls: [] as Array<[string, unknown]>,
  /** What the next `sales:update` call does. */
  updateImpl: (async () => null) as (args: unknown) => Promise<unknown>,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries: dicts } = await import("@/lib/i18n/dictionaries");
  return {
    useLanguage: () => ({
      t: (key: string) => (dicts[stubs.locale] as Record<string, string>)[key] ?? key,
      isRtl: stubs.locale === "ar",
      locale: stubs.locale,
    }),
  };
});

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "JD",
    displayLabel: "Jordanian Dinar",
    format: (n: number) => `JD ${n}`,
    formatCompact: (n: number) => String(n),
    scale: 3,
  }),
}));

vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: () => 3,
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: stubs.toastSuccess, error: stubs.toastError },
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const mutations = new Map<string, (args: unknown) => Promise<unknown>>();
  return {
    useQueries: (queries: Record<string, { query: never }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query }]) => [key, stubs.queryResults.get(getFunctionName(query))]),
      ),
    useConvexAuth: () => ({ isAuthenticated: true }),
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      if (name === "organizations:listMine") return [{ _id: "org1" }];
      if (name === "memberships:getMyMembership") return stubs.membership;
      return args === "skip" ? undefined : stubs.queryResults.get(name);
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      let call = mutations.get(name);
      if (!call) {
        call = async (args: unknown) => {
          stubs.mutationCalls.push([name, args]);
          return name === "sales:update" ? stubs.updateImpl(args) : null;
        };
        mutations.set(name, call);
      }
      return call;
    },
  };
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org1" }),
  usePathname: () => "/org1/deals",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

import { SaleDealCockpit } from "./SaleDealCockpit";
import { useCancelCashDeal } from "./useCancelCashDeal";

type CashDealCockpitData = NonNullable<(typeof api.sales.dealCockpit)["_returnType"]>;

const ORG = "org1" as Id<"organizations">;
const SALE = "sale_7731" as Id<"sales">;
const APP = "app_2048" as Id<"financeApplications">;

function render(element: ReactElement) {
  return renderTree(element, { wrapper: OrgProvider });
}

/** An applicationless cash sale, as `sales.dealCockpit` serves it, in a given status. */
function cashDeal(
  status: "PENDING" | "COMPLETED" | "CANCELLED",
  overrides: Partial<CashDealCockpitData> = {},
): CashDealCockpitData {
  return {
    dealKind: "CASH",
    financingApplicationId: null,
    dealRef: "sale_7731",
    saleId: SALE,
    applicationId: null,
    status,
    createdAt: Date.UTC(2026, 7, 1),
    updatedAt: undefined,
    customer: { id: "c1" as Id<"customers">, name: "Sami", phone: "0790112233" },
    vehicle: {
      id: "v1" as Id<"vehicles">,
      label: "Volkswagen e-Golf 2020",
      vin: "WVWZZZAUZLW901234",
      consigned: false,
      supplierName: "",
      profile: null,
    },
    salespersonName: "Layth",
    financeCompanyName: "",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    stages: [{ key: "SALE_AGREED", state: "COMPLETE", authority: "DEALER" }],
    documents: [],
    timeline: [],
    money: {
      currency: "JOD",
      settlesDirectToSupplier: false,
      routeKnown: true,
      managementNetProfit: { available: false, reason: "CommissionsUnreadable" },
      profit: {
        available: true,
        basis: "ACCOUNTING_RESULT",
        amountMinor: 3_000_000,
        currency: "JOD",
        reconcilesToLedger: true,
        lines: [{ key: "SALE_PRICE", sign: 1, amountMinor: 20_000_000 }],
      },
      expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
      parties: [],
      customerInvoice: { state: "NONE", outstandingMinor: null, currency: "JOD" },
      supplierReceipt: { actionable: false },
      appraisalGapMinor: undefined,
      shortfall: undefined,
    },
    customerInvoiceState: "NONE",
    ...overrides,
  } as CashDealCockpitData;
}

const BASE = [PERMISSIONS.VIEW_SALES, PERMISSIONS.VIEW_FINANCE];
const CAN_CANCEL = [...BASE, PERMISSIONS.EDIT_SALES, PERMISSIONS.APPROVE_REQUESTS];

function serve(deal: CashDealCockpitData, permissions: string[] = CAN_CANCEL) {
  stubs.queryResults.set("sales:dealCockpit", deal);
  stubs.membership = { roleName: "Custom", permissions };
}

const mount = () => render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
const headerButton = () => screen.queryByTestId("deal-cancel-deal");
const en = dictionaries.en as Record<string, string>;
const ar = dictionaries.ar as Record<string, string>;

beforeEach(() => {
  stubs.locale = "en";
  stubs.updateImpl = async () => null;
});

afterEach(() => {
  cleanup();
  stubs.queryResults.clear();
  stubs.membership = undefined;
  stubs.mutationCalls.length = 0;
  stubs.toastSuccess.mockClear();
  stubs.toastError.mockClear();
});

describe("who is offered Cancel deal", () => {
  test.each(["PENDING", "COMPLETED"] as const)("a %s applicationless deal shows it to edit:sales + approve:requests", (status) => {
    serve(cashDeal(status));
    mount();
    expect(headerButton()).not.toBeNull();
    expect(headerButton()?.textContent).toContain(en.CancelDealAction);
  });

  test("without approve:requests there is no button", () => {
    serve(cashDeal("COMPLETED"), [...BASE, PERMISSIONS.EDIT_SALES]);
    mount();
    expect(headerButton()).toBeNull();
  });

  test("without edit:sales there is no button", () => {
    serve(cashDeal("COMPLETED"), [...BASE, PERMISSIONS.APPROVE_REQUESTS]);
    mount();
    expect(headerButton()).toBeNull();
  });

  test("a CANCELLED deal has no button", () => {
    serve(cashDeal("CANCELLED"));
    mount();
    expect(headerButton()).toBeNull();
  });

  test("while the permissions load there is no button", () => {
    serve(cashDeal("COMPLETED"));
    stubs.membership = undefined;
    mount();
    expect(headerButton()).toBeNull();
  });

  test("an applicationless sale is offered it whatever its dealKind says (a legacy FINANCED draft)", () => {
    serve({ ...cashDeal("PENDING"), dealKind: "FINANCED" } as unknown as CashDealCockpitData);
    mount();
    expect(headerButton()).not.toBeNull();
  });

  test("the financed branch (a deal with an application) is delegated and gets no cash button", () => {
    serve(cashDeal("COMPLETED", { financingApplicationId: APP }));
    mount();
    expect(headerButton()).toBeNull();
  });
});

describe("confirming the cancellation", () => {
  test("opens a cash-specific alert dialog, not the application dialog", () => {
    serve(cashDeal("COMPLETED"));
    mount();
    fireEvent.click(headerButton()!);
    const dialog = screen.getByRole("alertdialog", { name: en.CancelDealTitle });
    expect(within(dialog).getByText(en.CancelDealCompletedWarning)).toBeDefined();
    expect(screen.queryByText(en.ConfirmCancelApplication)).toBeNull();
    expect(screen.queryByLabelText(en.FailureReasonLabel)).toBeNull();
    expect(stubs.mutationCalls).toEqual([]);
  });

  test("a draft is warned about as a draft, a completed sale as a reversal", () => {
    serve(cashDeal("PENDING"));
    mount();
    fireEvent.click(headerButton()!);
    expect(screen.getByText(en.CancelDealDraftWarning)).toBeDefined();
    expect(screen.queryByText(en.CancelDealCompletedWarning)).toBeNull();
  });

  test("the least destructive action (Keep deal) takes the initial focus", async () => {
    serve(cashDeal("COMPLETED"));
    mount();
    fireEvent.click(headerButton()!);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("cancel-deal-keep")));
  });

  test("Keep deal closes without sending anything", async () => {
    serve(cashDeal("COMPLETED"));
    mount();
    fireEvent.click(headerButton()!);
    fireEvent.click(screen.getByTestId("cancel-deal-keep"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(stubs.mutationCalls).toEqual([]);
  });

  test("Confirm sends exactly { orgId, saleId, status: CANCELLED } once, toasts and closes", async () => {
    serve(cashDeal("COMPLETED"));
    mount();
    fireEvent.click(headerButton()!);
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    await waitFor(() => expect(stubs.toastSuccess).toHaveBeenCalledWith(en.CancelDealSuccess));
    expect(stubs.mutationCalls).toEqual([["sales:update", { orgId: ORG, saleId: SALE, status: "CANCELLED" }]]);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  test("a double click while the request is in flight sends it once and disables both buttons", async () => {
    let finish: (value: unknown) => void = () => undefined;
    stubs.updateImpl = () => new Promise((resolve) => { finish = resolve; });
    serve(cashDeal("COMPLETED"));
    mount();
    fireEvent.click(headerButton()!);
    const confirm = screen.getByTestId("cancel-deal-confirm");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByTestId("cancel-deal-keep") as HTMLButtonElement).disabled).toBe(true);
    expect(stubs.mutationCalls).toHaveLength(1);
    finish(null);
    await waitFor(() => expect(stubs.toastSuccess).toHaveBeenCalledTimes(1));
  });

  test.each(["en", "ar"] as const)("a coded refusal is shown translated in %s and the dialog stays open", async (locale) => {
    stubs.locale = locale;
    stubs.updateImpl = async () => {
      throw new ConvexError({ code: "SALE_HAS_LEGACY_RECEIVABLE", message: "English server text" });
    };
    serve(cashDeal("COMPLETED"));
    mount();
    fireEvent.click(headerButton()!);
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    const alert = await screen.findByRole("alert");
    const dict = locale === "ar" ? ar : en;
    expect(alert.textContent).toContain(dict.ServerError_SALE_HAS_LEGACY_RECEIVABLE);
    expect(alert.textContent).not.toContain("English server text");
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect((screen.getByTestId("cancel-deal-confirm") as HTMLButtonElement).disabled).toBe(false);
    expect(stubs.toastSuccess).not.toHaveBeenCalled();
  });

  test.each(["en", "ar"] as const)("an un-coded refusal keeps the server text under a %s lead-in, dialog open", async (locale) => {
    stubs.locale = locale;
    const message = "Salesperson cannot approve cancellation of their own sale.";
    stubs.updateImpl = async () => { throw new ConvexError(message); };
    serve(cashDeal("COMPLETED"));
    mount();
    fireEvent.click(headerButton()!);
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain((locale === "ar" ? ar : en).CancelDealRefusedLead);
    expect(alert.textContent).toContain(message);
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });

  test("a retry after a refusal clears the old message and can succeed", async () => {
    let attempt = 0;
    stubs.updateImpl = async () => {
      attempt += 1;
      if (attempt === 1) throw new ConvexError("First refusal");
      return null;
    };
    serve(cashDeal("PENDING"));
    mount();
    fireEvent.click(headerButton()!);
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    await waitFor(() => expect(stubs.toastSuccess).toHaveBeenCalledWith(en.CancelDealSuccess));
    expect(stubs.mutationCalls).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

describe("useCancelCashDeal", () => {
  test("two submits in the same tick, before any re-render, send one request", async () => {
    let finish: (value: unknown) => void = () => undefined;
    stubs.updateImpl = () => new Promise((resolve) => { finish = resolve; });
    const { result } = renderHook(() =>
      useCancelCashDeal({ orgId: ORG, saleId: SALE, status: "COMPLETED", canCancel: true }),
    );
    await act(async () => {
      void result.current?.onSubmit();
      void result.current?.onSubmit();
    });
    expect(stubs.mutationCalls).toHaveLength(1);
    await act(async () => finish(null));
  });

  test("it offers nothing for a cancelled sale, an unknown status or a caller without both permissions", () => {
    const offered = (status: string | undefined, canCancel: boolean) =>
      renderHook(() => useCancelCashDeal({ orgId: ORG, saleId: SALE, status, canCancel })).result.current;
    expect(offered("CANCELLED", true)).toBeUndefined();
    expect(offered(undefined, true)).toBeUndefined();
    expect(offered("COMPLETED", false)).toBeUndefined();
    expect(offered("PENDING", true)?.isCompleted).toBe(false);
    expect(offered("COMPLETED", true)?.isCompleted).toBe(true);
  });
});

describe("the warnings claim only what holds for every sale this button reaches (SCRUM-969)", () => {
  // restoreVehicleFromSale puts a not-yet-arrived SOURCED car back to SOURCING, not stock; a draft's
  // cancel branch touches no deposit or vehicle hold. So neither text may promise those effects.
  test.each([["en", en], ["ar", ar]] as const)("%s: no inventory, refund or reinstated-deposit promise", (_locale, dict) => {
    for (const text of [dict.CancelDealDraftWarning, dict.CancelDealCompletedWarning]) {
      expect(text).not.toMatch(/inventory|stock|refund|reinstat|المخزون|استرداد|إعادة المركبة/i);
    }
    expect(dict.CancelDealDraftWarning).not.toMatch(/reverse|عكس/);
  });
});

describe("Arabic copy", () => {
  test("the action, title and buttons are the agreed Arabic", () => {
    stubs.locale = "ar";
    serve(cashDeal("COMPLETED"));
    mount();
    expect(headerButton()?.textContent).toContain("إلغاء الصفقة");
    fireEvent.click(headerButton()!);
    expect(screen.getByRole("alertdialog", { name: "هل تريد إلغاء هذه الصفقة؟" })).toBeDefined();
    expect(screen.getByTestId("cancel-deal-keep").textContent).toBe("الإبقاء على الصفقة");
    expect(screen.getByTestId("cancel-deal-confirm").textContent).toContain("إلغاء الصفقة");
  });
});
