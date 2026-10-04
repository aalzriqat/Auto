/**
 * SCRUM-628 F-11: the wizard's "New customer" form rendered English labels,
 * validation messages and toast inside the Arabic UI because it never asked the
 * translator for anything.
 *
 * The translator is the identity on the key, so an assertion names the string
 * the component asked for. The English values are pinned separately because the
 * E2E suites (which run in English) find this form by "First Name", "Last Name"
 * and "Create & Select".
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  toastSuccess: vi.fn(),
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: true, locale: "ar" }),
}));
vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: stubs.toastSuccess, error: vi.fn() } }));
vi.mock("convex/react", () => ({
  useMutation: () => async (args: Record<string, unknown>) => {
    stubs.created.push(args);
    return "customer1";
  },
}));

import { CustomerCreateForm } from "./CustomerCreateForm";
import { dictionaries } from "@/lib/i18n/dictionaries";

const { en, ar } = dictionaries;

function renderForm() {
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  render(<CustomerCreateForm paymentType="INSTALLMENT" onCancel={onCancel} onCreated={onCreated} />);
  return { onCreated, onCancel };
}

afterEach(() => {
  cleanup();
  stubs.created.length = 0;
  stubs.toastSuccess.mockClear();
});

describe("CustomerCreateForm — translated (SCRUM-628 F-11)", () => {
  test("every visible label is asked of the translator", () => {
    renderForm();
    for (const key of [
      "NewCustomerFormTitle",
      "Cancel",
      "FirstName",
      "LastName",
      "Phone",
      "NationalId",
      "Email",
      "Address",
      "CreateAndSelectCustomer",
    ]) {
      expect(screen.getAllByText(key).length, key).toBeGreaterThan(0);
    }
    expect(screen.queryByText(/New Customer|Create & Select|First Name/)).toBeNull();
  });

  test("validation messages are translated", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "not-an-email" } });
    // A submit event directly: a click would stop at the browser's own
    // type=email check, which is not the message under test.
    fireEvent.submit(screen.getByRole("button", { name: "CreateAndSelectCustomer" }).closest("form")!);

    await screen.findByText("CustomerFirstNameRequired");
    expect(screen.getByText("CustomerLastNameRequired")).toBeTruthy();
    expect(screen.getByText("CustomerEmailInvalid")).toBeTruthy();
    expect(stubs.created).toEqual([]);
  });

  test("the success toast is translated", async () => {
    const { onCreated } = renderForm();
    fireEvent.change(screen.getByLabelText(/^FirstName/), { target: { value: "QA" } });
    fireEvent.change(screen.getByLabelText(/^LastName/), { target: { value: "TEST" } });
    fireEvent.click(screen.getByRole("button", { name: "CreateAndSelectCustomer" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(stubs.toastSuccess).toHaveBeenCalledWith("CustomerCreatedSuccess");
  });
});

describe("CustomerCreateForm — strings the E2E suites bind to", () => {
  test("the English values stay exactly what the specs look for", () => {
    const enDict = en as Record<string, string>;
    expect(enDict.FirstName).toBe("First Name");
    expect(enDict.LastName).toBe("Last Name");
    expect(enDict.CreateAndSelectCustomer).toBe("Create & Select");
  });

  test("every new key has an Arabic value that is not the English one", () => {
    const enDict = en as Record<string, string>;
    const arDict = ar as Record<string, string>;
    for (const key of [
      "NewCustomerFormTitle",
      "CreateAndSelectCustomer",
      "CustomerCreatedSuccess",
      "CustomerFirstNameRequired",
      "CustomerLastNameRequired",
      "CustomerEmailInvalid",
    ]) {
      expect(arDict[key], key).toBeTruthy();
      expect(arDict[key], key).not.toBe(enDict[key]);
    }
  });
});
