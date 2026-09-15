/**
 * The finance company's expected handover costs (fee templates) in the
 * settings dialog.
 *
 * `finance.createCompany` / `updateCompany` have accepted `feeTemplates` since
 * the Unified Deal started freezing them onto each application, and this form
 * never asked — so every company configured through the product had none and
 * every deal's handover checklist started empty. These tests hold the form to
 * the contract the mutations rely on: an untouched list is OMITTED (the server
 * reads an omitted rule as "leave it alone"), an edited list is sent whole,
 * amounts are scaled at the ORG currency, and nothing is ever dropped quietly.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MAX_FEE_TEMPLATES } from "@/convex/utils/dealCostLimits";
import type { FinanceFeeTemplate } from "@/lib/financeFeeTemplateForm";

const mutations = vi.hoisted(() => ({
  create: vi.fn(async (args: Record<string, unknown>) => {
    void args;
    return "company_1";
  }),
  update: vi.fn(async (args: Record<string, unknown>) => {
    void args;
    return null;
  }),
}));

/** What `orgSettings.get` answers: `undefined` is "still loading", `null` is "no row". */
const orgSettings = vi.hoisted(() => ({ current: { currency: "JOD" } as { currency: string } | null | undefined }));

vi.mock("convex/react", () => ({
  useMutation: (reference: string) => (reference.includes("update") ? mutations.update : mutations.create),
  useQuery: (reference: string) => (reference.includes("orgSettings") ? orgSettings.current : []),
}));

vi.mock("@/convex/_generated/api", () => ({
  api: {
    finance: { createCompany: "finance:createCompany", updateCompany: "finance:updateCompany" },
    orgCustomerStatuses: { list: "orgCustomerStatuses:list" },
    orgSettings: { get: "orgSettings:get" },
  },
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org_1" }),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, locale: "en", isRtl: false }),
}));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", () => ({ toast }));

import { FinanceCompanyDialog } from "./FinanceCompanyDialog";

afterEach(() => {
  cleanup();
  mutations.create.mockClear();
  mutations.update.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
  orgSettings.current = { currency: "JOD" };
});

const lien: FinanceFeeTemplate = {
  feeType: "LIEN_REGISTRATION",
  description: "Traffic department lien",
  estimatedAmountMinor: 37_500,
  paidBy: "CUSTOMER",
  paidTo: "GOVERNMENT",
  includedInQuotation: true,
  deductedFromSettlement: false,
  refundable: true,
  accountingTreatment: "CUSTOMER_RECEIVABLE",
};

const insurance: FinanceFeeTemplate = {
  feeType: "INSURANCE",
  estimatedAmountMinor: 250_000,
  paidBy: "DEALER",
  paidTo: "INSURER",
  includedInQuotation: false,
  deductedFromSettlement: true,
  refundable: false,
  accountingTreatment: "INSURANCE_EXPENSE",
};

function renderEdit(feeTemplates: FinanceFeeTemplate[] | undefined, adminFees?: number) {
  return render(
    <FinanceCompanyDialog
      open
      onOpenChange={() => {}}
      company={{
        _id: "company_1" as never,
        name: "National Finance",
        profitRate: 4.5,
        maxTermMonths: 72,
        gracePeriodMonths: 0,
        adminFees,
        defaultLtvPercent: 90,
        ruleVersion: 7,
        isActive: true,
        feeTemplates,
      }}
    />
  );
}

function renderCreate() {
  return render(<FinanceCompanyDialog open onOpenChange={() => {}} />);
}

