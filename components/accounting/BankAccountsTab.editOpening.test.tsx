/**
 * SCRUM-945: the bank accounts screen wires the edit-opening dialog to `api.bankAccounts.update`.
 * A finance manager opens the dialog from a row, saves, and the mutation is called once with exactly the
 * organization, the bank and the exact minor-unit amount and date. Without manage:finance there is no edit
 * control and no dialog. The server stays the authority; this proves only the screen wiring.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";

const state = vi.hoisted(() => ({ canManage: true, mutations: new Map<string, ReturnType<typeof vi.fn>>() }));

vi.mock("convex/react", async () => {
  const { getFunctionName: nameOf } = await import("convex/server");
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      if (args === "skip") return undefined;
      const name = nameOf(ref);
      if (name === "bankAccounts:list") {
        return [
          {
            _id: "bank1",
            name: "Operating JOD",
            currency: "JOD",
            openingBalanceMinor: 1_234_567,
            openingBalanceDate: Date.UTC(2026, 0, 1),
            isActive: true,
            isReconciliationTarget: false,
          },
        ];
      }
      return undefined;
    },
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = nameOf(ref);
      if (!state.mutations.has(name)) state.mutations.set(name, vi.fn().mockResolvedValue(null));
      return state.mutations.get(name);
    },
  };
});

vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries: dicts } = await import("@/lib/i18n/dictionaries");
  return {
    useLanguage: () => ({
      locale: "en",
      isRtl: false,
      t: (key: string) => (dicts as Record<string, Record<string, string>>).en[key] ?? key,
    }),
  };
});
vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org1" }) }));
vi.mock("@/hooks/useOrgSettings", () => ({ useOrgSettings: () => ({ currency: "JOD", currencySymbol: "JOD" }) }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ hasPermission: () => state.canManage, isLoading: false }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./bankAccounts/ReconciliationPanel", () => ({ ReconciliationPanel: () => null }));

import { BankAccountsTab } from "./BankAccountsTab";

afterEach(() => {
  cleanup();
  state.canManage = true;
  state.mutations.clear();
});

const EDIT = "Edit opening balance";

describe("BankAccountsTab edit stated opening wiring", () => {
  test("a finance manager saves the dialog and bankAccounts.update gets exactly the org, bank, minor amount and date", async () => {
    render(<BankAccountsTab />);
    fireEvent.click(screen.getByRole("button", { name: EDIT }));

    fireEvent.change(screen.getByLabelText("Stated opening balance"), { target: { value: "4000.000" } });
    fireEvent.change(screen.getByLabelText("Opening Balance Date"), { target: { value: "2026-03-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const update = state.mutations.get("bankAccounts:update");
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith({
      orgId: "org1",
      bankAccountId: "bank1",
      openingBalanceMinor: 4_000_000,
      openingBalanceDate: Date.UTC(2026, 2, 15),
    });
    // The dialog closes after a successful save.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("a user without manage:finance gets no edit button and no dialog", () => {
    state.canManage = false;
    render(<BankAccountsTab />);

    expect(screen.queryByRole("button", { name: EDIT })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.mutations.get("bankAccounts:update")).not.toHaveBeenCalled();
  });
});
