/**
 * SCRUM-1039: the expense assistant panel against a stubbed Convex client (the
 * component's system boundary). Pins what is requested, what each outcome says
 * in English and Arabic, that typed text survives every non-ready outcome, and
 * that a ready proposal only OPENS the real expense form: nothing is saved until
 * the staff member's own click calls `expenses.create`.
 *
 * Not a visual check (jsdom has no layout): RTL spacing and phone widths still
 * need a rendered pass.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { Toaster, toast } from "sonner";
import { dictionaries } from "@/lib/i18n/dictionaries";

type ProposalView =
  | null
  | {
      status: "pending" | "ready" | "not_expense" | "not_understood" | "failed";
      proposal?: {
        amount: number;
        taxAmount?: number;
        category: string;
        date: string;
        title: string;
        notes?: string;
        vendorName?: string;
        paymentMethod?: string;
      };
    };

const stubs = vi.hoisted(() => ({
  view: undefined as unknown,
  request: undefined as unknown as ReturnType<typeof vi.fn>,
  create: undefined as unknown as ReturnType<typeof vi.fn>,
  queryCalls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock("@/components/providers/OrgProvider", () => ({ useOrg: () => ({ activeOrgId: "org_c1039" }) }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
      const name = getFunctionName(ref);
      stubs.queryCalls.push({ name, args });
      if (args === "skip") return undefined;
      if (name === "aiAssistant:getExpenseProposal") return stubs.view;
      if (name === "vehicles:listAll") return [];
      if (name === "orgSettings:get") return { currency: "JOD" };
      return undefined;
    },
    usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
    useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
      const name = getFunctionName(ref);
      if (name === "aiAssistant:requestExpenseProposal") return stubs.request;
      if (name === "expenses:create") return stubs.create;
      if (name === "expenses:update") return vi.fn();
      throw new Error(`unexpected mutation ${name}`);
    },
  };
});

import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { ExpenseAssistant } from "./ExpenseAssistant";
import { closeExpenseAssistant, openExpenseAssistant } from "./expenseAssistantStore";

type Locale = "en" | "ar";
const copy = (locale: Locale) => dictionaries[locale] as Record<string, string>;
const PROPOSAL_ID = "proposal_c1";

function tree() {
  return (
    <LanguageProvider>
      <button type="button">trigger</button>
      <ExpenseAssistant />
      <Toaster />
    </LanguageProvider>
  );
}

async function openPanel(locale: Locale) {
  localStorage.setItem("autoflow-locale", locale);
  const view = render(tree());
  await act(async () => {});
  const trigger = screen.getByRole("button", { name: "trigger" });
  trigger.focus();
  act(() => openExpenseAssistant(trigger));
  const box = (await screen.findByRole("textbox", { name: copy(locale).ExpenseAssistantMessageLabel })) as HTMLTextAreaElement;
  return { box, trigger, rerender: () => view.rerender(tree()) };
}

function submitButton(locale: Locale): HTMLButtonElement {
  return screen.getByRole("button", { name: copy(locale).ExpenseAssistantSubmit }) as HTMLButtonElement;
}

/** Type, press Enter, let the request resolve, then let the subscription report `view`. */
async function ask(locale: Locale, text: string, view: ProposalView, rerender: () => void) {
  const box = screen.getByRole("textbox", { name: copy(locale).ExpenseAssistantMessageLabel });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(stubs.request).toHaveBeenCalled());
  await act(async () => {});
  stubs.view = view;
  rerender();
  await act(async () => {});
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  // jsdom has no ResizeObserver; the expense form's prepaid checkbox measures itself.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  stubs.view = undefined;
  stubs.queryCalls = [];
  stubs.request = vi.fn().mockResolvedValue({ proposalId: PROPOSAL_ID });
  stubs.create = vi.fn().mockResolvedValue("expense_new");
});

afterEach(() => {
  act(() => closeExpenseAssistant());
  toast.dismiss();
  vi.unstubAllGlobals();
});

