/**
 * The settlement advice is scaled by the APPLICATION's currency, not the org's.
 *
 * `financeApplications.economicsCurrency` governs every `*Minor` field in the
 * dealer-side economics block — the approved purchase amount and the supplier
 * advice among them. `ApplicationDetailsDialog` referenced that field zero times
 * and used `useCurrency()` (the org's CURRENT currency) for both the figure it
 * displayed and the `disbursedAmountMinor` it wrote.
 *
 * The two are not always the same currency and `orgSettings` does not count
 * `financeApplications` among the rows that lock an org's, so a dealership can
 * pin a deal in JOD (scale 3) and later switch to USD (scale 2). Every deal
 * pinned before the switch then reads and writes at the wrong scale — off by a
 * factor of ten, silently, on the one record whose job is to state what the
 * finance company actually paid the supplier.
 *
 * A prefilled amount hides this completely: the prefill divides by the same
 * factor the submit multiplies by, so the two errors cancel and the round trip
 * looks correct. The operator does not use the prefill — they read the advice
 * document and type what it says. That is the path tested here.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Id } from "../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: () => true }),
}));

/** The ORG's currency. Two decimals — deliberately NOT the deal's. */
vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({ code: "USD", format: (n: number) => `$ ${n}` }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  mutationSpies: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      // Stable per function name, so the assertion can read what the component
      // actually sent rather than a fresh spy it never called.
      if (!stubs.mutationSpies.has(name)) {
        stubs.mutationSpies.set(name, vi.fn().mockResolvedValue(undefined));
      }
      return stubs.mutationSpies.get(name)!;
    },
  };
});

const { queryResults, mutationSpies } = stubs;

import { ApplicationDetailsDialog } from "./ApplicationDetailsDialog";

const APP_ID = "app1" as Id<"financeApplications">;

/** 17,450 JOD at scale 3 — what the finance company approved and paid. */
const APPROVED_MINOR_JOD = 17_450_000;

/**
 * A CLOSED consigned deal settled DIRECT, pinned to JOD while the org now
 * reports in USD. Everything else matches the shape `applications.get` returns.
 */
function jodPinnedDeal(overrides: Record<string, unknown> = {}) {
  return {
    _id: APP_ID,
    orgId: "org1",
    createdAt: Date.UTC(2026, 7, 1),
    status: "CLOSED",
    companyId: undefined,
    company: null,
    quoteModeAtSubmission: "MANUAL_FINANCE_COMPANY",
    manualFinanceSnapshot: { providerName: "Cairo Amman Finance" },
    hasExternalFinancier: true,
    canSettleDirectToSupplier: true,
    directRouteRefusal: null,
    supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
    // The deal's own currency. Three decimals; the org's has two.
    economicsCurrency: "JOD",
    approvedDealerPurchaseAmountMinor: APPROVED_MINOR_JOD,
    vehicle: { sourceType: "SOURCED", sourcedFromName: "Amman Importer Co" },
    customer: { firstName: "Buyer", lastName: "One" },
    salesperson: { name: "Seller" },
    quote: {
      downPayment: 3_000,
      termMonths: 48,
      monthlyInstallment: 400,
      vehiclePrice: 20_000,
      totalFinancedAmount: 17_000,
    },
    deposits: [],
    ...overrides,
  };
}

function renderDialog(app: unknown) {
  queryResults.set("applications:get", app);
  queryResults.set("documents:getForApplication", []);
  queryResults.set("applications:getLog", []);
  return render(
    <ApplicationDetailsDialog applicationId={APP_ID} open onOpenChange={() => {}} />
  );
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  mutationSpies.clear();
});

describe("a deal pinned to a currency the org no longer uses", () => {
  test("records the advice at the deal's scale, not the org's", () => {
    renderDialog(jodPinnedDeal());

    fireEvent.click(screen.getByRole("button", { name: /ConfirmSupplierDisbursement/ }));

    // The operator reads 17,450 off the settlement advice and types it. They do
    // not use the prefill, and the prefill would mask the defect anyway.
    fireEvent.change(screen.getByLabelText(/SupplierDisbursementAmount/), {
      target: { value: "17450" },
    });
    fireEvent.click(screen.getByRole("button", { name: /ConfirmRecorded/ }));

    const confirm = mutationSpies.get("applications:confirmSupplierDisbursement");
    expect(confirm).toBeDefined();
    expect(confirm).toHaveBeenCalledTimes(1);

    const sent = confirm!.mock.calls[0][0] as { disbursedAmountMinor: number };
    // 17,450 JOD at the DEAL's scale.
    expect(sent.disbursedAmountMinor).toBe(APPROVED_MINOR_JOD);
    // And specifically not 1,745,000 — the same amount at the ORG's scale, which
    // is what the org-currency factor produced. Stated separately so the failure
    // message names the defect rather than just a mismatched integer.
    expect(sent.disbursedAmountMinor).not.toBe(1_745_000);
  });

  test("shows the approved purchase amount at the deal's scale", () => {
    renderDialog(jodPinnedDeal());

    fireEvent.click(screen.getByRole("button", { name: /ConfirmSupplierDisbursement/ }));

    // 17,450,000 minor units read at the org's two decimals renders 174,500 —
    // ten times the real figure, on the line the operator checks the advice
    // against before typing. A wrong expectation invites a wrong entry.
    expect(screen.getByText(/\$ 17450($|[^0-9])/)).toBeTruthy();
    expect(screen.queryByText(/\$ 174500/)).toBeNull();
  });

  test("a deal with no pinned currency falls back to the org's, as the server does", () => {
    renderDialog(jodPinnedDeal({ economicsCurrency: undefined }));

    fireEvent.click(screen.getByRole("button", { name: /ConfirmSupplierDisbursement/ }));
    fireEvent.change(screen.getByLabelText(/SupplierDisbursementAmount/), {
      target: { value: "17450" },
    });
    fireEvent.click(screen.getByRole("button", { name: /ConfirmRecorded/ }));

    // Absent means the row predates the field, and the org's currency is then
    // the only reading available. The server falls back the same way, so the two
    // agree rather than each guessing separately.
    const sent = mutationSpies.get("applications:confirmSupplierDisbursement")!.mock
      .calls[0][0] as { disbursedAmountMinor: number };
    expect(sent.disbursedAmountMinor).toBe(1_745_000);
  });
});
