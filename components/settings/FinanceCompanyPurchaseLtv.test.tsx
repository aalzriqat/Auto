/**
 * The finance company's DEALER-side purchase LTV, which this form never asked for.
 *
 * `defaultLtvPercent` has a schema field and `finance.createCompany` has always
 * accepted it — the form simply omitted it, so every company created through the
 * product had none. Nothing caught it because the backend tests set the field
 * with `ctx.db.patch`, which is exactly the kind of fixture shortcut that hides
 * a missing screen.
 *
 * The consequence is not cosmetic. `resolveAppliedLtv` THROWS without it, so
 * `suggestQuotationForApplication` throws, and an uncaught throw from `useQuery`
 * during render took the entire deal cockpit down with a Convex stack trace —
 * found by rendering the real screen against a company created through this very
 * form.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mutations = vi.hoisted(() => ({
  create: vi.fn(async (_args: Record<string, unknown>) => "company_1"),
  update: vi.fn(async (_args: Record<string, unknown>) => null),
}));

vi.mock("convex/react", () => ({
  useMutation: (reference: { name?: string } | string) =>
    String(reference).includes("update") ? mutations.update : mutations.create,
  useQuery: () => [],
}));

vi.mock("@/convex/_generated/api", () => ({
  api: {
    finance: { createCompany: "finance:createCompany", updateCompany: "finance:updateCompany" },
    orgCustomerStatuses: { list: "orgCustomerStatuses:list" },
  },
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org_1" }),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, locale: "en", isRtl: false }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { FinanceCompanyDialog } from "./FinanceCompanyDialog";

afterEach(() => {
  cleanup();
  mutations.create.mockClear();
  mutations.update.mockClear();
});

/** `useMutation` is mocked by reference name, so the two are distinguishable. */
function renderDialog() {
  return render(<FinanceCompanyDialog open onOpenChange={() => {}} />);
}

describe("the dealer-side purchase LTV", () => {
  test("is offered by the form and sent on create", async () => {
    renderDialog();

    // The existing fields have no label association at all (this form predates
    // that convention), so the name is reached positionally. The new field is
    // reached BY ITS LABEL, which is the point: it was added with one.
    fireEvent.change(document.querySelectorAll("input")[0], {
      target: { value: "National Finance" },
    });
    fireEvent.change(screen.getByLabelText("DefaultDealerLtv"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mutations.create).toHaveBeenCalled());
    expect(mutations.create.mock.calls[0][0]).toMatchObject({ defaultLtvPercent: 90 });
  });

  test("cannot be silently cleared by emptying the field", async () => {
    render(
      <FinanceCompanyDialog
        open
        onOpenChange={() => {}}
        company={{
          _id: "company_1" as never,
          name: "National Finance",
          profitRate: 0,
          maxTermMonths: 72,
          gracePeriodMonths: 0,
          defaultLtvPercent: 90,
          isActive: true,
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("DefaultDealerLtv"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // `updateCompany` treats an omitted dealer rule as "leave it alone", so a
    // blank submission closed the dialog on a success toast while the old rate
    // stayed in force — and every later deal was quoted against a rule the
    // operator believed they had removed.
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(mutations.update).not.toHaveBeenCalled();
    expect(screen.getByText("DefaultDealerLtvCannotClear")).toBeTruthy();
  });

  test("is omitted rather than sent as zero when left blank", async () => {
    renderDialog();

    fireEvent.change(document.querySelectorAll("input")[0], { target: { value: "No LTV Co" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mutations.create).toHaveBeenCalled());
    // Zero is not "unset": `resolveAppliedLtv` refuses anything at or below it,
    // so a defaulted 0 would be an always-invalid rate stored on every company
    // whose rate nobody knows.
    expect(mutations.create.mock.calls[0][0].defaultLtvPercent).toBeUndefined();
  });
});
