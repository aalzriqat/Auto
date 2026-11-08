import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { ChartOfAccountsManagement } from "./ChartOfAccountsManagement";

const fixture = vi.hoisted(() => ({
  accounts: undefined as Doc<"chartOfAccounts">[] | undefined,
  queryError: null as Error | null,
  permissions: ["view:finance", "manage:finance"],
  loadingPermissions: false,
  create: vi.fn(),
  update: vi.fn(),
  query: vi.fn(),
}));

// Convex subscriptions and mutations are the browser/server boundary. The real
// provider, table, dialog, fields and switches render below it.
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: never, args: unknown) => {
      fixture.query(getFunctionName(ref), args);
      if (fixture.queryError) throw fixture.queryError;
      return fixture.accounts;
    },
    useMutation: (ref: never) => {
      switch (getFunctionName(ref)) {
        case "chartOfAccounts:create":
          return fixture.create;
        case "chartOfAccounts:update":
          return fixture.update;
        default:
          throw new Error(`Unexpected mutation ${getFunctionName(ref)}`);
      }
    },
  };
});
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    isLoading: fixture.loadingPermissions,
    hasPermission: (permission: string) =>
      fixture.permissions.includes(permission),
  }),
}));
vi.mock("@/components/ui/sonner", () => ({ toast: { success: vi.fn() } }));

