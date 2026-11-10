import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const world = vi.hoisted(() => ({ locale: "en" as "en" | "ar", permissions: ["view:finance", "view:cost_price"],
  plan: true as boolean | undefined, data: undefined as unknown, failure: false, calls: [] as unknown[] }));
vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries } = await import("@/lib/i18n/dictionaries");
  return { useLanguage: () => ({ locale: world.locale, dir: world.locale === "ar" ? "rtl" : "ltr",
    t: (key: string) => (dictionaries[world.locale] as Record<string, string>)[key] ?? key }) };
});
vi.mock("@/hooks/use-permissions", () => ({ usePermissions: () => ({ isLoading: false,
  hasPermission: (permission: string) => world.permissions.includes(permission) }) }));
// Convex network boundary only. The dictionaries, money renderer and components are real.
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return { useQuery: (ref: never, args: unknown) => {
    if (args === "skip") return undefined;
    if (getFunctionName(ref) === "subscriptions:getMySubscription") return world.plan === undefined ? undefined : { planDetails: { gates: { accounting: world.plan } } };
    if (["supplierStatement:outstanding", "supplierStatement:settled", "supplierStatement:paymentsReconciliation"].includes(getFunctionName(ref))) return undefined;
    if (getFunctionName(ref) === "supplierStatement:unlinkedAttention") {
      const result = typeof world.data === "function" ? world.data(args) : world.data;
      return (result as { unlinked?: string } | undefined)?.unlinked;
    }
    world.calls.push(args);
    if (world.failure) throw new ConvexError({ code: "SUPPLIER_ATTENTION_UNAVAILABLE", message: "private database detail" });
    return typeof world.data === "function" ? world.data(args) : world.data;
  } };
});

import { SupplierAttentionView, SupplierAttentionError } from "./SupplierAttentionSection";
import { SupplierStatementSection as SupplierAttentionSection } from "./SupplierStatementSection";
import { dictionaries } from "@/lib/i18n/dictionaries";
const en = dictionaries.en as Record<string, string>;
const ar = dictionaries.ar as Record<string, string>;
const baseRow = { kind: "PAYABLE", id: "PAYABLE_1", currency: "JOD", outstandingMinor: 9_500_000,
  disputedMinor: 0, dueDate: "2026-06-05", daysOverdue: 10, status: "ALERTING", step: "OVERDUE_7" } as const;
const page = (rows: unknown[] = [baseRow], over: Record<string, unknown> = {}) => ({ page: rows, complete: true, isDone: true,
  continueCursor: "CURSOR_1", splitCursor: null, pageStatus: null, asOfDate: "2026-06-15", unlinked: "NONE", ...over });
