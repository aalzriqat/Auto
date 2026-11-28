/**
 * SCRUM-1039: the expense assistant's entry in the top bar (desktop) and the
 * menu drawer (phones). It renders only for a member who may create expenses
 * and whose dealership has the assistant on; it renders nothing at all while
 * either answer is loading, so there is no flash. Without the permission the
 * availability query is never subscribed (it refuses such members).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";

const stubs = vi.hoisted(() => ({
  availability: undefined as { enabled: boolean } | undefined,
  queryCalls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_b1039" }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      const name = getFunctionName(ref);
      stubs.queryCalls.push({ name, args });
      if (args === "skip") return undefined;
      if (name === "aiAssistant:getAvailability") return stubs.availability;
      return undefined;
    },
  };
});

import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { ExpenseAssistantButton } from "./ExpenseAssistantButton";
import { closeExpenseAssistant, useExpenseAssistantState } from "./expenseAssistantStore";
import { CREATE_EXPENSES_PERMISSION } from "./useExpenseAssistantAvailable";

type Locale = "en" | "ar";
const copy = (locale: Locale) => dictionaries[locale] as Record<string, string>;

function OpenFlag() {
  const { open } = useExpenseAssistantState();
  return <output data-testid="assistant-open">{open ? "open" : "closed"}</output>;
}

function renderButton(locale: Locale, permissions: readonly string[], variant: "bar" | "drawer" = "bar", onOpen?: () => void) {
  localStorage.setItem("autoflow-locale", locale);
  return render(
    <LanguageProvider>
      <ExpenseAssistantButton variant={variant} permissions={permissions} onOpen={onOpen} />
      <OpenFlag />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  stubs.availability = { enabled: true };
  stubs.queryCalls = [];
});

afterEach(() => {
  act(() => closeExpenseAssistant());
  vi.unstubAllGlobals();
});

describe("ExpenseAssistantButton visibility", () => {
  test("gates on the same permission the server checks", () => {
    expect(CREATE_EXPENSES_PERMISSION).toBe(PERMISSIONS.CREATE_EXPENSES);
  });

  test.each(["en", "ar"] as const)("%s: hidden without create:expenses, and availability is never asked", async (locale) => {
    renderButton(locale, ["view:expenses", "create:expenses:request"]);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: copy(locale).ExpenseAssistantOpen ?? "Expense assistant" })).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    const asked = stubs.queryCalls.filter((call) => call.name === "aiAssistant:getAvailability");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((call) => call.args === "skip")).toBe(true);
  });

  test.each([
    ["loading", undefined],
    ["disabled", { enabled: false }],
  ] as const)("hidden while availability is %s", async (_label, availability) => {
    stubs.availability = availability;
    renderButton("en", ["create:expenses"]);
    await act(async () => {});
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("permissions still loading (empty list) render nothing", async () => {
    renderButton("en", []);
    await act(async () => {});
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test.each(["en", "ar"] as const)("%s: shown when allowed and enabled, labelled, and opens the assistant", async (locale) => {
    renderButton(locale, ["create:expenses"]);
    const c = copy(locale);
    const button = await screen.findByRole("button", { name: c.ExpenseAssistantOpen });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(stubs.queryCalls).toContainEqual({ name: "aiAssistant:getAvailability", args: { orgId: "org_b1039" } });
    expect(screen.getByTestId("assistant-open").textContent).toBe("closed");
    fireEvent.click(button);
    expect(screen.getByTestId("assistant-open").textContent).toBe("open");
    expect(document.documentElement.dir).toBe(locale === "ar" ? "rtl" : "ltr");
  });

  test.each(["en", "ar"] as const)("%s: the drawer row shows its text label and runs onOpen before opening", async (locale) => {
    const onOpen = vi.fn();
    renderButton(locale, ["create:expenses"], "drawer", onOpen);
    const c = copy(locale);
    const row = await screen.findByRole("button", { name: c.ExpenseAssistantOpen });
    expect(row.textContent).toContain(c.ExpenseAssistantOpen);
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("assistant-open").textContent).toBe("open");
  });
});
