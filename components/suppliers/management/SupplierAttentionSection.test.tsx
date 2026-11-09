import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ConvexError } from "convex/values";

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
    world.calls.push(args);
    if (world.failure) throw new ConvexError({ code: "SUPPLIER_ATTENTION_UNAVAILABLE", message: "private database detail" });
    return world.data;
  } };
});

import { SupplierAttentionSection, SupplierAttentionView } from "./SupplierAttentionSection";
import { dictionaries } from "@/lib/i18n/dictionaries";
const en = dictionaries.en as Record<string, string>;
const ar = dictionaries.ar as Record<string, string>;
const baseRow = { kind: "PAYABLE", id: "PAYABLE_1", currency: "JOD", outstandingMinor: 9_500_000,
  disputedMinor: 0, dueDate: "2026-06-05", daysOverdue: 10, status: "ALERTING", step: "OVERDUE_7" } as const;
const page = (rows: unknown[] = [baseRow], over: Record<string, unknown> = {}) => ({ page: rows, complete: true, isDone: true,
  continueCursor: "CURSOR_1", splitCursor: null, pageStatus: null, asOfDate: "2026-06-15", unlinked: "NONE", ...over });
const props = { orgId: "ORG_1" as never, supplierId: "SUPPLIER_1" as never };
beforeEach(() => { world.locale = "en"; world.permissions = ["view:finance", "view:cost_price"]; world.plan = true;
  world.data = page(); world.failure = false; world.calls = []; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("supplier needs attention", () => {
  test.each(["en", "ar"] as const)("%s shows each alert and hold with amount and direction", locale => {
    world.locale = locale;
    const text = locale === "ar" ? ar : en;
    const states = [
      { ...baseRow, step: "T_MINUS_3" }, { ...baseRow, id: "DUE", step: "DUE_DAY" },
      baseRow, { ...baseRow, id: "WEEKLY", step: "OVERDUE_WEEKLY" },
      { ...baseRow, id: "DISPUTED", status: "HELD", step: undefined, heldReason: "DISPUTED", disputedMinor: 9_500_000 },
      { ...baseRow, id: "UNDATED", status: "HELD", step: undefined, heldReason: "NO_DUE_DATE", dueDate: null, daysOverdue: null },
    ];
    render(<SupplierAttentionView data={page(states) as never} kind="PAYABLE" onNext={() => undefined} onPrevious={() => undefined} hasPrevious={false} />);
    const region = screen.getByRole("region", { name: text.SuppliersStmtKindPayable });
    for (const key of ["SuppliersStmtAttnStepT3", "SuppliersStmtAttnStepDue", "SuppliersStmtAttnStepOverdue7", "SuppliersStmtAttnStepWeekly", "SuppliersStmtAttnHeldDisputed", "SuppliersStmtAttnHeldNoDue"]) {
      expect(within(region).getByText(text[key])).toBeInTheDocument();
    }
    expect(within(region).getAllByText(/9,500\.000/)).toHaveLength(6);
  });

  test("A/P and A/R groups remain separate on the supplier workspace", () => {
    render(<SupplierAttentionSection {...props} />);
    expect(screen.getByRole("region", { name: en.SuppliersStmtPayableTitle })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: en.SuppliersStmtReceivableTitle })).toBeInTheDocument();
    expect(screen.getByText(en.SuppliersStmtAttnEligibility)).toBeInTheDocument();
  });

  test.each(["en", "ar"] as const)("%s loading, empty and incomplete states never invent a full count", locale => {
    world.locale = locale; const text = locale === "ar" ? ar : en;
    const { rerender } = render(<SupplierAttentionView data={undefined} kind="PAYABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent(text.SuppliersStmtLoading);
    rerender(<SupplierAttentionView data={page([]) as never} kind="PAYABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />);
    expect(screen.getByText(text.SuppliersStmtAttnNone)).toBeInTheDocument();
    rerender(<SupplierAttentionView data={page([], { complete: false, isDone: false, unlinked: "INCOMPLETE" }) as never} kind="PAYABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />);
    expect(screen.queryByText(text.SuppliersStmtAttnNone)).not.toBeInTheDocument();
    expect(screen.getByText(text.SuppliersStmtAttnIncomplete)).toBeInTheDocument();
    expect(screen.getByText(text.SuppliersStmtAttnUnlinkedIncomplete)).toBeInTheDocument();
  });

  test.each(["en", "ar"] as const)("%s unlinked records are labelled organisation-wide", locale => {
    world.locale = locale; const text = locale === "ar" ? ar : en;
    render(<SupplierAttentionView data={page([], { unlinked: "PRESENT" }) as never} kind="PAYABLE" hasPrevious={false} onNext={() => undefined} onPrevious={() => undefined} />);
    expect(screen.getByText(text.SuppliersStmtAttnUnlinked)).toBeInTheDocument();
  });

  test.each([{ permissions: [] }, { permissions: ["view:finance"] }, { permissions: ["view:cost_price"] }])("permission gate skips alert reads: $permissions", ({ permissions }) => {
    world.permissions = permissions; render(<SupplierAttentionSection {...props} />);
    expect(world.calls).toEqual([]);
    expect(screen.queryByText(en.SuppliersStmtAttnTitle)).not.toBeInTheDocument();
  });

  test("plan loading and denied plan skip alert reads", () => {
    world.plan = undefined; const { rerender } = render(<SupplierAttentionSection {...props} />);
    expect(world.calls).toEqual([]);
    world.plan = false; rerender(<SupplierAttentionSection {...props} />);
    expect(world.calls).toEqual([]);
    expect(screen.getByText(en.SuppliersStmtPlanGate)).toBeInTheDocument();
  });

  test.each(["en", "ar"] as const)("%s coded query failures are localized without raw details", locale => {
    world.locale = locale; world.failure = true; const text = locale === "ar" ? ar : en;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<SupplierAttentionSection {...props} />);
      expect(screen.getAllByRole("alert")[0]).toHaveTextContent(text.ServerError_SUPPLIER_ATTENTION_UNAVAILABLE);
      expect(screen.queryByText(/private database detail/)).not.toBeInTheDocument();
    } finally { log.mockRestore(); }
  });

  test("next page and previous page change only that family's cursor", () => {
    world.data = page([], { complete: false, isDone: false }); render(<SupplierAttentionSection {...props} />);
    const group = screen.getByRole("region", { name: en.SuppliersStmtKindPayable });
    fireEvent.click(within(group).getByRole("button", { name: en.SuppliersStmtAttnNext }));
    expect(world.calls).toContainEqual(expect.objectContaining({ kind: "PAYABLE", paginationOpts: { numItems: 25, cursor: "CURSOR_1" } }));
    fireEvent.click(within(group).getByRole("button", { name: en.SuppliersStmtAttnPrevious }));
    expect(world.calls.at(-3)).toEqual(expect.objectContaining({ kind: "PAYABLE", paginationOpts: { numItems: 25, cursor: null } }));
  });

  test("an open tab refreshes at Amman midnight", () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-06-15T20:59:59Z"));
    render(<SupplierAttentionSection {...props} />); world.calls = [];
    act(() => vi.advanceTimersByTime(1000));
    expect(world.calls).toContainEqual(expect.objectContaining({ nowMs: Date.parse("2026-06-15T21:00:00Z") }));
  });
});
