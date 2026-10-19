/**
 * SCRUM-724 Gate B bridge: renders the MOUNTED operator money UI to markup for
 * the real-engine visual gate (`playwright/visual/deal-money.visual.spec.ts`).
 *
 * Real components, real dictionaries, no re-implementation:
 *   - the deal page client (`SaleDealCockpitClient`) with the cockpit itself
 *     replaced by a placeholder and the REAL `DealInvoiceReceiptsPanel` mounted,
 *     in the pilot (doors/payout dark), doors-open, view-only, coded-refusal,
 *     refund-form and query-failure states;
 *   - `CollectionsTab` on the Approvals tab, as an accountant (manage only), a
 *     manager (approve only) and both, with payout dark and open.
 *
 * Gated on `DEAL_MONEY_VISUAL_FIXTURE=1`; writes only into the per-run directory
 * named by `DEAL_MONEY_VISUAL_FIXTURE_DIR`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stubs = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  permissions: new Set<string>(),
  queryResults: new Map<string, unknown>(),
  paginated: new Map<string, unknown[]>(),
  throwStatus: false,
  rejectWith: new Map<string, unknown>(),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => {
      const table = dictionaries[stubs.locale] as Record<string, string>;
      return table[key] || (dictionaries.en as Record<string, string>)[key] || key;
    },
    isRtl: stubs.locale === "ar",
    locale: stubs.locale,
  }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org1" }) }));
vi.mock("next/navigation", () => ({ useParams: () => ({ saleId: "sale1" }) }));
vi.mock("@/components/applications/cockpit/useStageDeepLink", () => ({ useStageDeepLink: () => undefined }));
vi.mock("@/components/applications/cockpit/DealCockpit", () => ({
  SaleDealCockpit: () => (
    <div data-testid="cockpit-placeholder"
      className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
      [deal cockpit]
    </div>
  ),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ isLoading: false, hasPermission: (p: string) => stubs.permissions.has(p) }),
}));
vi.mock("@/hooks/useCurrencyFormatter", () => ({
  useCurrencyFormatter: () => (n: number) => `${n.toLocaleString("en-US")} JOD`,
}));
vi.mock("@/hooks/useCommandIdentity", () => ({
  useCommandIdentity: () => ({ for: (k: string) => k, retire: () => {} }),
}));
vi.mock("@/components/accounting/collections/CashDrawerPanel", () => ({ CashDrawerPanel: () => null }));
vi.mock("@/components/accounting/collections/PaymentLinksPanel", () => ({ PaymentLinksPanel: () => null }));
vi.mock("@/components/accounting/collections/InstallmentCalendar", () => ({ InstallmentCalendar: () => null }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      if (args === "skip") return undefined;
      const name = getFunctionName(reference);
      if (name === "collections:saleInvoiceReceiptStatus" && stubs.throwStatus) {
        throw new Error("[CONVEX Q(collections:saleInvoiceReceiptStatus)] Server Error");
      }
      const value = stubs.queryResults.get(name);
      return typeof value === "function" ? (value as (a: unknown) => unknown)(args) : value;
    },
    usePaginatedQuery: (reference: never, args: unknown) => ({
      results: args === "skip" ? [] : stubs.paginated.get(getFunctionName(reference)) ?? [],
      status: "Exhausted",
      loadMore: () => {},
    }),
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      return async () => {
        if (stubs.rejectWith.has(name)) throw stubs.rejectWith.get(name);
        return null;
      };
    },
  };
});

import { SaleDealCockpitClient } from "@/app/(dashboard)/[orgId]/sales/[saleId]/deal/client";
import { CollectionsTab } from "@/components/accounting/CollectionsTab";

const ENABLED = process.env.DEAL_MONEY_VISUAL_FIXTURE === "1";
const DIR = process.env.DEAL_MONEY_VISUAL_FIXTURE_DIR ?? "";

const ACCOUNTANT = ["view:finance", "manage:finance"];
const MANAGER = ["view:finance", "approve:requests"];
const VIEWER = ["view:finance"];

function write(name: string): void {
  writeFileSync(resolve(DIR, `${name}-${stubs.locale}.html`), document.body.innerHTML);
}

const t = (key: string): string => {
  const table = dictionaries[stubs.locale] as Record<string, string>;
  return table[key] || (dictionaries.en as Record<string, string>)[key] || key;
};

function seedDeal(flags: { doors?: boolean; payout?: boolean }) {
  stubs.queryResults.set("collections:saleInvoiceReceiptStatus", {
    page: [{ applicationId: "a1", receiptMovementId: "m1", amountMinor: 1_250_000, currency: "JOD",
      createdAt: Date.UTC(2026, 9, 1), readiness: "ORIGINS_VERIFIED" }],
    isDone: true, continueCursor: "", customerId: "c1", saleStatus: "COMPLETED", receiptCurrency: "JOD",
    invoice: { currency: "JOD", originalAmountMinor: 18_500_000, outstandingMinor: 6_250_000, availableToReserveMinor: 5_000_000 },
    ...(flags.doors === undefined ? {} : { saleInvoiceDoorsAvailable: flags.doors }),
    ...(flags.payout === undefined ? {} : { retainedCreditPayoutAvailable: flags.payout }),
  });
  stubs.paginated.set("collections:listSaleCustomerCheques", [
    { chequeId: "q1", bank: "Arab Bank", chequeNumber: "004512", chequeDate: 1, amount: 2500, status: "HELD" },
    { chequeId: "q2", bank: "Housing Bank", chequeNumber: "118830", chequeDate: 1, amount: 9000, status: "HELD" },
    { chequeId: "q3", bank: "Cairo Amman Bank", chequeNumber: "770021", chequeDate: 1, amount: 1200, status: "DEPOSITED" },
  ]);
  stubs.paginated.set("collections:listRetainedCredits", [
    { receiptMovementId: "m9", availableUnappliedMinor: 750_000, currency: "JOD", receiptPosted: true,
      createdAt: Date.UTC(2026, 8, 20), sourceChequeLabel: "Arab Bank #003911", originatingSaleStatus: "CANCELLED" },
  ]);
}

const refundRow = (over: { _id?: string; customerName?: string; status: "PENDING" | "APPROVED" }) => ({
  _id: "r1", orgId: "org1", amountMinor: 750_000, currency: "JOD", customerName: "Layla Haddad",
  sourceChequeLabel: "Arab Bank #003911", originatingSaleStatus: "CANCELLED", requestedByMe: false, ...over,
});

function seedApprovals(payout: boolean) {
  stubs.queryResults.set("collections:summary", {
    totalOutstanding: 0, overdueOutstanding: 0, dueToday: 0, collectedToday: 0, upcomingChequeTotal: 0,
    retainedCreditPayoutAvailable: payout,
  });
  stubs.queryResults.set("collections:listApprovals", []);
  const rows = [refundRow({ status: "PENDING" }), refundRow({ _id: "r2", customerName: "Omar Nasser", status: "APPROVED" })];
  stubs.queryResults.set("retainedCreditRefunds:listRetainedCreditRefundRequests",
    (args: { status?: string }) => rows.filter((row) => row.status === args.status));
}

async function openApprovals() {
  render(<CollectionsTab />);
  const tab = screen.getByRole("tab", { name: t("Approvals") });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.focus(tab);
  await screen.findByTestId("retained-credit-refunds", undefined, { timeout: 3000 });
}

afterEach(() => {
  cleanup();
  stubs.permissions = new Set();
  stubs.queryResults.clear();
  stubs.paginated.clear();
  stubs.throwStatus = false;
  stubs.rejectWith.clear();
});

describe.skipIf(!ENABLED)("deal money visual fixtures (SCRUM-724 mount)", () => {
  test.each(["en", "ar"] as const)("%s", async (locale) => {
    stubs.locale = locale;
    mkdirSync(DIR, { recursive: true });

    // 1. The pilot: doors and payout dark (reported false), finance manager.
    stubs.permissions = new Set(ACCOUNTANT);
    seedDeal({ doors: false, payout: false });
    render(<SaleDealCockpitClient />);
    expect((screen.getByRole("button", { name: t("DealReceiptRecordButton") }) as HTMLButtonElement).disabled).toBe(true);
    write("deal-pilot-manager");
    cleanup();

    // 2. Flags absent (a backend that does not report them): same as dark.
    seedDeal({});
    render(<SaleDealCockpitClient />);
    write("deal-flags-absent");
    cleanup();

    // 3. Doors open (what an owner-approved flip would look like).
    seedDeal({ doors: true, payout: true });
    render(<SaleDealCockpitClient />);
    write("deal-open-manager");
    cleanup();

    // 4. View-only finance: balances, no actions.
    stubs.permissions = new Set(VIEWER);
    seedDeal({ doors: false, payout: false });
    render(<SaleDealCockpitClient />);
    write("deal-viewer");
    cleanup();

    // 5. No finance permission: the panel withholds itself.
    stubs.permissions = new Set();
    render(<SaleDealCockpitClient />);
    expect(screen.queryByTestId("deal-invoice-receipts")).toBeNull();
    write("deal-no-finance");
    cleanup();

    // 6. A coded refusal (CR-1) in the user's language.
    stubs.permissions = new Set(ACCOUNTANT);
    seedDeal({ doors: true, payout: true });
    stubs.rejectWith.set("collections:activateSaleInvoiceReceipt",
      new ConvexError({ code: "SALE_INVOICE_RECEIPT_DOORS_DISABLED", message: "Recording ... (server English)" }));
    render(<SaleDealCockpitClient />);
    fireEvent.click(screen.getByRole("button", { name: t("DealReceiptTryActivateButton") }));
    await screen.findByRole("alert");
    write("deal-coded-refusal");
    cleanup();

    // 7. The refund request form open (bank transfer only).
    render(<SaleDealCockpitClient />);
    fireEvent.click(screen.getByRole("button", { name: t("RetainedCreditRequestRefund") }));
    write("deal-refund-form");
    cleanup();

    // 8. The status query fails: the panel degrades, the cockpit stays.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubs.throwStatus = true;
    render(<SaleDealCockpitClient />);
    expect(screen.getByTestId("cockpit-placeholder")).toBeTruthy();
    write("deal-query-failed");
    cleanup();
    quiet.mockRestore();
    stubs.throwStatus = false;

    // 9-11. Collections > Approvals by role.
    stubs.permissions = new Set(ACCOUNTANT);
    seedApprovals(false);
    await openApprovals();
    write("approvals-accountant-pilot");
    cleanup();

    stubs.permissions = new Set(MANAGER);
    seedApprovals(false);
    await openApprovals();
    write("approvals-manager-pilot");
    cleanup();

    stubs.permissions = new Set([...ACCOUNTANT, "approve:requests"]);
    seedApprovals(true);
    await openApprovals();
    fireEvent.change(screen.getByRole("textbox", { name: t("RetainedCreditPayoutReference") }),
      { target: { value: "TRX-20261012-01" } });
    // innerHTML carries attributes, not the live value property: mirror it so the paint shows it.
    screen.getByRole("textbox", { name: t("RetainedCreditPayoutReference") }).setAttribute("value", "TRX-20261012-01");
    write("approvals-both-open");
    cleanup();
  });
});