function feeRows() {
  return within(screen.getByTestId("fee-templates-section")).queryAllByRole("listitem");
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

/** The `feeTemplates` argument of the first recorded call, typed as the validator shape. */
function sentTemplates(mutation: typeof mutations.create | typeof mutations.update): FinanceFeeTemplate[] {
  return mutation.mock.calls[0][0].feeTemplates as FinanceFeeTemplate[];
}

describe("edit load", () => {
  test("renders every stored template with its amount in major units and its fields intact", () => {
    renderEdit([lien, insurance]);

    const rows = feeRows();
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId("fee-templates-count").textContent).toBe("FeeTemplateCount");

    const [first, second] = rows;
    expect((within(first).getByLabelText("FeeTemplateType") as HTMLSelectElement).value).toBe("LIEN_REGISTRATION");
    expect((within(first).getByLabelText("FeeTemplateEstimatedAmount") as HTMLInputElement).value).toBe("37.5");
    expect((within(first).getByLabelText("FeeTemplateDescription") as HTMLInputElement).value).toBe(
      "Traffic department lien"
    );
    expect((within(second).getByLabelText("FeeTemplateEstimatedAmount") as HTMLInputElement).value).toBe("250");
    expect((within(second).getByLabelText("FeeTemplateDescription") as HTMLInputElement).value).toBe("");

    // The accounting fields are behind a disclosure, loaded, not defaulted.
    fireEvent.click(within(first).getByRole("button", { name: "FeeTemplateAccountingDetails" }));
    expect((within(first).getByLabelText("FeeTemplatePaidBy") as HTMLSelectElement).value).toBe("CUSTOMER");
    expect((within(first).getByLabelText("FeeTemplatePaidTo") as HTMLSelectElement).value).toBe("GOVERNMENT");
    expect((within(first).getByLabelText("CostTreatmentLabel") as HTMLSelectElement).value).toBe(
      "CUSTOMER_RECEIVABLE"
    );
    expect((within(first).getByLabelText("FeeTemplateIncludedInQuotation") as HTMLInputElement).checked).toBe(true);
    expect((within(first).getByLabelText("FeeTemplateDeductedFromSettlement") as HTMLInputElement).checked).toBe(
      false
    );
    expect((within(first).getByLabelText("FeeTemplateRefundable") as HTMLInputElement).checked).toBe(true);
  });

  test("a company with no templates shows the empty state, not a phantom row", () => {
    renderEdit(undefined);
    expect(feeRows()).toHaveLength(0);
    expect(screen.getByText("FeeTemplatesEmpty")).toBeTruthy();
  });
});

describe("no silent loss", () => {
  test("saving without touching the list OMITS feeTemplates, so the server keeps the stored ones verbatim", async () => {
    renderEdit([lien, insurance]);

    fireEvent.change(document.querySelectorAll("input")[0], { target: { value: "National Finance Co" } });
    save();

    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    const payload = mutations.update.mock.calls[0][0];
    expect(payload.name).toBe("National Finance Co");
    // Present-as-undefined is the contract: `updateCompany` only writes a
    // dealer rule the caller sent, and the legacy dialog and mobile client
    // never send this one — an unconditional `[]` here would have wiped
    // every company's policy on its next rename.
    expect(payload.feeTemplates).toBeUndefined();
  });

  test("an edited list is sent WHOLE: the untouched sibling row is carried byte-identical", async () => {
    renderEdit([lien, insurance]);

    const [, second] = feeRows();
    fireEvent.change(within(second).getByLabelText("FeeTemplateEstimatedAmount"), { target: { value: "275" } });
    save();

    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    expect(mutations.update.mock.calls[0][0].feeTemplates).toEqual([
      lien,
      { ...insurance, estimatedAmountMinor: 275_000 },
    ]);
    expect(mutations.update.mock.calls[0][0]).toMatchObject({
      expectedCurrency: "JOD",
      expectedRuleVersion: 7,
    });
  });

  test("a row with an unusable amount blocks the save instead of vanishing from the payload", async () => {
    renderEdit([lien]);

    fireEvent.click(screen.getByRole("button", { name: "FeeTemplateAdd" }));
    const [, added] = feeRows();
    fireEvent.change(within(added).getByLabelText("FeeTemplateEstimatedAmount"), { target: { value: "1.2345" } });
    save();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("FeeTemplatesFixBeforeSave"));
    expect(mutations.update).not.toHaveBeenCalled();
    expect(within(added).getByRole("alert").textContent).toBe("FeeTemplateAmountTooPrecise");
    expect(within(added).getByLabelText("FeeTemplateEstimatedAmount").getAttribute("aria-invalid")).toBe("true");
  });

  test("a blank amount on a new row is a refusal, never a silent zero", async () => {
    renderEdit([lien]);

    fireEvent.click(screen.getByRole("button", { name: "FeeTemplateAdd" }));
    save();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("FeeTemplatesFixBeforeSave"));
    expect(mutations.update).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("FeeTemplateAmountEmpty");
  });
});

