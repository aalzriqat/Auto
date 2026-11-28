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
  toastInfo: vi.fn(),
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
  toast: { success: stubs.toastSuccess, error: stubs.toastError, info: stubs.toastInfo },
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

import { CancelCashDealDialog } from "./CancelCashDealDialog";
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
/** Confirm stays focusable while it submits, so its busy state is aria-disabled, not the disabled attribute (SCRUM-1034). */
const busy = (element: HTMLElement) => element.getAttribute("aria-disabled") === "true";
/** The refusal region exists before any refusal (SCRUM-1034), so wait for its text, not for the element. */
const refusalText = () => waitFor(() => {
  const region = screen.getByRole("alert");
  expect(region.textContent).not.toBe("");
  return region;
});
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
  stubs.toastInfo.mockClear();
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
    await waitFor(() => expect(busy(confirm)).toBe(true));
    expect(busy(screen.getByTestId("cancel-deal-keep"))).toBe(true);
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
    const alert = await refusalText();
    const dict = locale === "ar" ? ar : en;
    expect(alert.textContent).toContain(dict.ServerError_SALE_HAS_LEGACY_RECEIVABLE);
    expect(alert.textContent).not.toContain("English server text");
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(busy(screen.getByTestId("cancel-deal-confirm"))).toBe(false);
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
    const alert = await refusalText();
    expect(alert.textContent).toContain((locale === "ar" ? ar : en).CancelDealRefusedLead);
    expect(alert.textContent).toContain(message);
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });

  test("a retry after a refusal clears the old message at once, while the retry is pending, and can succeed", async () => {
    let attempt = 0;
    let finishRetry: (value: unknown) => void = () => undefined;
    stubs.updateImpl = () => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new ConvexError("First refusal"));
      return new Promise((resolve) => { finishRetry = resolve; });
    };
    serve(cashDeal("PENDING"));
    mount();
    fireEvent.click(headerButton()!);
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    // The second request has not answered: the first refusal must already be gone.
    await waitFor(() => expect(busy(screen.getByTestId("cancel-deal-confirm"))).toBe(true));
    expect(stubs.mutationCalls).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toBe("");
    finishRetry(null);
    await waitFor(() => expect(stubs.toastSuccess).toHaveBeenCalledWith(en.CancelDealSuccess));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  test("Escape does not close the dialog while the request is in flight, and does once it has answered", async () => {
    let finish: (value: unknown) => void = () => undefined;
    stubs.updateImpl = () => new Promise((resolve) => { finish = resolve; });
    serve(cashDeal("COMPLETED"));
    mount();
    fireEvent.click(headerButton()!);
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    await waitFor(() => expect(busy(screen.getByTestId("cancel-deal-confirm"))).toBe(true));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape", code: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeDefined();
    finish(null);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});