const props = { orgId: "ORG_1" as never, supplierId: "SUPPLIER_1" as never };
function saveRender(name: string, container: HTMLElement) {
  const directory = process.env.SUPPLIER_ATTN_RENDER_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `${name}-${world.locale}.html`), container.innerHTML, "utf8");
}
beforeEach(() => { world.locale = "en"; world.permissions = ["view:finance", "view:cost_price"]; world.plan = true;
  world.data = page(); world.failure = false; world.calls = []; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("supplier needs attention", () => {
  function showsAlerts(locale: "en" | "ar") {
    world.locale = locale;
    const text = locale === "ar" ? ar : en;
    const states = [
      { ...baseRow, id: "EARLY", step: "T_MINUS_3" }, { ...baseRow, id: "DUE", step: "DUE_DAY" },
      baseRow, { ...baseRow, id: "WEEKLY", step: "OVERDUE_WEEKLY" },
      { ...baseRow, id: "DISPUTED", status: "HELD", step: undefined, heldReason: "DISPUTED", disputedMinor: 9_500_000 },
      { ...baseRow, id: "UNDATED", status: "HELD", step: undefined, heldReason: "NO_DUE_DATE", dueDate: null, daysOverdue: null },
    ];
    render(<SupplierAttentionView data={page(states) as never} kind="PAYABLE" onNext={() => undefined} onPrevious={() => undefined} hasPrevious={false} />);
    const region = screen.getByRole("region", { name: text.SuppliersStmtKindPayable });
    for (const key of ["SuppliersStmtAttnStepT3", "SuppliersStmtAttnStepDue", "SuppliersStmtAttnStepOverdue7", "SuppliersStmtAttnStepWeekly", "SuppliersStmtAttnHeldDisputed", "SuppliersStmtAttnHeldNoDue"]) {
      expect(within(region).getByText(text[key])).toBeTruthy();
    }
    expect(within(region).getAllByText(/9,500(?:\s|$)/)).toHaveLength(6);
  }
  test("EN shows each alert and hold with amount and direction", () => showsAlerts("en"));
  test("AR shows each alert and hold with amount and direction", () => showsAlerts("ar"));

  test("A/P and A/R groups remain separate on the supplier workspace", () => {
    render(<SupplierAttentionSection {...props} />);
    expect(screen.getByRole("region", { name: en.SuppliersStmtAttnPayableTitle })).toBeTruthy();
    expect(screen.getByRole("region", { name: en.SuppliersStmtAttnReceivableTitle })).toBeTruthy();
    expect(screen.getByText(en.SuppliersStmtAttnEligibility)).toBeTruthy();
  });

  function showsStates(locale: "en" | "ar") {
    world.locale = locale; const text = locale === "ar" ? ar : en;
    const { rerender } = render(<SupplierAttentionView data={undefined} kind="PAYABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain(text.SuppliersStmtLoading);
    rerender(<SupplierAttentionView data={page([]) as never} kind="PAYABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />);
    expect(screen.getByText(text.SuppliersStmtAttnNone)).toBeTruthy();
    rerender(<SupplierAttentionView data={page([], { complete: false, isDone: false, unlinked: "INCOMPLETE" }) as never} kind="PAYABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />);
    expect(screen.queryByText(text.SuppliersStmtAttnNone)).toBeNull();
    expect(screen.getByText(text.SuppliersStmtAttnIncomplete)).toBeTruthy();
    expect(screen.getByText(text.SuppliersStmtAttnUnlinkedIncomplete)).toBeTruthy();
  }
  test("EN loading, empty and incomplete states never invent a full count", () => showsStates("en"));
  test("AR loading, empty and incomplete states never invent a full count", () => showsStates("ar"));

  function showsUnlinked(locale: "en" | "ar") {
    world.locale = locale; const text = locale === "ar" ? ar : en;
    render(<SupplierAttentionView data={page([], { unlinked: "PRESENT" }) as never} kind="PAYABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />);
    expect(screen.getByText(text.SuppliersStmtAttnUnlinked)).toBeTruthy();
  }
  test("EN unlinked records are labelled organisation-wide", () => showsUnlinked("en"));
  test("AR unlinked records are labelled organisation-wide", () => showsUnlinked("ar"));

  function permissionSkips({ permissions }: { permissions: string[] }) {
    world.permissions = permissions; render(<SupplierAttentionSection {...props} />);
    expect(world.calls).toEqual([]);
    expect(screen.queryByText(en.SuppliersStmtAttnTitle)).toBeNull();
  }
  test("no finance or cost permission skips alert reads", () => permissionSkips({ permissions: [] }));
  test("finance-only permission skips alert reads", () => permissionSkips({ permissions: ["view:finance"] }));
  test("cost-only permission skips alert reads", () => permissionSkips({ permissions: ["view:cost_price"] }));

  test("plan loading and denied plan skip alert reads", () => {
    world.plan = undefined; const { rerender } = render(<SupplierAttentionSection {...props} />);
    expect(world.calls).toEqual([]);
    world.plan = false; rerender(<SupplierAttentionSection {...props} />);
    expect(world.calls).toEqual([]);
    expect(screen.getByText(en.SuppliersStmtPlanGate)).toBeTruthy();
  });

  function localizedErrors(locale: "en" | "ar") {
    world.locale = locale; world.failure = true; const text = locale === "ar" ? ar : en;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<SupplierAttentionSection {...props} />);
      expect(screen.getAllByRole("alert")[0]?.textContent).toContain(text.ServerError_SUPPLIER_ATTENTION_UNAVAILABLE);
      expect(screen.queryByText(/private database detail/)).toBeNull();
    } finally { log.mockRestore(); }
  }
  test("EN coded query failures are localized without raw details", () => localizedErrors("en"));
  test("AR coded query failures are localized without raw details", () => localizedErrors("ar"));

  test("next page and previous page change only that family's cursor", () => {
    world.data = page([], { complete: false, isDone: false }); render(<SupplierAttentionSection {...props} />);
    const group = screen.getByRole("region", { name: en.SuppliersStmtKindPayable });
    fireEvent.click(within(group).getByRole("button", { name: en.SuppliersStmtAttnNext }));
    expect(world.calls).toContainEqual(expect.objectContaining({ kind: "PAYABLE", paginationOpts: { numItems: 25, cursor: "CURSOR_1" } }));
    world.calls = [];
    fireEvent.click(within(group).getByRole("button", { name: en.SuppliersStmtAttnPrevious }));
    expect(world.calls.at(-1)).toEqual(expect.objectContaining({ kind: "PAYABLE", paginationOpts: { numItems: 25, cursor: null } }));
  });

  test("an open tab refreshes at Amman midnight", () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-06-15T20:59:59Z"));
    render(<SupplierAttentionSection {...props} />); world.calls = [];
    act(() => vi.advanceTimersByTime(1000));
    expect(world.calls).toContainEqual(expect.objectContaining({ nowMs: Date.parse("2026-06-15T21:00:00Z") }));
  });

  test("EN and AR read-budget notices withhold figures and prevent cursor advance", () => {
    for (const locale of ["en", "ar"] as const) {
      world.locale = locale; const text = locale === "ar" ? ar : en;
      render(<SupplierAttentionView data={page([], { complete: false, isDone: false, incompleteReason: "READ_BUDGET" }) as never} kind="PAYABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />);
      expect(screen.getByText(text.SuppliersStmtAttnBudget)).toBeTruthy();
      expect(screen.queryByRole("button", { name: text.SuppliersStmtAttnNext })).toBeNull();
      expect(screen.queryByText(/9,500/)).toBeNull();
      cleanup();
    }
  });

  test("EN and AR required-split notices prevent advancing over unread records", () => {
    for (const locale of ["en", "ar"] as const) {
      world.locale = locale; const text = locale === "ar" ? ar : en;
      render(<SupplierAttentionView data={page([], { complete: false, isDone: false, pageStatus: "SplitRequired", splitCursor: "SPLIT_1", incompleteReason: "SPLIT_REQUIRED" }) as never} kind="PAYABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />);
      expect(screen.getByText(text.SuppliersStmtAttnSplit)).toBeTruthy();
      expect(screen.queryByRole("button", { name: text.SuppliersStmtAttnNext })).toBeNull();
      expect(screen.queryByText(text.SuppliersStmtAttnNone)).toBeNull();
      cleanup();
    }
  });

  test("EN and AR workspace fixtures preserve direction and separated obligations", () => {
    for (const locale of ["en", "ar"] as const) {
      world.locale = locale; const text = locale === "ar" ? ar : en;
      world.data = ({ kind }: { kind: string }) => {
        if (kind === "PAYABLE") return page([baseRow], { complete: false, isDone: false, unlinked: "PRESENT" });
        if (kind === "RECEIVABLE") return page([{ ...baseRow, kind, id: "AR_1", outstandingMinor: 3_000_000, daysOverdue: -2, dueDate: "2026-06-17", step: "T_MINUS_3" }]);
        return page([{ ...baseRow, kind, id: "RECOVERY_1", outstandingMinor: 150_000, dueDate: null, daysOverdue: null, status: "HELD", heldReason: "NO_DUE_DATE" }]);
      };
      const view = render(<SupplierAttentionSection {...props} />);
      expect(view.container.querySelector("[dir]")?.getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr");
      expect(screen.getByText(text.SuppliersStmtAttnTitle)).toBeTruthy();
      expect(screen.getByText(text.SuppliersStmtAttnUnlinked)).toBeTruthy();
      saveRender("workspace", view.container); cleanup();
      const states = render(<>
        <SupplierAttentionView data={undefined} kind="PAYABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />
        <SupplierAttentionView data={page([]) as never} kind="RECEIVABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />
        <SupplierAttentionView data={page([], { complete: false, isDone: false, incompleteReason: "READ_BUDGET", unlinked: "INCOMPLETE" }) as never} kind="RECOVERY" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />
        <SupplierAttentionError error={new ConvexError({ code: "SUPPLIER_ATTENTION_UNAVAILABLE" })} />
      </>);
      expect(screen.getByText(text.SuppliersStmtAttnNone)).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toContain(text.ServerError_SUPPLIER_ATTENTION_UNAVAILABLE);
      saveRender("states", states.container); cleanup();
    }
  });
});