describe("creation and update payload conversion", () => {
  test("a new company sends the added template with exact minor units and explicit defaults", async () => {
    renderCreate();

    fireEvent.change(document.querySelectorAll("input")[0], { target: { value: "New Finance" } });
    fireEvent.change(screen.getByLabelText("DefaultDealerLtv"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "FeeTemplateAdd" }));

    const [row] = feeRows();
    fireEvent.change(within(row).getByLabelText("FeeTemplateType"), { target: { value: "INSURANCE" } });
    fireEvent.change(within(row).getByLabelText("FeeTemplateEstimatedAmount"), { target: { value: "12.505" } });
    fireEvent.change(within(row).getByLabelText("FeeTemplateDescription"), { target: { value: "Comprehensive" } });
    save();

    await waitFor(() => expect(mutations.create).toHaveBeenCalled());
    expect(mutations.create.mock.calls[0][0].feeTemplates).toEqual([
      {
        feeType: "INSURANCE",
        description: "Comprehensive",
        // 12.505 JOD = 12,505 fils — by string scaling, not 12.505 * 1000.
        estimatedAmountMinor: 12_505,
        paidBy: "DEALER",
        // Re-derived for the chosen type, and shown under the disclosure.
        paidTo: "INSURER",
        accountingTreatment: "INSURANCE_EXPENSE",
        includedInQuotation: false,
        deductedFromSettlement: false,
        refundable: false,
      },
    ]);
    expect(mutations.create.mock.calls[0][0].expectedCurrency).toBe("JOD");
  });

  test("scales at the ORG currency: the same figure is cents for a USD org", async () => {
    orgSettings.current = { currency: "USD" };
    renderCreate();

    fireEvent.change(document.querySelectorAll("input")[0], { target: { value: "Dollar Finance" } });
    fireEvent.click(screen.getByRole("button", { name: "FeeTemplateAdd" }));
    fireEvent.change(within(feeRows()[0]).getByLabelText("FeeTemplateEstimatedAmount"), {
      target: { value: "12.5" },
    });
    save();

    await waitFor(() => expect(mutations.create).toHaveBeenCalled());
    expect(sentTemplates(mutations.create)[0].estimatedAmountMinor).toBe(1_250);
  });

  test("cannot save while the org currency is still loading, so no amount is scaled by a guess", () => {
    orgSettings.current = undefined;
    renderCreate();

    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "FeeTemplateAdd" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("FeeTemplatesCurrencyLoading")).toBeTruthy();
  });

  test("an unsupported legacy currency refuses fee editing instead of using the scale-2 fallback", () => {
    orgSettings.current = { currency: "JD" };
    renderCreate();

    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "FeeTemplateAdd" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("FeeTemplatesCurrencyUnsupported")).toBeTruthy();
  });

  test("the advanced accounting fields are sent as chosen", async () => {
    renderCreate();

    fireEvent.change(document.querySelectorAll("input")[0], { target: { value: "New Finance" } });
    fireEvent.click(screen.getByRole("button", { name: "FeeTemplateAdd" }));
    const [row] = feeRows();
    fireEvent.change(within(row).getByLabelText("FeeTemplateEstimatedAmount"), { target: { value: "5" } });
    fireEvent.click(within(row).getByRole("button", { name: "FeeTemplateAccountingDetails" }));
    fireEvent.change(within(row).getByLabelText("FeeTemplatePaidBy"), { target: { value: "CUSTOMER" } });
    fireEvent.change(within(row).getByLabelText("FeeTemplatePaidTo"), { target: { value: "OTHER" } });
    fireEvent.change(within(row).getByLabelText("CostTreatmentLabel"), { target: { value: "CUSTOMER_RECEIVABLE" } });
    fireEvent.click(within(row).getByLabelText("FeeTemplateIncludedInQuotation"));
    fireEvent.click(within(row).getByLabelText("FeeTemplateDeductedFromSettlement"));
    fireEvent.click(within(row).getByLabelText("FeeTemplateRefundable"));
    save();

    await waitFor(() => expect(mutations.create).toHaveBeenCalled());
    expect(sentTemplates(mutations.create)[0]).toMatchObject({
      estimatedAmountMinor: 5_000,
      paidBy: "CUSTOMER",
      paidTo: "OTHER",
      accountingTreatment: "CUSTOMER_RECEIVABLE",
      includedInQuotation: true,
      deductedFromSettlement: true,
      refundable: true,
    });
  });

  test("legacy Execution Fees stay a separate figure — never migrated into, or inferred from, the templates", async () => {
    renderEdit([lien], 150);

    // Touch the list so it IS sent, then confirm the legacy amount rides
    // alongside untouched and no template was manufactured from it.
    fireEvent.click(screen.getByRole("button", { name: "FeeTemplateAdd" }));
    const [, added] = feeRows();
    fireEvent.change(within(added).getByLabelText("FeeTemplateEstimatedAmount"), { target: { value: "20" } });
    save();

    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    const payload = mutations.update.mock.calls[0][0];
    expect(payload.adminFees).toBe(150);
    expect(sentTemplates(mutations.update)).toHaveLength(2);
    expect(sentTemplates(mutations.update)[0]).toEqual(lien);
    expect(sentTemplates(mutations.update).some((template) => template.estimatedAmountMinor === 150_000)).toBe(
      false
    );
  });
});