describe("keyboard and assistive-technology behaviour of the confirmation (SCRUM-1034)", () => {
  // WAI-ARIA APG alertdialog + MDN aria-disabled / ARIA live regions; see the report of this change.
  const startRequest = () => {
    let finish: (value: unknown) => void = () => undefined;
    let fail: (reason: unknown) => void = () => undefined;
    stubs.updateImpl = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    serve(cashDeal("COMPLETED"));
    mount();
    fireEvent.click(headerButton()!);
    const confirm = screen.getByTestId("cancel-deal-confirm");
    confirm.focus();
    fireEvent.click(confirm);
    return { confirm, finish: (value: unknown) => finish(value), fail: (reason: unknown) => fail(reason) };
  };

  // Radix registers its outside-pointer listener on the next macrotask after the layer mounts.
  const settleOutsideListeners = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  test("focus stays on Confirm while the request is in flight, and after a refusal", async () => {
    const request = startRequest();
    await waitFor(() => expect(busy(request.confirm)).toBe(true));
    expect(document.activeElement).toBe(request.confirm);
    await act(async () => request.fail(new ConvexError("Refused")));
    await refusalText();
    expect(document.activeElement).toBe(request.confirm);
    expect(busy(request.confirm)).toBe(false);
  });

  test("focus stays on Keep deal too when the request was started by a pointer that did not move focus", async () => {
    serve(cashDeal("COMPLETED"));
    stubs.updateImpl = () => new Promise(() => undefined);
    mount();
    fireEvent.click(headerButton()!);
    const keep = screen.getByTestId("cancel-deal-keep");
    await waitFor(() => expect(document.activeElement).toBe(keep));
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    await waitFor(() => expect(busy(screen.getByTestId("cancel-deal-confirm"))).toBe(true));
    expect(document.activeElement).toBe(keep);
    expect(busy(keep)).toBe(true);
  });

  test("Confirm announces that it is busy, and a click on it while busy sends nothing more", async () => {
    const request = startRequest();
    await waitFor(() => expect(busy(request.confirm)).toBe(true));
    expect(request.confirm.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(request.confirm);
    fireEvent.keyDown(request.confirm, { key: "Enter", code: "Enter" });
    expect(stubs.mutationCalls).toHaveLength(1);
    await act(async () => request.finish(null));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  test("the refusal sits in a live region that is already mounted, empty, before the refusal arrives", async () => {
    stubs.updateImpl = async () => { throw new ConvexError("Refused after the dialog opened"); };
    serve(cashDeal("COMPLETED"));
    mount();
    fireEvent.click(headerButton()!);
    const region = screen.getByRole("alert");
    expect(region.textContent).toBe("");
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    const announced = await refusalText();
    // The same element that was empty is the one that now holds the text: it was not inserted with it.
    expect(announced).toBe(region);
    expect(announced.textContent).toContain("Refused after the dialog opened");
  });

  test("a click outside the dialog while the request is in flight does not close it", async () => {
    const request = startRequest();
    await waitFor(() => expect(busy(request.confirm)).toBe(true));
    const overlay = document.querySelector("[data-state='open'].fixed.inset-0") as HTMLElement;
    expect(overlay).not.toBeNull();
    await settleOutsideListeners();
    fireEvent.pointerDown(overlay);
    fireEvent.pointerUp(overlay);
    fireEvent.click(overlay);
    expect(screen.getByRole("alertdialog")).toBeDefined();
    await act(async () => request.finish(null));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  test("the dialog's own Close control does not close it while the request is in flight", async () => {
    const request = startRequest();
    await waitFor(() => expect(busy(request.confirm)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("alertdialog")).toBeDefined();
    await act(async () => request.finish(null));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  test("a click outside closes the dialog when nothing is in flight", async () => {
    serve(cashDeal("COMPLETED"));
    mount();
    fireEvent.click(headerButton()!);
    const overlay = document.querySelector("[data-state='open'].fixed.inset-0") as HTMLElement;
    await settleOutsideListeners();
    fireEvent.pointerDown(overlay);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
describe("CancelCashDealDialog on its own, while submitting (SCRUM-1034)", () => {
  // The hook also refuses a second request and ignores a close in flight; these pin the dialog's own
  // layer, so a change to either layer alone cannot reopen the gap. Callbacks are plain props.
  const renderBusy = () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CancelCashDealDialog
        open
        submitting
        error={null}
        isCompleted
        t={(key: string) => en[key] ?? key}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
      />,
    );
    return { onSubmit, onOpenChange };
  };

  test("a click on the busy Confirm does not submit again", () => {
    const { onSubmit } = renderBusy();
    const confirm = screen.getByTestId("cancel-deal-confirm");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("Keep deal, Escape, the Close control and a click outside ask for no close while submitting", async () => {
    const { onOpenChange } = renderBusy();
    fireEvent.click(screen.getByTestId("cancel-deal-keep"));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape", code: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    fireEvent.pointerDown(document.querySelector("[data-state='open'].fixed.inset-0") as HTMLElement);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeDefined();
  });
});
describe("the confirmation is bound to the status that was on screen (SCRUM-1034)", () => {
  const remount = (view: { rerender: (element: ReactElement) => void }) =>
    view.rerender(<SaleDealCockpit orgId={ORG} saleId={SALE} />);

  test("a draft completed elsewhere while the dialog is open closes it, sends nothing and says the deal changed", async () => {
    serve(cashDeal("PENDING"));
    const view = mount();
    fireEvent.click(headerButton()!);
    expect(screen.getByText(en.CancelDealDraftWarning)).toBeDefined();
    serve(cashDeal("COMPLETED"));
    remount(view);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(stubs.toastInfo).toHaveBeenCalledTimes(1);
    expect(stubs.toastInfo).toHaveBeenCalledWith(en.CancelDealChanged);
    expect(stubs.mutationCalls).toEqual([]);
  });

  test("after that notice the operator reopens, reads the completed warning, and only then can confirm", async () => {
    serve(cashDeal("PENDING"));
    const view = mount();
    fireEvent.click(headerButton()!);
    serve(cashDeal("COMPLETED"));
    remount(view);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(headerButton()!);
    expect(screen.getByText(en.CancelDealCompletedWarning)).toBeDefined();
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    await waitFor(() => expect(stubs.toastSuccess).toHaveBeenCalledWith(en.CancelDealSuccess));
    expect(stubs.mutationCalls).toEqual([["sales:update", { orgId: ORG, saleId: SALE, status: "CANCELLED" }]]);
  });

  test("the notice is in Arabic for an Arabic user", async () => {
    stubs.locale = "ar";
    serve(cashDeal("PENDING"));
    const view = mount();
    fireEvent.click(headerButton()!);
    serve(cashDeal("COMPLETED"));
    remount(view);
    await waitFor(() => expect(stubs.toastInfo).toHaveBeenCalledWith(ar.CancelDealChanged));
    expect(ar.CancelDealChanged).toBeTruthy();
    expect(ar.CancelDealChanged).not.toBe(en.CancelDealChanged);
  });

  test("while the request is in flight the dialog stays on the status that was confirmed, and the answer is reported", async () => {
    let finish: (value: unknown) => void = () => undefined;
    stubs.updateImpl = () => new Promise((resolve) => { finish = resolve; });
    serve(cashDeal("PENDING"));
    const view = mount();
    fireEvent.click(headerButton()!);
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    await waitFor(() => expect(busy(screen.getByTestId("cancel-deal-confirm"))).toBe(true));
    serve(cashDeal("COMPLETED"));
    remount(view);
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(screen.getByText(en.CancelDealDraftWarning)).toBeDefined();
    expect(stubs.toastInfo).not.toHaveBeenCalled();
    finish(null);
    await waitFor(() => expect(stubs.toastSuccess).toHaveBeenCalledWith(en.CancelDealSuccess));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(stubs.toastInfo).not.toHaveBeenCalled();
  });

  test("a refusal that arrives after the status changed closes the dialog with the notice, not a stale confirmation", async () => {
    let fail: (reason: unknown) => void = () => undefined;
    stubs.updateImpl = () => new Promise((_resolve, reject) => { fail = reject; });
    serve(cashDeal("PENDING"));
    const view = mount();
    fireEvent.click(headerButton()!);
    fireEvent.click(screen.getByTestId("cancel-deal-confirm"));
    await waitFor(() => expect(busy(screen.getByTestId("cancel-deal-confirm"))).toBe(true));
    serve(cashDeal("COMPLETED"));
    remount(view);
    fail(new ConvexError("Refused"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(stubs.toastInfo).toHaveBeenCalledWith(en.CancelDealChanged);
    expect(stubs.mutationCalls).toHaveLength(1);
  });
});

describe("useCancelCashDeal state belongs to one sale (SCRUM-1034)", () => {
  const OTHER = "sale_9900" as Id<"sales">;
  const hookProps = (saleId: Id<"sales">) => ({ orgId: ORG, saleId, status: "COMPLETED", canCancel: true });
  const mountHook = () =>
    renderHook((props: ReturnType<typeof hookProps>) => useCancelCashDeal(props), { initialProps: hookProps(SALE) });

  test("an open dialog does not carry over to a different sale", () => {
    const { result, rerender } = mountHook();
    act(() => result.current?.onOpenChange(true));
    expect(result.current?.confirming).toBe(true);
    rerender(hookProps(OTHER));
    expect(result.current?.confirming).toBe(false);
    rerender(hookProps(SALE));
    expect(result.current?.confirming).toBe(false);
  });

  test("an old refusal does not carry over to a different sale, nor back", async () => {
    stubs.updateImpl = async () => { throw new ConvexError("Refused for the first sale"); };
    const { result, rerender } = mountHook();
    act(() => result.current?.onOpenChange(true));
    await act(async () => { await result.current?.onSubmit(); });
    expect(result.current?.error).toBe("Refused for the first sale");
    rerender(hookProps(OTHER));
    expect(result.current?.error).toBeNull();
    rerender(hookProps(SALE));
    expect(result.current?.error).toBeNull();
  });

  test("an answer that arrives for the first sale changes nothing on the second", async () => {
    let fail: (reason: unknown) => void = () => undefined;
    stubs.updateImpl = () => new Promise((_resolve, reject) => { fail = reject; });
    const { result, rerender } = mountHook();
    act(() => result.current?.onOpenChange(true));
    await act(async () => { void result.current?.onSubmit(); });
    expect(result.current?.submitting).toBe(true);
    rerender(hookProps(OTHER));
    expect(result.current?.submitting).toBe(false);
    expect(result.current?.confirming).toBe(false);
    await act(async () => fail(new ConvexError("Refused for the first sale")));
    expect(result.current?.error).toBeNull();
    expect(result.current?.confirming).toBe(false);
    expect(result.current?.submitting).toBe(false);
  });

  test("a submit with no open confirmation sends nothing", async () => {
    const { result } = mountHook();
    await act(async () => { await result.current?.onSubmit(); });
    expect(stubs.mutationCalls).toEqual([]);
  });
});

describe("useCancelCashDeal", () => {
  test("two submits in the same tick, before any re-render, send one request", async () => {
    let finish: (value: unknown) => void = () => undefined;
    stubs.updateImpl = () => new Promise((resolve) => { finish = resolve; });
    const { result } = renderHook(() =>
      useCancelCashDeal({ orgId: ORG, saleId: SALE, status: "COMPLETED", canCancel: true }),
    );
    act(() => result.current?.onOpenChange(true));
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

describe("warning wording (SCRUM-969, SCRUM-1034)", () => {
  // A BLACKLIST, not a proof of truth: it only stops the words of effects the server's cancel does
  // not have. restoreVehicleFromSale puts a not-yet-arrived SOURCED car back to SOURCING, not stock;
  // a draft's cancel branch touches no deposit or vehicle hold; the dialog never refunds anyone.
  test.each([["en", en], ["ar", ar]] as const)("%s: neither text uses a word for an inventory, refund or reinstated-deposit effect", (_locale, dict) => {
    for (const text of [dict.CancelDealDraftWarning, dict.CancelDealCompletedWarning]) {
      expect(text).not.toMatch(/inventory|stock|refund|reinstat|المخزون|استرداد|ردّ|إرجاع|إعادة المركبة/i);
    }
    expect(dict.CancelDealDraftWarning).not.toMatch(/reverse|عكس/);
  });

  // Each clause is pinned as a whole sentence-part, so a false statement of the same topic fails it.
  // Server facts (convex/utils/saleCancellation.ts): the trade-in is touched only when the sale's
  // trade-in value is above zero (:253); a reversed deposit lands in RELEASED_AWAITING_DECISION and
  // does not go back to the customer (:484-489); a claim on the supplier is cancelled and refuses
  // after a receipt (:379-381, supplierReceivables.ts:618-619).
  test("the completed warning, in English, states each effect with the condition the server applies", () => {
    const text = en.CancelDealCompletedWarning;
    expect(text).toContain("reverses any deposit applied to it; that money is held until someone decides what happens to it, and is not returned to the customer automatically.");
    expect(text).toContain("If the sale credited a trade-in value, that trade-in vehicle has its purchase cost cleared and, if it was available for sale, moves to inspection.");
    expect(text).toContain("Supplier payables on the sale, any claim on the supplier for a consigned car settled direct to the supplier, and any warranty or GAP deferrals are cancelled.");
    expect(text).toContain("a supplier payment was already made or received,");
    expect(text).not.toContain("A trade-in vehicle taken on the sale has its purchase cost cleared");
  });

  test("the completed warning, in Arabic, states the same effects with the same conditions", () => {
    const text = ar.CancelDealCompletedWarning;
    expect(text).toContain("وعكس أي عربون طُبّق عليه؛ ويبقى هذا المبلغ معلّقًا بانتظار قرار بشأنه، ولا يُعاد إلى العميل تلقائيًا.");
    expect(text).toContain("وإذا احتُسبت قيمة استبدال في البيع، تُمسح تكلفة شراء مركبة الاستبدال، وإن كانت متاحة للبيع فإنها تنتقل إلى الفحص.");
    expect(text).toContain("وتُلغى مستحقات المورد على الصفقة، وأي مطالبة للمعرض على المورد عن مركبة برسم البيع تُسوّى مباشرة مع المورد، وأي تأجيلات خاصة بالضمان أو GAP.");
    expect(text).toContain("أو سُدِّدت دفعة للمورد أو سُجّل استلام مقابل المطالبة على المورد");
    expect(text).not.toContain("المستلمة في هذه الصفقة");
  });
  test("Arabic uses the app's own word for a reservation deposit (عربون), in both warnings", () => {
    for (const text of [ar.CancelDealDraftWarning, ar.CancelDealCompletedWarning]) {
      expect(text).toContain("عربون");
      expect(text).not.toMatch(/مبلغ مقدّم|دفعة مقدمة/);
    }
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
