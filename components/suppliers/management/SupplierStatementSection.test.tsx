/**
 * SCRUM-869 slice 2: the supplier statement section. A/P and A/R are two sections with their own
 * per-currency totals; nothing on the screen nets one against the other. Every string is checked
 * in English and Arabic through the real dictionaries.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";

type Section = {
  rows: Array<Record<string, unknown>>;
  totals: Array<{
    currency: string;
    grossMinor: number;
    disputedMinor: number;
    overdueMinor: number;
  }>;
  complete: boolean;
};

const world = vi.hoisted(() => ({
  locale: "en" as "en" | "ar",
  permissions: [] as string[],
  permissionsLoading: false,
  statement: undefined as unknown,
  settled: undefined as unknown,
  recon: undefined as unknown,
  plan: undefined as unknown,
  queryThrows: null as null | Error,
  queryCalls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock("@/components/providers/LanguageProvider", async () => {
  const { dictionaries } = await import("@/lib/i18n/dictionaries");
  return {
    useLanguage: () => ({
      t: (key: string) => (dictionaries[world.locale] as Record<string, string>)[key] ?? key,
      locale: world.locale,
      isRtl: world.locale === "ar",
      dir: world.locale === "ar" ? "rtl" : "ltr",
    }),
  };
});
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    isLoading: world.permissionsLoading,
    hasPermission: (permission: string) => world.permissions.includes(permission),
  }),
}));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      world.queryCalls.push({ name, args });
      if (world.queryThrows) throw world.queryThrows;
      if (args === "skip") return undefined;
      if (name === "subscriptions:getMySubscription") return world.plan;
      if (name === "supplierStatement:paymentsReconciliation") return world.recon;
      return name === "supplierStatement:settled" ? world.settled : world.statement;
    },
  };
});

import { SupplierStatementSection } from "./SupplierStatementSection";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { PERMISSIONS } from "@/convex/utils/permissions";

const en = dictionaries.en as Record<string, string>;
const ar = dictionaries.ar as Record<string, string>;
const ORG = "org_1" as never;
const SUP = "sup_1" as never;

const row = (over: Record<string, unknown>) => ({
  kind: "PAYABLE",
  id: "r1",
  currency: "JOD",
  outstandingMinor: 9_500_000,
  disputedMinor: 0,
  dueAt: 1,
  dueDate: "2026-06-05",
  rule: "AGREED",
  explanation: "x",
  daysOverdue: 10,
  bucket: "DAYS_1_30",
  ...over,
});
const section = (over: Partial<Section> = {}): Section => ({
  rows: [],
  totals: [],
  complete: true,
  ...over,
});

beforeEach(() => {
  world.locale = "en";
  world.permissions = [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.VIEW_COST_PRICE];
  world.plan = { planDetails: { gates: { accounting: true } } };
  world.permissionsLoading = false;
  world.queryThrows = null;
  world.settled = undefined;
  world.recon = undefined;
  world.queryCalls.length = 0;
  world.statement = {
    supplierId: "sup_1",
    payable: section({
      rows: [row({})],
      totals: [
        {
          currency: "JOD",
          grossMinor: 9_500_000,
          disputedMinor: 0,
          overdueMinor: 9_500_000,
        },
      ],
    }),
    receivable: section({
      rows: [
        row({
          kind: "RECEIVABLE",
          id: "r2",
          outstandingMinor: 3_000_000,
          dueDate: null,
          daysOverdue: null,
          bucket: "NO_DUE_DATE",
        }),
      ],
      totals: [
        {
          currency: "JOD",
          grossMinor: 3_000_000,
          disputedMinor: 0,
          overdueMinor: 0,
        },
      ],
    }),
  };
});
afterEach(cleanup);

const renderIt = () => render(<SupplierStatementSection orgId={ORG} supplierId={SUP} />);

describe("supplier statement section", () => {
  test("shows A/P and A/R in two separate regions with their own totals and no net figure", () => {
    renderIt();
    const ap = screen.getByRole("region", {
      name: en.SuppliersStmtPayableTitle,
    });
    const ar_ = screen.getByRole("region", {
      name: en.SuppliersStmtReceivableTitle,
    });
    expect(within(ap).getAllByText(/9,500/).length).toBeGreaterThan(0);
    expect(within(ap).queryByText(/3,000/)).toBeNull();
    expect(within(ar_).getAllByText(/3,000/).length).toBeGreaterThan(0);
    expect(within(ar_).queryByText(/9,500/)).toBeNull();
    expect(screen.getByText(en.SuppliersStmtNoNetNote)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/6,500|net position|balance/i);
  });

  test("the total label says it counts linked lines only, so it cannot be read as the supplier's whole balance (SCRUM-879 L3)", () => {
    expect(en.SuppliersStmtTotal).toMatch(/linked/i);
    expect(ar.SuppliersStmtTotal).not.toBe("إجمالي المستحق");
    expect(ar.SuppliersStmtTotal).toMatch(/المرتبط/);
  });

  test("asks the server for this supplier only, with a validated clock argument", () => {
    renderIt();
    const call = world.queryCalls.find((c) => c.name === "supplierStatement:outstanding");
    expect(call?.args).toMatchObject({ orgId: ORG, supplierId: SUP });
    expect(Number.isSafeInteger((call?.args as { nowMs: number }).nowMs)).toBe(true);
  });

  test("loading, empty, incomplete and error states", () => {
    world.statement = undefined;
    const { unmount } = renderIt();
    expect(screen.getByRole("status").textContent).toContain(en.SuppliersStmtLoading);
    unmount();

    world.statement = {
      supplierId: "sup_1",
      payable: section(),
      receivable: section(),
    };
    const second = renderIt();
    expect(screen.getByText(en.SuppliersStmtPayableEmpty)).toBeTruthy();
    expect(screen.getByText(en.SuppliersStmtReceivableEmpty)).toBeTruthy();
    second.unmount();

    world.statement = {
      supplierId: "sup_1",
      payable: section({ complete: false }),
      receivable: section(),
    };
    const third = renderIt();
    expect(screen.getAllByText(en.SuppliersStmtIncomplete)).toHaveLength(1);
    third.unmount();

    world.queryThrows = new Error("boom");
    renderIt();
    expect(screen.getByRole("alert").textContent).toContain(en.SuppliersStmtLoadError);
  });

  test("needs view:finance: without it nothing is requested or shown", () => {
    world.permissions = [];
    const { container } = renderIt();
    expect(container.textContent).toBe("");
    expect(world.queryCalls.every((c) => c.args === "skip")).toBe(true);
  });

  test("needs view:cost_price as well as view:finance (SCRUM-886): with finance alone nothing is requested or shown", () => {
    world.permissions = [PERMISSIONS.VIEW_FINANCE];
    const { container } = renderIt();
    expect(container.textContent).toBe("");
    expect(world.queryCalls.every((c) => c.args === "skip")).toBe(true);
  });

  test("a plan without accounting gets a truthful gated note, not an error, and the statement is never requested", () => {
    world.plan = { planDetails: { gates: { accounting: false } } };
    renderIt();
    expect(screen.getByRole("note").textContent).toContain(en.SuppliersStmtPlanGate);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(world.queryCalls.filter((c) => c.name === "supplierStatement:outstanding").every((c) => c.args === "skip")).toBe(true);
  });

  test("never claims nothing is owed: opening-balance and unlinked lines are disclosed as not included, even when both lists are empty", () => {
    world.statement = { supplierId: "sup_1", payable: section(), receivable: section() };
    renderIt();
    expect(screen.getByText(en.SuppliersStmtScopeNote)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Nothing is outstanding|owes us nothing/i);
    // The settled-history empty states carry the same linked-lines-only scope (opening payments are not listed).
    world.settled = { supplierId: "sup_1", payable: { rows: [], totals: [], complete: true }, receivable: { rows: [], totals: [], complete: true } };
    cleanup();
    renderIt();
    expect(document.body.textContent).not.toMatch(/Nothing has been (paid|received)/i);
    expect(en.SuppliersStmtScopeNote).toMatch(/opening/i);
    expect(ar.SuppliersStmtScopeNote).toBeTruthy();
    expect(ar.SuppliersStmtScopeNote).not.toBe(en.SuppliersStmtScopeNote);
  });

  test("Arabic: headings and notes come from the Arabic dictionary, amounts use the Arabic currency label", () => {
    world.locale = "ar";
    renderIt();
    expect(ar.SuppliersStmtPayableTitle).not.toBe(en.SuppliersStmtPayableTitle);
    expect(screen.getByRole("region", { name: ar.SuppliersStmtPayableTitle })).toBeTruthy();
    expect(screen.getByRole("region", { name: ar.SuppliersStmtReceivableTitle })).toBeTruthy();
    expect(screen.getByText(ar.SuppliersStmtNoNetNote)).toBeTruthy();
    expect(screen.getAllByText(/د\.أ/).length).toBeGreaterThan(0);
  });

  test("a disputed amount and an overdue amount are shown beside, not instead of, the gross", () => {
    world.statement = {
      supplierId: "sup_1",
      payable: section({
        rows: [row({ disputedMinor: 1_000_000, outstandingMinor: 1_000_000 })],
        totals: [
          {
            currency: "JOD",
            grossMinor: 1_000_000,
            disputedMinor: 1_000_000,
            overdueMinor: 1_000_000,
          },
        ],
      }),
      receivable: section(),
    };
    renderIt();
    const ap = screen.getByRole("region", {
      name: en.SuppliersStmtPayableTitle,
    });
    expect(within(ap).getAllByText(new RegExp(en.SuppliersStmtDisputed)).length).toBeGreaterThan(0);
    expect(within(ap).getAllByText(new RegExp(en.SuppliersStmtOverdue)).length).toBeGreaterThan(0);
  });

  test("an incomplete section shows no total: an explicit unavailable line replaces the number (W14), in EN and AR", () => {
    world.statement = {
      supplierId: "sup_1",
      payable: section({
        rows: [row({})],
        totals: [
          {
            currency: "JOD",
            grossMinor: 9_500_000,
            disputedMinor: 0,
            overdueMinor: 9_500_000,
          },
        ],
        complete: false,
      }),
      receivable: section({
        rows: [row({ kind: "RECEIVABLE", id: "r2", outstandingMinor: 3_000_000 })],
        totals: [
          {
            currency: "JOD",
            grossMinor: 3_000_000,
            disputedMinor: 0,
            overdueMinor: 0,
          },
        ],
      }),
    };
    for (const locale of ["en", "ar"] as const) {
      world.locale = locale;
      const dict = locale === "en" ? en : ar;
      const { unmount } = renderIt();
      const ap = screen.getByRole("region", {
        name: dict.SuppliersStmtPayableTitle,
      });
      const arRegion = screen.getByRole("region", {
        name: dict.SuppliersStmtReceivableTitle,
      });
      expect(dict.SuppliersStmtTotalUnavailable, `${locale} string exists`).toBeTruthy();
      expect(within(ap).queryByText(dict.SuppliersStmtTotal)).toBeNull();
      expect(within(ap).getByText(dict.SuppliersStmtTotalUnavailable)).toBeTruthy();
      // The complete section still shows its own total.
      expect(within(arRegion).getByText(dict.SuppliersStmtTotal)).toBeTruthy();
      expect(within(arRegion).queryByText(dict.SuppliersStmtTotalUnavailable)).toBeNull();
      unmount();
    }
  });

  test("settled history: paid and received sit in two regions with their own totals, in EN and AR, and no net figure", () => {
    const settledRow = (over: Record<string, unknown>) => ({
      kind: "PAYABLE",
      id: "s1",
      currency: "JOD",
      status: "PAID",
      dueMinor: 9_500_000,
      settledMinor: 9_500_000,
      lastChangedAt: Date.parse("2026-06-10T09:00:00Z"),
      ...over,
    });
    world.settled = {
      supplierId: "sup_1",
      payable: {
        rows: [settledRow({}), settledRow({ id: "s2", status: "PARTIALLY_PAID", settledMinor: 4_000_000 })],
        totals: [{ currency: "JOD", settledMinor: 13_500_000 }],
        complete: true,
      },
      receivable: {
        rows: [settledRow({ kind: "RECEIVABLE", id: "s3", dueMinor: 3_000_000, settledMinor: 3_000_000 })],
        totals: [{ currency: "JOD", settledMinor: 3_000_000 }],
        complete: true,
      },
    };
    for (const locale of ["en", "ar"] as const) {
      world.locale = locale;
      const dict = locale === "en" ? en : ar;
      const { unmount } = renderIt();
      expect(screen.getByRole("heading", { name: dict.SuppliersStmtHistoryTitle })).toBeTruthy();
      const paid = screen.getByRole("region", { name: dict.SuppliersStmtHistoryPaidTitle });
      const received = screen.getByRole("region", { name: dict.SuppliersStmtHistoryReceivedTitle });
      expect(within(paid).getAllByText(/13,500/).length).toBeGreaterThan(0);
      expect(within(paid).getByText(dict.SuppliersStmtHistoryTotalPaid)).toBeTruthy();
      expect(within(paid).getByText(dict.SuppliersStmtHistorySettled)).toBeTruthy();
      expect(within(paid).getByText(dict.SuppliersStmtHistoryPartly)).toBeTruthy();
      expect(within(received).getAllByText(/3,000/).length).toBeGreaterThan(0);
      expect(within(received).getByText(dict.SuppliersStmtHistoryTotalReceived)).toBeTruthy();
      expect(within(received).queryByText(/13,500/)).toBeNull();
      expect(document.body.textContent).not.toMatch(/16,500|net position/i);
      unmount();
    }
  });

  test("settled history: an incomplete list shows no total; empty and loading states render", () => {
    world.settled = {
      supplierId: "sup_1",
      payable: { rows: [], totals: [], complete: false },
      receivable: { rows: [], totals: [], complete: true },
    };
    const first = renderIt();
    const paid = screen.getByRole("region", { name: en.SuppliersStmtHistoryPaidTitle });
    expect(within(paid).getByText(en.SuppliersStmtTotalUnavailable)).toBeTruthy();
    expect(screen.getByText(en.SuppliersStmtHistoryReceivedEmpty)).toBeTruthy();
    first.unmount();
    world.settled = undefined;
    renderIt();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  test("payments check: reconciled, differing and unavailable are told apart, in EN and AR, and the credit side is never given a number", () => {
    const base = {
      supplierId: "sup_1",
      currencies: [{ currency: "JOD", subledgerPaidMinor: 4_000_000, glPaidMinor: 3_000_000, differenceMinor: 1_000_000 }],
      differences: [],
      excludedOpeningRows: 2,
      creditSide: "NOT_ATTRIBUTABLE",
    };
    const cases = [
      { recon: { ...base, status: "AVAILABLE", isReconciled: true }, key: "SuppliersStmtReconOk" },
      { recon: { ...base, status: "AVAILABLE", isReconciled: false }, key: "SuppliersStmtReconDiffers" },
      {
        recon: { ...base, status: "UNAVAILABLE", unavailableReason: "PENDING_POSTINGS", currencies: [], isReconciled: false },
        key: "SuppliersStmtReconUnavailable",
      },
    ] as const;
    for (const locale of ["en", "ar"] as const) {
      world.locale = locale;
      const dict = locale === "en" ? en : ar;
      for (const c of cases) {
        world.recon = c.recon;
        const { unmount } = renderIt();
        expect(screen.getByRole("heading", { name: dict.SuppliersStmtReconTitle })).toBeTruthy();
        expect(screen.getByText(new RegExp(dict[c.key].replace(/[()]/g, "\\$&")))).toBeTruthy();
        expect(screen.getByText(dict.SuppliersStmtReconCreditNote)).toBeTruthy();
        // SCRUM-879 L2: the check compares paid amounts only, so an overpaid payable is not flagged and the note says so.
        expect(dict.SuppliersStmtReconCreditNote).toMatch(locale === "en" ? /overpa/i : /زائد|أكثر/);
        unmount();
      }
    }
    world.recon = undefined;
    renderIt();
    expect(screen.queryByRole("heading", { name: en.SuppliersStmtReconTitle })).toBeNull();
  });

  test("the time window is refreshed while the page stays open, so a long-lived tab never trips the server clock check", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-06-15T09:00:00Z"));
      renderIt();
      const first = (
        world.queryCalls.findLast((c) => c.name === "supplierStatement:outstanding")?.args as { nowMs: number }
      ).nowMs;
      act(() => {
        vi.advanceTimersByTime(3 * 60 * 60 * 1000);
      });
      const later = (
        world.queryCalls.findLast((c) => c.name === "supplierStatement:outstanding")?.args as { nowMs: number }
      ).nowMs;
      expect(later - first).toBeGreaterThanOrEqual(3 * 60 * 60 * 1000 - 1000);
    } finally {
      vi.useRealTimers();
    }
  });
});