describe("ExpenseAssistant panel", () => {
  test("renders nothing while closed and subscribes to no proposal", async () => {
    render(tree());
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stubs.queryCalls.filter((c) => c.name === "aiAssistant:getExpenseProposal").every((c) => c.args === "skip")).toBe(true);
  });

  test.each(["en", "ar"] as const)("%s: opens with the explanation, focuses the box, Escape closes and focus returns to the trigger", async (locale) => {
    const { box, trigger } = await openPanel(locale);
    const c = copy(locale);
    expect(screen.getByText(c.ExpenseAssistantExplain)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: c.ExpenseAssistantTitle })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(box.getAttribute("dir")).toBe("auto");
    expect(document.documentElement.dir).toBe(locale === "ar" ? "rtl" : "ltr");

    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("Enter sends the trimmed message once; Shift+Enter is a new line", async () => {
    const { box } = await openPanel("en");
    fireEvent.change(box, { target: { value: "  paid 120 rent today  " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(stubs.request).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(stubs.request).toHaveBeenCalledTimes(1));
    expect(stubs.request).toHaveBeenCalledWith({ orgId: "org_c1039", message: "paid 120 rent today" });
  });

  test.each(["en", "ar"] as const)("%s: while pending the box is read-only, progress is announced, and a second submit is blocked", async (locale) => {
    let resolveRequest: (value: { proposalId: string }) => void = () => undefined;
    stubs.request = vi.fn().mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    const { box, rerender } = await openPanel(locale);
    const c = copy(locale);
    fireEvent.change(box, { target: { value: "paid 35 for fuel yesterday" } });
    fireEvent.click(submitButton(locale));
    await waitFor(() => expect(stubs.request).toHaveBeenCalledTimes(1));
    expect(box.readOnly).toBe(true);
    expect(box.getAttribute("aria-busy")).toBe("true");
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(c.ExpenseAssistantWorking);
    expect(submitButton(locale).getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(submitButton(locale));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(stubs.request).toHaveBeenCalledTimes(1);

    // Request accepted, proposal still pending: still busy, still one request.
    await act(async () => resolveRequest({ proposalId: PROPOSAL_ID }));
    stubs.view = { status: "pending" };
    rerender();
    expect(screen.getByRole("status").textContent).toContain(c.ExpenseAssistantWorking);
    fireEvent.click(submitButton(locale));
    expect(stubs.request).toHaveBeenCalledTimes(1);
    expect(stubs.queryCalls).toContainEqual({ name: "aiAssistant:getExpenseProposal", args: { orgId: "org_c1039", proposalId: PROPOSAL_ID } });
  });

  test.each([
    ["en", "not_expense", "ExpenseAssistantNotExpense"],
    ["ar", "not_expense", "ExpenseAssistantNotExpense"],
    ["en", "not_understood", "ExpenseAssistantNotUnderstood"],
    ["ar", "not_understood", "ExpenseAssistantNotUnderstood"],
    ["en", "failed", "ExpenseAssistantFailed"],
    ["ar", "failed", "ExpenseAssistantFailed"],
  ] as const)("%s %s: says so, keeps the typed text, and a retry sends again", async (locale, status, key) => {
    const { box, rerender } = await openPanel(locale);
    const c = copy(locale);
    await ask(locale, "hello there", { status }, rerender);
    expect(screen.getByRole("status").textContent).toContain(c[key]);
    expect(box.value).toBe("hello there");
    expect(box.readOnly).toBe(false);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.change(box, { target: { value: "hello there, paid 20 for coffee today" } });
    fireEvent.click(submitButton(locale));
    await waitFor(() => expect(stubs.request).toHaveBeenCalledTimes(2));
    expect(stubs.request).toHaveBeenLastCalledWith({ orgId: "org_c1039", message: "hello there, paid 20 for coffee today" });
  });

  test.each(["en", "ar"] as const)("%s: an unreadable proposal (null) reads as failed and keeps the text", async (locale) => {
    const { box, rerender } = await openPanel(locale);
    await ask(locale, "paid 10", null, rerender);
    expect(screen.getByRole("status").textContent).toContain(copy(locale).ExpenseAssistantFailed);
    expect(box.value).toBe("paid 10");
  });

  test.each([
    ["en", "AI_ASSISTANT_RATE_LIMITED", "ServerError_AI_ASSISTANT_RATE_LIMITED"],
    ["ar", "AI_ASSISTANT_RATE_LIMITED", "ServerError_AI_ASSISTANT_RATE_LIMITED"],
    ["en", "AI_ASSISTANT_NOT_ENABLED", "ServerError_AI_ASSISTANT_NOT_ENABLED"],
    ["ar", "AI_ASSISTANT_NOT_ENABLED", "ServerError_AI_ASSISTANT_NOT_ENABLED"],
    ["en", "VALIDATION_FAILED", "ExpenseAssistantRequestFailed"],
    ["ar", "VALIDATION_FAILED", "ExpenseAssistantRequestFailed"],
    ["en", "FORBIDDEN", "ExpenseAssistantRequestFailed"],
    ["ar", "FORBIDDEN", "ExpenseAssistantRequestFailed"],
  ] as const)("%s refusal %s: shows its own language's text, never the server's, and keeps the text", async (locale, code, key) => {
    stubs.request = vi.fn().mockRejectedValue(new ConvexError({ code, message: "Server wording must not render" }));
    const { box } = await openPanel(locale);
    fireEvent.change(box, { target: { value: "paid 50 for cleaning" } });
    fireEvent.click(submitButton(locale));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(copy(locale)[key]));
    expect(screen.queryByText("Server wording must not render")).toBeNull();
    expect(box.value).toBe("paid 50 for cleaning");
    expect(box.readOnly).toBe(false);
  });

  test.each(["en", "ar"] as const)("%s: a blank or over-long message is refused on the client with its own text", async (locale) => {
    const { box } = await openPanel(locale);
    const c = copy(locale);
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(submitButton(locale).getAttribute("aria-disabled")).toBe("true");
    expect(stubs.request).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: "x".repeat(950) } });
    expect(screen.getByText("950/1000")).toBeTruthy();
    fireEvent.change(box, { target: { value: "x".repeat(1001) } });
    expect(screen.getByText("1001/1000")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(c.ExpenseAssistantTooLong);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(submitButton(locale));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(stubs.request).not.toHaveBeenCalled();
  });

  test.each(["en", "ar"] as const)("%s: ready closes the panel and opens the real expense form pre-filled; only the user's click saves", async (locale) => {
    const { rerender } = await openPanel(locale);
    const c = copy(locale);
    await ask(locale, "paid 120 JOD office rent today in cash to Al Noor", {
      status: "ready",
      proposal: { amount: 120, category: "RENT", date: "2026-11-28", title: "Office rent", vendorName: "Al Noor", paymentMethod: "CASH" },
    }, rerender);

    const form = await screen.findByRole("dialog", { name: c.RecordExpense });
    expect(screen.queryByRole("dialog", { name: c.ExpenseAssistantTitle })).toBeNull();
    expect(screen.getByText(c.ExpenseAssistantNoticeTitle)).toBeTruthy();
    await waitFor(() => expect((screen.getByPlaceholderText("e.g. Brake pad replacement") as HTMLInputElement).value).toBe("Office rent"));
    expect((screen.getByPlaceholderText("250") as HTMLInputElement).value).toBe("120");
    expect((screen.getByPlaceholderText("e.g. Joe's Repair Shop") as HTMLInputElement).value).toBe("Al Noor");
    expect(screen.getByDisplayValue("2026-11-28")).toBeTruthy();
    expect(form).toBeTruthy();

    // The assistant never saves: nothing called create on the way here.
    expect(stubs.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: c.RecordExpense }));
    await waitFor(() => expect(stubs.create).toHaveBeenCalledTimes(1));
    expect(stubs.create.mock.calls[0][0]).toMatchObject({
      orgId: "org_c1039", title: "Office rent", amount: 120, category: "RENT", date: Date.UTC(2026, 10, 28),
      vendor: "Al Noor", paymentMethod: "CASH", status: "PAID",
    });
    expect(stubs.create.mock.calls[0][0].idempotencyKey).toMatch(/^create-expense:/);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(stubs.request).toHaveBeenCalledTimes(1);
  });
});
