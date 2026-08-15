/**
 * The finance-company AR queue's rendering (SCRUM-51).
 *
 * This screen shows amounts from rows that each carry their **own** currency and
 * scale, because a receivable is denominated when it is raised and the org's
 * currency can change afterwards. Two failures matter more than anything visual:
 *
 *   1. summing across currencies into one headline — the exact misstatement
 *      `accountingPhase14` exists to prevent on the reporting side;
 *   2. formatting a row with the wrong scale — a JOD scale-3 amount rendered
 *      through a scale-2 formatter reads ten times wrong, which has shipped in
 *      this codebase before.
 *
 * Neither is visible in a screenshot, so they are pinned here.
 */
import { describe, expect, test, vi, beforeEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const stubs = vi.hoisted(() => ({
  rows: [] as unknown[],
  status: "Exhausted" as string,
  isRtl: false,
}));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: stubs.isRtl, locale: stubs.isRtl ? "ar" : "en" }),
}));

vi.mock("@/components/providers/OrgProvider", () => ({
  useOrg: () => ({ activeOrgId: "org1" }),
}));

vi.mock("convex/react", () => ({
  usePaginatedQuery: () => ({ results: stubs.rows, status: stubs.status, loadMore: vi.fn() }),
}));

import { ClaimsTab } from "./ClaimsTab";

const DAY = 24 * 60 * 60 * 1000;

function row(overrides: Record<string, unknown> = {}) {
  return {
    receivableDocumentId: "rd1",
    documentNumber: "AR-FC-1",
    applicationId: "app1",
    sourceType: "finance_application",
    financingEntity: "Jordan Finance Co",
    buyerName: "Buyer X",
    originalAmountMinor: 750_000,
    outstandingMinor: 500_000,
    currency: "JOD",
    scale: 3,
    status: "PARTIALLY_PAID",
    issueDate: Date.now(),
    dueDate: Date.now() + 30 * DAY,
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  stubs.rows = [];
  stubs.status = "Exhausted";
  stubs.isRtl = false;
});

describe("finance-company AR queue", () => {
  test("renders a row with its own scale, not a fixed one", () => {
    stubs.rows = [row()];
    render(<ClaimsTab />);

    // 750_000 minor at scale 3 is 750, not 7_500 (scale 2) and not 750_000.
    expect(screen.getByText(/750/)).toBeTruthy();
    expect(screen.queryByText(/7,500\b/)).toBeNull();
    expect(screen.queryByText(/750,000/)).toBeNull();
  });

  test("never sums across currencies into one headline", () => {
    stubs.rows = [
      row({ receivableDocumentId: "rd1", currency: "JOD", scale: 3, outstandingMinor: 750_000 }),
      row({ receivableDocumentId: "rd2", currency: "USD", scale: 2, outstandingMinor: 50_000 }),
    ];
    render(<ClaimsTab />);

    // Two separate totals — 750 JOD and 500 USD — and never their raw sum.
    const totals = screen.getAllByText("TotalOutstandingFromFinanciers");
    expect(totals).toHaveLength(2);
    expect(screen.queryByText(/800,000|800000/)).toBeNull();
  });

  test("a fully paid receivable contributes no outstanding headline", () => {
    stubs.rows = [row({ outstandingMinor: 0, status: "PAID" })];
    render(<ClaimsTab />);

    expect(screen.queryByText("TotalOutstandingFromFinanciers")).toBeNull();
  });

  test("marks a row overdue only when money is still outstanding", () => {
    stubs.rows = [
      row({ receivableDocumentId: "rd1", dueDate: Date.now() - 5 * DAY, outstandingMinor: 500_000 }),
      row({ receivableDocumentId: "rd2", dueDate: Date.now() - 5 * DAY, outstandingMinor: 0, status: "PAID" }),
    ];
    const { container } = render(<ClaimsTab />);

    // One warning icon: the settled-but-past-due row is not a collection risk.
    expect(container.querySelectorAll("svg.lucide-triangle-alert").length).toBe(1);
  });

  test("links to the deal that owns the receivable, and omits the link when there is none", () => {
    stubs.rows = [
      row({ receivableDocumentId: "rd1", applicationId: "app1" }),
      row({ receivableDocumentId: "rd2", applicationId: null }),
    ];
    render(<ClaimsTab />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("/org1/applications/app1/deal");
  });

  test("offers no way to create, settle or reject from Accounting", () => {
    stubs.rows = [row()];
    render(<ClaimsTab />);

    // Claims originates and settles nothing; the actions live on the deal.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("an unresolved financier renders a placeholder rather than blank", () => {
    stubs.rows = [row({ financingEntity: null, buyerName: null })];
    render(<ClaimsTab />);

    expect(screen.getByText("UnknownFinancier")).toBeTruthy();
  });

  test("shows the empty state instead of a bare table", () => {
    stubs.rows = [];
    render(<ClaimsTab />);

    expect(screen.getByText("NoFinanceCompanyAR")).toBeTruthy();
  });

  test("shows a loading state on the first page", () => {
    stubs.status = "LoadingFirstPage";
    render(<ClaimsTab />);

    expect(screen.queryByText("NoFinanceCompanyAR")).toBeNull();
  });

  test("amounts are isolated for bidi so RTL cannot reorder them", () => {
    stubs.isRtl = true;
    stubs.rows = [row()];
    const { container } = render(<ClaimsTab />);

    // Arabic is RTL; an unisolated currency+digits run renders in the wrong
    // visual order next to Arabic text. Every money cell is wrapped in <bdi>.
    const isolated = Array.from(container.querySelectorAll("bdi")).map((n) => n.textContent ?? "");
    expect(isolated.some((text) => /750/.test(text))).toBe(true);
    expect(isolated.some((text) => /500/.test(text))).toBe(true);
  });

  test("the deal link points the arrow the way the language reads", () => {
    stubs.rows = [row()];
    stubs.isRtl = true;
    const { container: rtl } = render(<ClaimsTab />);
    expect(rtl.querySelector("svg.lucide-arrow-left")).toBeTruthy();

    cleanup();
    stubs.isRtl = false;
    const { container: ltr } = render(<ClaimsTab />);
    expect(ltr.querySelector("svg.lucide-arrow-right")).toBeTruthy();
  });
});
