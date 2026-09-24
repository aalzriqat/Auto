/**
 * Verification of the retirement of company fee templates in favor of
 * company `adminFees` (Execution Fees / مصاريف التنفيذ) as the single
 * authoritative expected fee figure.
 *
 * Old business rule:
 * - Finance company dialog rendered a complex `fee-templates-section` where operators
 *   configured itemized fee templates (lien, insurance, evaluation, etc.).
 *
 * Why obsolete:
 * - Fee templates policy created duplicate, conflicting authorities for expected
 *   dealer-borne fees alongside company `adminFees` (Execution Fees).
 * - PR unified deal execution fees under `financeCompanies.adminFees`.
 *
 * New invariant:
 * - The company dialog does NOT render the duplicate `fee-templates-section`.
 * - The dialog configures `adminFees` ("Execution Fees") as the single fee authority.
 * - Submissions carry `adminFees` and do not submit `feeTemplates`.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

function renderEdit(adminFees?: number) {
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
        isActive: true,
      }}
    />
  );
}

function renderCreate() {
  return render(<FinanceCompanyDialog open onOpenChange={() => {}} />);
}

function save() {
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
}

describe("fee templates retirement in FinanceCompanyDialog", () => {
  test("does NOT render fee-templates-section or fee template controls", () => {
    renderEdit(700);
    expect(screen.queryByTestId("fee-templates-section")).toBeNull();
    expect(screen.queryByText("FeeTemplateType")).toBeNull();
  });

  test("renders Execution Fees (adminFees) as the single configured fee field", () => {
    renderEdit(700);
    const adminFeesInput = screen.getByLabelText("ExecutionFees") as HTMLInputElement;
    expect(adminFeesInput).toBeTruthy();
    expect(adminFeesInput.value).toBe("700");
  });

  test("keeps the revision from the opened form snapshot when the reactive company prop advances", async () => {
    const initialCompany = {
      _id: "company_1" as never,
      name: "National Finance",
      profitRate: 4.5,
      maxTermMonths: 72,
      gracePeriodMonths: 0,
      adminFees: 700,
      defaultLtvPercent: 90,
      isActive: true,
      editRevision: 3,
    };
    const view = render(
      <FinanceCompanyDialog open onOpenChange={() => {}} company={initialCompany} />
    );

    fireEvent.change(screen.getByLabelText("Company Name"), {
      target: { value: "My stale local edit" },
    });

    // Simulate Convex pushing another editor's committed version while this
    // dialog remains open. The form intentionally stays untouched, therefore
    // its CAS token must stay untouched too.
    view.rerender(
      <FinanceCompanyDialog
        open
        onOpenChange={() => {}}
        company={{
          ...initialCompany,
          name: "Other editor's committed name",
          adminFees: 900,
          editRevision: 4,
        }}
      />
    );

    expect((screen.getByLabelText("Company Name") as HTMLInputElement).value)
      .toBe("My stale local edit");

    save();

    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    const payload = mutations.update.mock.calls[0][0];
    expect(payload.expectedEditRevision).toBe(3);
    expect(payload.name).toBe("My stale local edit");
    expect(payload.adminFees).toBe(700);
  });

  test("saving edit sends adminFees and omits feeTemplates", async () => {
    renderEdit(700);
    fireEvent.change(screen.getByLabelText("ExecutionFees"), { target: { value: "750" } });
    save();

    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    const payload = mutations.update.mock.calls[0][0];
    expect(payload.adminFees).toBe(750);
    expect(payload.expectedEditRevision).toBe(1);
    expect(payload.feeTemplates).toBeUndefined();
  });

  test("saving edit with unset adminFees preserves adminFees as undefined", async () => {
    renderEdit(undefined);
    fireEvent.change(screen.getByLabelText("Company Name"), { target: { value: "Updated Name" } });
    save();

    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    const payload = mutations.update.mock.calls[0][0];
    expect(payload.name).toBe("Updated Name");
    expect(payload.adminFees).toBeUndefined();
    expect(payload.feeTemplates).toBeUndefined();
  });

  test("saving edit with explicit 0 sends adminFees as 0", async () => {
    renderEdit(undefined);
    fireEvent.change(screen.getByLabelText("ExecutionFees"), { target: { value: "0" } });
    save();

    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    const payload = mutations.update.mock.calls[0][0];
    expect(payload.adminFees).toBe(0);
  });

  test("saving new company sends adminFees and omits feeTemplates", async () => {
    renderCreate();
    fireEvent.change(screen.getByLabelText("Company Name"), { target: { value: "New Finance Co" } });
    fireEvent.change(screen.getByLabelText("ExecutionFees"), { target: { value: "600" } });
    save();

    await waitFor(() => expect(mutations.create).toHaveBeenCalled());
    const payload = mutations.create.mock.calls[0][0];
    expect(payload.name).toBe("New Finance Co");
    expect(payload.adminFees).toBe(600);
    expect(payload.feeTemplates).toBeUndefined();
  });

  test("clearing an existing adminFees value is rejected with error toast and does not submit", async () => {
    renderEdit(700);
    fireEvent.change(screen.getByLabelText("ExecutionFees"), { target: { value: "" } });
    expect(screen.getByText("ExecutionFeesCannotClear")).toBeTruthy();
    save();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("ExecutionFeesCannotClear"));
    expect(mutations.update).not.toHaveBeenCalled();
  });
});
