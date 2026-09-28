/**
 * SCRUM-428: the finance company's first-payment offset rule, which this form
 * never asked for.
 *
 * `customerFirstPaymentOffsetsUnfinancedShare` has a schema field and both
 * company mutations have always accepted it, but no screen could set it. The
 * quotation solver refuses to guess it (OFFSET_RULE_UNKNOWN), so every company
 * created through the product left every quote uncalculated — which is what
 * held the Trusted Main E2E, and with it the production deploy, red.
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

const RULE = "FirstPaymentOffsetRule";

function existing(rule: boolean | undefined) {
  return {
    _id: "company_1" as never,
    name: "National Finance",
    profitRate: 0,
    maxTermMonths: 72,
    gracePeriodMonths: 0,
    isActive: true,
    customerFirstPaymentOffsetsUnfinancedShare: rule,
  };
}

function ruleSelect() {
  return screen.getByLabelText(RULE) as HTMLSelectElement;
}

function optionValues() {
  return Array.from(ruleSelect().options).map((option) => option.value);
}

async function createWith(choice?: "yes" | "no") {
  render(<FinanceCompanyDialog open onOpenChange={() => {}} />);
  fireEvent.change(document.querySelectorAll("input")[0], { target: { value: "National Finance" } });
  if (choice) fireEvent.change(ruleSelect(), { target: { value: choice } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(mutations.create).toHaveBeenCalled());
  return mutations.create.mock.calls[0][0];
}

describe("the first-payment offset rule", () => {
  test("is offered by the form, by its label, and starts not confirmed on a new company", () => {
    render(<FinanceCompanyDialog open onOpenChange={() => {}} />);
    expect(ruleSelect().value).toBe("");
    expect(optionValues()).toEqual(["", "yes", "no"]);
  });

  test("is omitted, not sent as false, when left not confirmed", async () => {
    // false is a real answer (the rule does not apply); unset means nobody has
    // asked the company. Defaulting one into the other is the defect class.
    const args = await createWith();
    expect(args.customerFirstPaymentOffsetsUnfinancedShare).toBeUndefined();
  });

  test("sends true for Yes and false for No on create", async () => {
    expect((await createWith("yes")).customerFirstPaymentOffsetsUnfinancedShare).toBe(true);
    cleanup();
    mutations.create.mockClear();
    expect((await createWith("no")).customerFirstPaymentOffsetsUnfinancedShare).toBe(false);
  });

  test("shows a stored answer, and does not offer to unset it", () => {
    // updateCompany reads an omitted rule as "leave it alone", so offering
    // "Not confirmed" here would save as a success while the old rule stayed.
    render(<FinanceCompanyDialog open onOpenChange={() => {}} company={existing(false)} />);
    expect(ruleSelect().value).toBe("no");
    expect(optionValues()).toEqual(["yes", "no"]);
  });

  test("a rule saved elsewhere while the dialog is open never makes it display an answer it will not send", () => {
    const { rerender } = render(
      <FinanceCompanyDialog open onOpenChange={() => {}} company={existing(undefined)} />
    );
    // Same company, reactive prop update: the form keeps what it opened with.
    rerender(<FinanceCompanyDialog open onOpenChange={() => {}} company={existing(true)} />);
    expect(ruleSelect().value).toBe("");
    expect(optionValues()).toEqual(["", "yes", "no"]);
  });

  test("can be confirmed on an existing company that never had it", async () => {
    render(<FinanceCompanyDialog open onOpenChange={() => {}} company={existing(undefined)} />);
    expect(ruleSelect().value).toBe("");
    fireEvent.change(ruleSelect(), { target: { value: "yes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    expect(mutations.update.mock.calls[0][0]).toMatchObject({
      id: "company_1",
      customerFirstPaymentOffsetsUnfinancedShare: true,
    });
  });

  test("an existing company left unconfirmed saves without the rule", async () => {
    render(<FinanceCompanyDialog open onOpenChange={() => {}} company={existing(undefined)} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutations.update).toHaveBeenCalled());
    expect(mutations.update.mock.calls[0][0].customerFirstPaymentOffsetsUnfinancedShare).toBeUndefined();
  });
});