describe("add and remove", () => {
  test("each remove button has a unique accessible name", () => {
    renderEdit([insurance, insurance]);

    const names = feeRows().map((row) =>
      within(row).getByRole("button", { name: /FeeTemplateRemove/ }).getAttribute("aria-label")
    );
    expect(new Set(names).size).toBe(2);
  });

  test("removing a row sends the remaining list, and removing the last one sends an empty list", async () => {
    renderEdit([lien, insurance]);

    fireEvent.click(within(feeRows()[0]).getByRole("button", { name: /FeeTemplateRemove 1:/ }));
    expect(feeRows()).toHaveLength(1);
    save();

    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    expect(mutations.update.mock.calls[0][0].feeTemplates).toEqual([insurance]);

    mutations.update.mockClear();
    fireEvent.click(within(feeRows()[0]).getByRole("button", { name: /FeeTemplateRemove 1:/ }));
    expect(feeRows()).toHaveLength(0);
    save();

    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    // `[]`, not `undefined`: an emptied list must reach the server as "no
    // expected costs", which `args.feeTemplates ?? existing.feeTemplates`
    // applies — an omitted one would silently keep both templates.
    expect(mutations.update.mock.calls[0][0].feeTemplates).toEqual([]);
  });

  test("adding a row on an untouched company marks the list as edited", async () => {
    renderEdit([lien]);

    fireEvent.click(screen.getByRole("button", { name: "FeeTemplateAdd" }));
    fireEvent.change(within(feeRows()[1]).getByLabelText("FeeTemplateEstimatedAmount"), {
      target: { value: "8.25" },
    });
    save();

    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    const sent = sentTemplates(mutations.update);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(lien);
    expect(sent[1]).toMatchObject({ feeType: "OWNERSHIP_TRANSFER", estimatedAmountMinor: 8_250 });
  });
});

describe("the configuration limit", () => {
  // A hundred rows of native selects is slow to mount in jsdom — that IS the
  // shape of a company at the cap, so the budget is raised rather than the case
  // shrunk.
  const SLOW = 90_000;
  const atLimit = Array.from({ length: MAX_FEE_TEMPLATES }, (_, i) => ({
    ...insurance,
    description: `fee ${i}`,
  }));

  test("Add is disabled at MAX_FEE_TEMPLATES and the limit is named", () => {
    renderEdit(atLimit);

    expect(feeRows()).toHaveLength(MAX_FEE_TEMPLATES);
    expect((screen.getByRole("button", { name: "FeeTemplateAdd" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("FeeTemplatesLimitReached")).toBeTruthy();
  }, SLOW);

  test("a company already past the cap is still editable while the list is left alone, and repaired by a compliant edit", async () => {
    renderEdit([...atLimit, lien, insurance]);

    expect(screen.getByRole("alert").textContent).toBe("FeeTemplatesOverLimit");

    // Untouched: omitted, carried verbatim by the server (its own rule).
    fireEvent.change(document.querySelectorAll("input")[0], { target: { value: "Renamed" } });
    save();
    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    expect(mutations.update.mock.calls[0][0].feeTemplates).toBeUndefined();
    mutations.update.mockClear();

    // Touched but still over: refused here, exactly as the server would.
    fireEvent.click(within(feeRows()[0]).getByRole("button", { name: /FeeTemplateRemove 1:/ }));
    expect(screen.getByRole("alert").textContent).toBe("FeeTemplatesOverLimit");
    save();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("FeeTemplatesOverLimit"));
    expect(mutations.update).not.toHaveBeenCalled();

    // Down to the cap: sent, and accepted.
    fireEvent.click(within(feeRows()[0]).getByRole("button", { name: /FeeTemplateRemove 1:/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    save();
    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    expect(mutations.update.mock.calls[0][0].feeTemplates).toHaveLength(MAX_FEE_TEMPLATES);
  }, SLOW);
});