const orgId = "org-a" as Id<"organizations">;
function account(active = true): Doc<"chartOfAccounts"> {
  return {
    _id: "account-a" as Id<"chartOfAccounts">,
    _creationTime: 1,
    orgId,
    code: "2500",
    name: "Partner Payables",
    nameAr: "ذمم الشركاء",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    active,
    isControlAccount: false,
    allowManualPosting: true,
    createdAt: 1,
    updatedAt: 1,
    createdBy: "user-a" as Id<"users">,
    updatedBy: "user-a" as Id<"users">,
  };
}
function show(locale: "en" | "ar" = "en") {
  localStorage.setItem("autoflow-locale", locale);
  return render(
    <LanguageProvider>
      <ChartOfAccountsManagement orgId={orgId} />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  fixture.accounts = [account()];
  fixture.queryError = null;
  fixture.permissions = ["view:finance", "manage:finance"];
  fixture.loadingPermissions = false;
  fixture.create.mockReset().mockResolvedValue("created-account");
  fixture.update.mockReset().mockResolvedValue("account-a");
  fixture.query.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(["en", "ar"] as const)(
  "%s labels and isolated account codes render with the locale direction",
  (locale) => {
    const { container } = show(locale);
    const copy = dictionaries[locale];
    const table = screen.getByRole("table", { name: copy.CoaTitle });
    for (const label of [
      copy.CoaCode,
      copy.CoaName,
      copy.CoaType,
      copy.CoaNormalBalance,
      copy.CoaState,
    ]) {
      expect(
        within(table).getByRole("columnheader", { name: label }).className,
      ).toContain("text-start");
    }
    expect(within(table).getByText(copy.CoaType_LIABILITY)).toBeTruthy();
    expect(within(table).getByText(copy.CoaBalance_CREDIT)).toBeTruthy();
    const code = within(table).getByText("2500");
    expect(code.tagName).toBe("BDI");
    expect(code.getAttribute("dir")).toBe("ltr");
    expect(container.firstElementChild?.getAttribute("dir")).toBe(
      locale === "ar" ? "rtl" : "ltr",
    );
    fireEvent.click(
      screen.getByRole("button", { name: `${copy.CoaEdit} 2500` }),
    );
    const dialog = screen.getByRole("dialog", { name: copy.CoaEdit });
    expect(within(dialog).getByLabelText(copy.CoaNameEn)).toBeTruthy();
    expect(within(dialog).getByLabelText(copy.CoaNameAr)).toBeTruthy();
    expect(dialog.getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
    expect(
      (within(dialog).getByLabelText(copy.CoaCode) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        within(dialog).getByRole("combobox", {
          name: copy.CoaType,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        within(dialog).getByRole("combobox", {
          name: copy.CoaNormalBalance,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  },
);

test.each(["en", "ar"] as const)(
  "%s supports empty, loading and refused permission states without unauthorized subscriptions",
  (locale) => {
    fixture.accounts = undefined;
    const view = show(locale);
    const copy = dictionaries[locale];
    expect(screen.getByRole("status", { name: copy.Loading })).toBeTruthy();
    fixture.accounts = [];
    view.rerender(
      <LanguageProvider>
        <ChartOfAccountsManagement orgId={orgId} />
      </LanguageProvider>,
    );
    expect(screen.getByText(copy.CoaEmpty)).toBeTruthy();
    fixture.permissions = [];
    fixture.query.mockClear();
    view.rerender(
      <LanguageProvider>
        <ChartOfAccountsManagement orgId={orgId} />
      </LanguageProvider>,
    );
    expect(screen.getByText(copy.CoaReadDenied)).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.CoaCreate })).toBeNull();
    expect(fixture.query).not.toHaveBeenCalled();
  },
);

test("unresolved permissions make no chart subscription and read-only finance has no write actions", () => {
  fixture.loadingPermissions = true;
  const view = show();
  expect(fixture.query).not.toHaveBeenCalled();
  fixture.loadingPermissions = false;
  fixture.permissions = ["view:finance"];
  view.rerender(
    <LanguageProvider>
      <ChartOfAccountsManagement orgId={orgId} />
    </LanguageProvider>,
  );
  expect(screen.getByText(dictionaries.en.CoaReadOnly)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

test.each(["en", "ar"] as const)(
  "%s query failures show a local error without leaking technical details",
  (locale) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.queryError = new Error("private schema /convex/secret.ts:33");
    show(locale);
    expect(screen.getByRole("alert").textContent).toBe(
      dictionaries[locale].CoaLoadError,
    );
    expect(screen.queryByText(/private schema/)).toBeNull();
  },
);

test.each([true, false])(
  "edits names and changes active=%s through the existing update API",
  async (initialActive) => {
    fixture.accounts = [account(initialActive)];
    show();
    fireEvent.click(screen.getByRole("button", { name: "Edit account 2500" }));
    fireEvent.change(screen.getByLabelText("Name (English)"), {
      target: { value: "Updated Payables" },
    });
    fireEvent.change(screen.getByLabelText("Name (Arabic)"), {
      target: { value: "ذمم معدلة" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Active" }));
    fireEvent.click(screen.getByRole("button", { name: "Save account" }));
    await waitFor(() =>
      expect(fixture.update).toHaveBeenCalledWith({
        orgId,
        accountId: "account-a",
        name: "Updated Payables",
        nameAr: "ذمم معدلة",
        active: !initialActive,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fixture.create).not.toHaveBeenCalled();
  },
);

test("system account deactivation is unavailable and losing write permission closes the editor", () => {
  fixture.accounts = [
    { ...account(), systemKey: "ACCOUNTS_PAYABLE_SUPPLIERS" },
  ];
  const view = show();
  fireEvent.click(screen.getByRole("button", { name: "Edit account 2500" }));
  expect(
    (screen.getByRole("switch", { name: "Active" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(dictionaries.en.CoaSystemActive)).toBeTruthy();
  fixture.permissions = ["view:finance"];
  view.rerender(
    <LanguageProvider>
      <ChartOfAccountsManagement orgId={orgId} />
    </LanguageProvider>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

test.each(["en", "ar"] as const)(
  "%s create uses the existing API and localizes duplicate-code refusals",
  async (locale) => {
    fixture.create.mockRejectedValue(
      new ConvexError({
        code: "ACCOUNT_CODE_EXISTS",
        message: "English technical text",
      }),
    );
    show(locale);
    const copy = dictionaries[locale];
    fireEvent.click(screen.getByRole("button", { name: copy.CoaCreate }));
    fireEvent.change(screen.getByLabelText(copy.CoaCode), {
      target: { value: "2510" },
    });
    fireEvent.change(screen.getByLabelText(copy.CoaNameEn), {
      target: { value: "Service Provider Payables" },
    });
    fireEvent.change(screen.getByLabelText(copy.CoaNameAr), {
      target: { value: "ذمم مقدمي الخدمات" },
    });
    // Radix Select's keyboard path avoids pointer-capture APIs unavailable in jsdom.
    fireEvent.keyDown(screen.getByRole("combobox", { name: copy.CoaType }), {
      key: "Enter",
    });
    fireEvent.click(
      await screen.findByRole("option", { name: copy.CoaType_LIABILITY }),
    );
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: copy.CoaNormalBalance }),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("option", { name: copy.CoaBalance_CREDIT }),
    );
    fireEvent.click(screen.getByRole("button", { name: copy.CoaSave }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      copy.ServerError_ACCOUNT_CODE_EXISTS,
    );
    expect(fixture.create).toHaveBeenCalledWith({
      orgId,
      code: "2510",
      name: "Service Provider Payables",
      nameAr: "ذمم مقدمي الخدمات",
      type: "LIABILITY",
      normalBalance: "CREDIT",
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fixture.create.mockResolvedValue("created-account");
    fireEvent.click(screen.getByRole("button", { name: copy.CoaSave }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  },
);

test("an unexpected save failure stays visible and uses a generic localized message", async () => {
  fixture.update.mockRejectedValue(new Error("database field secret.ts:123"));
  show("ar");
  fireEvent.click(
    screen.getByRole("button", { name: `${dictionaries.ar.CoaEdit} 2500` }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: dictionaries.ar.CoaSave }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    dictionaries.ar.CoaSaveError,
  );
  expect(screen.queryByText(/database field/)).toBeNull();
});

// SCRUM-932 round 2: the conditionally mounted dialog has no Radix trigger.
test.each([
  ["Create", "Cancel"],
  ["Create", "Escape"],
  ["Create", "Save"],
  ["Create", "Close"],
  ["Edit", "Cancel"],
  ["Edit", "Escape"],
  ["Edit", "Save"],
  ["Edit", "Close"],
] as const)(
  "%s returns focus to its invoking button after %s",
  async (mode, closeAction) => {
    show();
    const invoker = screen.getByRole("button", {
      name: mode === "Create" ? "Create account" : "Edit account 2500",
    });
    invoker.focus();
    fireEvent.click(invoker);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    if (closeAction === "Save") {
      if (mode === "Create") {
        fireEvent.change(within(dialog).getByLabelText("Account code"), {
          target: { value: "2510" },
        });
        fireEvent.change(within(dialog).getByLabelText("Name (English)"), {
          target: { value: "Service Provider Payables" },
        });
      }
      fireEvent.click(within(dialog).getByRole("button", { name: "Save account" }));
    } else if (closeAction === "Escape") {
      fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    } else {
      fireEvent.click(within(dialog).getByRole("button", { name: closeAction }));
    }

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(invoker));
  },
);

test("closing after the edited row disappears returns focus to Create account", async () => {
  const view = show();
  const invoker = screen.getByRole("button", { name: "Edit account 2500" });
  invoker.focus();
  fireEvent.click(invoker);
  expect(screen.getByRole("dialog")).toBeTruthy();

  fixture.accounts = [];
  view.rerender(
    <LanguageProvider>
      <ChartOfAccountsManagement orgId={orgId} />
    </LanguageProvider>,
  );

  expect(invoker.isConnected).toBe(false);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Create account" }),
    ),
  );
});
