/**
 * SCRUM-417 UX PR 5 -- S7 (success waits for the read model), O4 (phone: step
 * first, rail folded behind a "Step N of M" bar), S6 (locale dates) and the
 * SCRUM-468 count ("stage 8 of 7") on the surfaces that print it.
 *
 * Rendered through the real container with a controllable read model, so a
 * "success" is judged against what the screen shows, not against a promise.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";
import { deriveDealStages } from "@/convex/utils/financingEconomics";
import type { DealStageFacts } from "@/convex/utils/financingEconomics";

const language = vi.hoisted(() => ({ locale: "en" as "ar" | "en" }));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: language.locale === "ar", locale: language.locale }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "JD",
    displayLabel: "Jordanian Dinar",
    format: (n: number) => `JD ${n}`,
    formatCompact: (n: number) => String(n),
    scale: 3,
  }),
}));

vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: () => 3,
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  permissions: new Set<string>(),
  mutationCalls: new Map<string, unknown[]>(),
  mutationFailures: new Map<string, string>(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.has(permission),
    isLoading: false,
    membership: { userId: "user_manager" },
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const { ConvexError } = await import("convex/values");
  return {
    useQuery: (reference: never, args: unknown) =>
      args === "skip" ? undefined : stubs.queryResults.get(getFunctionName(reference)),
    useQueries: (queries: Record<string, { query: never }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query }]) => [key, stubs.queryResults.get(getFunctionName(query))])
      ),
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      return async (args: unknown) => {
        const calls = stubs.mutationCalls.get(name) ?? [];
        calls.push(args);
        stubs.mutationCalls.set(name, calls);
        const failure = stubs.mutationFailures.get(name);
        if (failure !== undefined) {
          stubs.mutationFailures.delete(name);
          throw new ConvexError(failure);
        }
        return null;
      };
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: stubs.toastSuccess, error: stubs.toastError },
}));

import { DealCockpit } from "./DealCockpit";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { nextOutstandingDocument } from "./recordedFeedback";
import { formatLocalized } from "@/lib/dateLocale";

const { queryResults, permissions, mutationCalls } = stubs;
const ORG = "org1" as Id<"organizations">;
const APP = "app_2048" as Id<"financeApplications">;
const COCKPIT = "dealWorkspace:financedDealCockpit";
const GET = "applications:get";
const DOCUMENTS = "documents:getPanelForApplication";

const facts = (overrides: Partial<DealStageFacts>): DealStageFacts => ({
  status: "APPROVED",
  creditDecision: "APPROVED",
  appraisalStatus: "FINALIZED",
  approvedDealerPurchaseAmountMinor: 12_500_000,
  documentRulesApply: true,
  requiredDocumentsComplete: true,
  ...overrides,
});

function setDeal(overrides: Partial<DealStageFacts>, extra: Record<string, unknown> = {}) {
  queryResults.set(COCKPIT, {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status: overrides.status ?? "APPROVED",
    // Midday UTC: the dates render in the runner's local zone, and midnight
    // UTC is the previous day anywhere west of Greenwich.
    createdAt: Date.UTC(2026, 6, 28, 12, 0),
    updatedAt: Date.UTC(2026, 7, 9, 12, 0),
    customer: { id: "c1", name: "Sami", phone: "0790112233" },
    vehicle: null,
    salespersonName: "Layth",
    financeCompanyName: "",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    expectedPaymentRegistered: false,
    supplierSettlementRouteRequired: false,
    stages: deriveDealStages(facts(overrides)),
    documents: [],
    timeline: [],
    money: null,
    ...extra,
  });
  queryResults.set(GET, {
    _id: APP,
    quoteId: "quote_1",
    status: overrides.status ?? "APPROVED",
    salespersonId: "user_sales",
    companyId: "company_1",
    economicsCurrency: "JOD",
    quote: { totalFinancedAmount: 15000 },
    vehicle: { sourceType: "OWNED" },
    deposits: [],
    hasExternalFinancier: true,
    canSettleDirectToSupplier: false,
    directRouteRefusal: null,
  });
}

const ui = () => <DealCockpit orgId={ORG} applicationId={APP} />;

beforeEach(() => {
  language.locale = "en";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  queryResults.clear();
  permissions.clear();
  mutationCalls.clear();
  stubs.mutationFailures.clear();
  stubs.toastSuccess.mockClear();
  stubs.toastError.mockClear();
});

const line = () => screen.queryByTestId("deal-recorded-feedback");

describe("S7 -- the success line waits for the read model", () => {
  async function markUnderReview() {
    permissions.add(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
    setDeal({ status: "PENDING_DOCS", creditDecision: undefined, appraisalStatus: undefined });
    const view = render(ui());
    fireEvent.click(within(screen.getByTestId("deal-next-step")).getByRole("button", { name: "MarkUnderReview" }));
    await waitFor(() => expect(mutationCalls.get("applications:updateStatus")).toHaveLength(1));
    return view;
  }

  test("nothing is said while the screen still shows the old state; the line appears once it moves", async () => {
    const view = await markUnderReview();
    // The mutation resolved, the query has not moved: no success, no toast.
    expect(line()).toBeNull();
    expect(stubs.toastSuccess).not.toHaveBeenCalled();

    setDeal({ status: "UNDER_REVIEW", creditDecision: undefined, appraisalStatus: undefined });
    view.rerender(ui());

    const shown = screen.getByTestId("deal-recorded-feedback");
    expect(shown.textContent).toContain("RecordedLead");
    expect(shown.textContent).toContain("RecordedNextPrefix");
    // Spoken through the existing live region, not a second one.
    expect(screen.getByTestId("deal-stage-view-announcer").textContent).toContain("RecordedLead");
    // It is a fact of the screen, not a toast: nothing timed, nothing to miss.
    expect(stubs.toastSuccess).not.toHaveBeenCalled();
    view.rerender(ui());
    expect(line()).not.toBeNull();
  });

  test("a refusal shows no success line and leaves the error surface as it was", async () => {
    permissions.add(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
    setDeal({ status: "PENDING_DOCS", creditDecision: undefined, appraisalStatus: undefined });
    stubs.mutationFailures.set("applications:updateStatus", "refused:not allowed");
    render(ui());
    fireEvent.click(within(screen.getByTestId("deal-next-step")).getByRole("button", { name: "MarkUnderReview" }));
    await waitFor(() => expect(stubs.toastError).toHaveBeenCalled());
    expect(line()).toBeNull();
    expect(stubs.toastSuccess).not.toHaveBeenCalled();
  });

  test("a committed change the screen never shows falls back to the old notice after 10s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await markUnderReview();
    expect(stubs.toastSuccess).not.toHaveBeenCalled();
    // Let the resolved mutation commit its held state (and arm the timer).
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(stubs.toastSuccess).toHaveBeenCalledTimes(1);
    expect(line()).toBeNull();
  });

  test("a document verify moves focus to the next outstanding document row", async () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.VERIFY_FINANCE_DOCUMENTS);
    const dealDocs = (first: string) => [
      { ruleId: "r1", name: "National ID", required: true, status: first },
      { ruleId: "r2", name: "Salary slip", required: true, status: "MISSING" },
    ];
    const rows = (first: string) => [
      { _id: "doc_1", ruleId: "r1", ruleName: "National ID", status: first, fileUrl: "https://files/x.pdf" },
      { _id: "doc_2", ruleId: "r2", ruleName: "Salary slip", status: "MISSING", fileUrl: null },
    ];
    setDeal({ status: "APPROVED" }, { documents: dealDocs("UPLOADED") });
    queryResults.set(DOCUMENTS, { active: rows("UPLOADED"), history: [] });
    const view = render(ui());
    const toggle = screen.queryByTestId("deal-details-toggle");
    if (toggle?.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);

    fireEvent.click(within(screen.getByTestId("deal-document-doc_1")).getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(mutationCalls.get("documents:updateDocumentStatus")).toHaveLength(1));
    expect(document.activeElement).not.toBe(screen.getByTestId("deal-document-doc_2"));

    setDeal({ status: "APPROVED" }, { documents: dealDocs("VERIFIED") });
    queryResults.set(DOCUMENTS, { active: rows("VERIFIED"), history: [] });
    view.rerender(ui());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("deal-document-doc_2")));
    expect(screen.getByTestId("deal-document-doc_2").getAttribute("data-rule-id")).toBe("r2");
  });

  test("S7-1: an UNRELATED document change does not release a pending verify; its own does", async () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.VERIFY_FINANCE_DOCUMENTS);
    const dealDocs = (first: string, second: string) => [
      { ruleId: "r1", name: "National ID", required: true, status: first },
      { ruleId: "r2", name: "Salary slip", required: true, status: second },
    ];
    const rows = (first: string, second: string) => [
      { _id: "doc_1", ruleId: "r1", ruleName: "National ID", status: first, fileUrl: "https://files/x.pdf" },
      { _id: "doc_2", ruleId: "r2", ruleName: "Salary slip", status: second, fileUrl: "https://files/y.pdf" },
    ];
    setDeal({ status: "APPROVED" }, { documents: dealDocs("UPLOADED", "UPLOADED") });
    queryResults.set(DOCUMENTS, { active: rows("UPLOADED", "UPLOADED"), history: [] });
    const view = render(ui());
    const toggle = screen.queryByTestId("deal-details-toggle");
    if (toggle?.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);

    fireEvent.click(within(screen.getByTestId("deal-document-doc_1")).getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(mutationCalls.get("documents:updateDocumentStatus")).toHaveLength(1));

    // Someone else verifies the OTHER document: the read model moved, our fact did not.
    setDeal({ status: "APPROVED" }, { documents: dealDocs("UPLOADED", "VERIFIED") });
    queryResults.set(DOCUMENTS, { active: rows("UPLOADED", "VERIFIED"), history: [] });
    view.rerender(ui());
    expect(line()).toBeNull();

    setDeal({ status: "APPROVED" }, { documents: dealDocs("VERIFIED", "VERIFIED") });
    queryResults.set(DOCUMENTS, { active: rows("VERIFIED", "VERIFIED"), history: [] });
    view.rerender(ui());
    expect(line()).not.toBeNull();
  });

  test("dismissing the line puts focus on the step heading and says nothing new", async () => {
    const view = await markUnderReview();
    setDeal({ status: "UNDER_REVIEW", creditDecision: undefined, appraisalStatus: undefined });
    view.rerender(ui());
    const announcer = screen.getByTestId("deal-stage-view-announcer");
    expect(announcer.textContent).toContain("RecordedLead");
    fireEvent.click(screen.getByTestId("deal-recorded-feedback-dismiss"));
    expect(line()).toBeNull();
    const heading = document.activeElement as HTMLElement;
    expect(heading.tagName).toBe("H2");
    expect(screen.getByTestId("deal-next-step").contains(heading)).toBe(true);
    expect(announcer.textContent).toBe("");
  });

  test("leaving the cockpit while a success is still held says it (nothing swallowed by the unmount)", async () => {
    const view = await markUnderReview();
    await act(async () => {
      await Promise.resolve();
    });
    expect(stubs.toastSuccess).not.toHaveBeenCalled();
    view.unmount();
    expect(stubs.toastSuccess).toHaveBeenCalledTimes(1);
  });

  // The recorded line is judged against a deal whose SHAPE changed under it: the
  // credit predicate reads `applications:get`, the line's wording reads the stages.
  async function recordedOn(stages: (base: ReturnType<typeof deriveDealStages>) => ReturnType<typeof deriveDealStages>) {
    const view = await markUnderReview();
    setDeal({ status: "UNDER_REVIEW", creditDecision: undefined, appraisalStatus: undefined });
    const cockpit = queryResults.get(COCKPIT) as { stages: ReturnType<typeof deriveDealStages> };
    queryResults.set(COCKPIT, { ...cockpit, stages: stages(cockpit.stages) });
    view.rerender(ui());
    return view;
  }
  const stopped = (base: ReturnType<typeof deriveDealStages>) => base.map((stage) => ({ ...stage, state: "STOPPED" as const }));
  const complete = (base: ReturnType<typeof deriveDealStages>) => base.map((stage) => ({ ...stage, state: "COMPLETE" as const }));

  test("N1: a stopped deal never says 'nothing left to do' -- work (held deposits) may remain", async () => {
    await recordedOn(stopped);
    const shown = screen.getByTestId("deal-recorded-feedback");
    expect(shown.textContent).toContain("RecordedLead");
    expect(shown.textContent).not.toContain("RecordedAllDone");
    expect(shown.textContent).not.toContain("RecordedNextPrefix");
    expect(screen.getByTestId("deal-stage-view-announcer").textContent).not.toContain("RecordedAllDone");
  });

  test("N1 control: a finished deal still says there is nothing left to do", async () => {
    await recordedOn(complete);
    expect(screen.getByTestId("deal-recorded-feedback").textContent).toContain("RecordedAllDone");
  });

  test("R2-3: dismissing on a finished deal lands on a real control, never <body>", async () => {
    await recordedOn(complete);
    fireEvent.click(screen.getByTestId("deal-recorded-feedback-dismiss"));
    expect(line()).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTestId("deal-stages-toggle"));
  });

  test("R2-3: dismissing on a stopped deal lands on the stopped notice, never <body>", async () => {
    await recordedOn(stopped);
    fireEvent.click(screen.getByTestId("deal-recorded-feedback-dismiss"));
    expect(line()).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByTestId("deal-stopped"));
  });

  test("nextOutstandingDocument skips the handled, verified and waived rows and wraps", () => {
    const docs = [
      { ruleId: "a", required: true, status: "UPLOADED" },
      { ruleId: "b", required: true, status: "VERIFIED" },
      { ruleId: "c", required: false, status: "MISSING" },
      { ruleId: "d", required: true, status: "WAIVED" },
    ];
    expect(nextOutstandingDocument(docs, "a")).toBeUndefined();
    expect(nextOutstandingDocument(docs, "b")).toBe("a");
    expect(nextOutstandingDocument([...docs, { ruleId: "e", required: true, status: "MISSING" }], "a")).toBe("e");
  });

});

describe("O4 -- on a phone the step comes first and the rail folds", () => {
  test("a 'Step N of M' bar toggles the rail, and the identity strip yields to the step", () => {
    setDeal({});
    render(ui());
    const bar = screen.getByTestId("deal-mobile-stepbar");
    expect(bar.className).toContain("md:hidden");
    const toggle = screen.getByTestId("deal-mobile-rail-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    // Folded below md, always shown from md: desktop is unchanged.
    expect(panel!.className).toContain("hidden");
    expect(panel!.className).toContain("md:block");
    expect(within(panel!).getByTestId("deal-stage-rail")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel!.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  test("R2-2: the identity strip is in the DOM where each breakpoint draws it, and the other copy is display:none", () => {
    setDeal({});
    render(ui());
    const step = screen.getByTestId("deal-next-step");
    const header = screen.getByTestId("deal-header");
    const rail = screen.getByTestId("deal-stage-rail");
    const desktop = screen.getByTestId("deal-identity");
    const phone = screen.getByTestId("deal-identity-mobile");
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    // md and up: right under the header, BEFORE the rail and the workbench -- no CSS `order` needed.
    expect(header.compareDocumentPosition(desktop) & FOLLOWING).toBeTruthy();
    expect(desktop.compareDocumentPosition(rail) & FOLLOWING).toBeTruthy();
    expect(desktop.compareDocumentPosition(step) & FOLLOWING).toBeTruthy();
    expect(desktop.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(desktop.className).toContain("md:grid");
    expect(desktop.className).not.toMatch(/order-/);
    // Below md: after the step, as before; hidden from md up.
    expect(step.compareDocumentPosition(phone) & FOLLOWING).toBeTruthy();
    expect(phone.className).toContain("md:hidden");
    expect(phone.className).not.toMatch(/order-/);
    // Both name the same landmark, and only the visible one is ever reachable.
    expect(desktop.getAttribute("aria-label")).toBe(phone.getAttribute("aria-label"));
    expect(desktop.textContent).toBe(phone.textContent);
  });

  test("viewing a step other than the live one says so in the phone bar", () => {
    setDeal({});
    render(ui());
    expect(screen.queryByTestId("deal-mobile-step-viewing")).toBeNull();
    const rail = screen.getByTestId("deal-stage-rail");
    const other = within(rail).getAllByRole("button").find((b) => b.getAttribute("aria-current") !== "step");
    expect(other, "the rail has a step other than the current one").toBeDefined();
    fireEvent.click(other!);
    expect(screen.queryByTestId("deal-mobile-step-viewing")?.textContent).toBe("MobileStepViewing");
  });

  test("the bar states the position as a sentence, current never above total", () => {
    setDeal({});
    render(ui());
    const position = screen.getByTestId("deal-mobile-step-position");
    expect(position.textContent).toBe("MobileStepLabel 6 StageOfSeparator 8");
  });
});

describe("SCRUM-468 -- the count never reads 'stage 8 of 7'", () => {
  test.each([
    ["credit", { status: "PENDING_DOCS", creditDecision: undefined, appraisalStatus: undefined }],
    ["approved", {}],
    ["handed over", { status: "CLOSED" }],
  ])("%s: each number is its own isolated run, joined by a word, and current <= total", (_name, overrides) => {
    setDeal(overrides as Partial<DealStageFacts>);
    render(ui());
    for (const scope of [screen.queryByTestId("deal-next-step"), screen.queryByTestId("deal-mobile-step-position")]) {
      if (!scope) continue;
      const runs = Array.from(scope.querySelectorAll("bdi")).map((node) => node.textContent ?? "");
      const [current, total] = runs.slice(0, 2).map(Number);
      expect(Number.isInteger(current) && Number.isInteger(total)).toBe(true);
      expect(current).toBeGreaterThanOrEqual(1);
      expect(current).toBeLessThanOrEqual(total);
      // No "n / m" run: the slash form is what Arabic read right to left.
      expect(runs.some((run) => run.includes("/"))).toBe(false);
      expect(scope.textContent).toContain("StageOfSeparator");
    }
  });
});

describe("S6 -- dates follow the screen language", () => {
  const ENGLISH_MONTH = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;

  test("Arabic: no English month name anywhere on the cockpit", () => {
    language.locale = "ar";
    setDeal({});
    render(ui());
    const text = document.body.textContent ?? "";
    expect(text).toContain("يوليو");
    expect(text).toContain("أغسطس");
    expect(text).not.toMatch(ENGLISH_MONTH);
  });

  test("English is unchanged", () => {
    setDeal({});
    render(ui());
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/28 Jul 2026/);
    expect(text).toMatch(/9 Aug 2026/);
  });

  test("formatLocalized changes only the language of the name, never the instant or the digits", () => {
    const at = Date.UTC(2026, 6, 28, 12, 0);
    expect(formatLocalized(at, "d MMM yyyy", "en")).toMatch(/^28 Jul 2026$/);
    expect(formatLocalized(at, "d MMM yyyy", "ar")).toBe("28 يوليو 2026");
    expect(formatLocalized(at, "d MMM yyyy", undefined)).toBe(formatLocalized(at, "d MMM yyyy", "en"));
  });
});
