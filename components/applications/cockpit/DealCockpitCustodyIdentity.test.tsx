/**
 * The CONTAINER's command identity for the custody doors — issue, move,
 * close — exercised through `DealCockpit` itself with the Convex hooks mocked
 * per function (the `DealCockpitOverviewWiring` harness), asserting on the
 * `idempotencyKey` each attempt actually sends.
 *
 * R8 (Sonnet, HIGH): a key derived from the PAYLOAD (custody, kind, amount)
 * outlived the dialog attempt that minted it. A lost response kept it, the
 * operator cancelled, and a later GENUINE movement of the same amount reused
 * it — `runWithIdempotency` replayed the first result and the screen reported
 * a second success for cash that moved once. The identity is now a nonce
 * minted once per opened dialog attempt: retries of one attempt reuse it,
 * separate attempts differ, and abandoning an attempt retires it.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ConvexError } from "convex/values";
import type { Id } from "../../../convex/_generated/dataModel";
import { salesEn } from "@/lib/i18n/domains/sales";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    t: (key: string) => (salesEn as Record<string, string>)[key] ?? key,
    isRtl: false,
    locale: "en",
  }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "JD",
    displayLabel: "Jordanian Dinar",
    format: (n: number) => `JD ${n}`,
    scale: 3,
  }),
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  permissions: new Set<string>(),
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.has(permission),
    isLoading: false,
    membership: { userId: "user_owner" },
    isOwner: false,
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never) => stubs.queryResults.get(getFunctionName(reference)),
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      let fn = stubs.mutations.get(name);
      if (!fn) {
        fn = vi.fn(async () => "ok");
        stubs.mutations.set(name, fn);
      }
      return fn;
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { DealCockpit } from "./DealCockpit";
import { PERMISSIONS } from "@/convex/utils/permissions";

const { queryResults, mutations, permissions } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_9" as Id<"financeApplications">;
const COCKPIT_QUERY = "dealWorkspace:financedDealCockpit";
const APP_QUERY = "applications:get";
const COSTS_QUERY = "financeDealCosts:listDealCosts";
const CANDIDATES_QUERY = "financeDealCosts:listCustodyCandidates";
const MOVE = "financeDealCosts:recordCustodyMovement";
const OPEN = "financeDealCosts:openDealCustody";
const CLOSE = "financeDealCosts:reconcileDealCustody";

function cockpit() {
  return {
    dealKind: "FINANCED", dealRef: APP, applicationId: APP, saleId: null, canonicalSaleId: null,
    status: "APPROVED", createdAt: Date.UTC(2026, 6, 28), updatedAt: Date.UTC(2026, 7, 9),
    customer: null, vehicle: null, salespersonName: "", financeCompanyName: "",
    settlementAdviceRequiresReconciliation: false, settlementAdviceDiscrepancy: null,
    stages: [{ key: "HANDOVER", state: "CURRENT" }], documents: [], timeline: [], money: null,
    denomination: { code: "JOD", scale: 3 }, economicsRecorded: false, economicsStamp: "v2|0",
  };
}

function openRecord(settled = false) {
  return {
    _id: "cust1", userId: "user_rami", userName: "Rami", currency: "JOD", status: "OPEN",
    issuedMinor: 700_000, returnedMinor: settled ? 700_000 : 0, reimbursedMinor: 0, paidFeeIds: [],
    summary: {
      actualExpensesMinor: 0, employeeOwesDealerMinor: settled ? 0 : 700_000, reimbursementOutstandingMinor: 0,
      reimbursementOverpaidMinor: 0, overReturnedMinor: 0, settled,
    },
    summaryUnavailable: null,
  };
}

function costs(custody: unknown[], plannedCustody: unknown = null) {
  return {
    currency: "JOD",
    fees: [],
    summary: { lineCount: 0, estimatedTotalMinor: 0, actualTotalMinor: 0, dealerBorneActualMinor: 0, linesAwaitingActual: 0, linesAwaitingReconciliation: 0, fullyReconciled: false },
    summaryUnavailable: null,
    expected: {
      source: "NO_TEMPLATES", currency: "JOD", rows: [], expectedTotalMinor: null, actualTotalMinor: 0, differenceMinor: null, unplannedLineIds: [],
      adoption: { state: "COMPANY_HAS_NO_TEMPLATES", liveTemplateCount: 0, liveRuleVersion: 1, adopted: null },
    },
    custody,
    custodyTruncated: false,
    custodyAccounting: { ready: true },
    custodyPostsNow: true,
    plannedCustody,
    recommendedCustody: null,
    economicsFrozen: { frozen: false },
    accountingClassification: "PENDING_CLASSIFICATION",
  };
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  mutations.clear();
  permissions.clear();
});

function renderCockpit(custody: unknown[], plannedCustody: unknown = null) {
  permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
  permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  queryResults.set(COCKPIT_QUERY, cockpit());
  queryResults.set(APP_QUERY, { _id: APP, status: "APPROVED", salespersonId: "user_sales", economicsCurrency: "JOD", quote: null });
  queryResults.set(COSTS_QUERY, costs(custody, plannedCustody));
  queryResults.set(CANDIDATES_QUERY, { candidates: [{ userId: "u2", name: "Rami" }], truncated: false });
  return render(<DealCockpit orgId={ORG} applicationId={APP} />);
}

/** A mutation whose first `lost` calls get NO server answer (a transport failure) and which then succeeds. */
function lostThenOk(name: string, lost: number) {
  let calls = 0;
  const fn = vi.fn(async () => {
    calls += 1;
    if (calls <= lost) throw new Error("Failed to fetch");
    return "ok";
  });
  mutations.set(name, fn);
  return fn;
}

function alwaysOk(name: string) {
  const fn = vi.fn(async () => "ok");
  mutations.set(name, fn);
  return fn;
}

/** The single argument object the container sent on the mutation's `call`-th invocation. */
const argOf = (fn: ReturnType<typeof vi.fn>, call: number) => (fn.mock.calls[call] as unknown[])[0] as Record<string, unknown>;
const keyOf = (fn: ReturnType<typeof vi.fn>, call: number) => argOf(fn, call).idempotencyKey as string;

const panel = () => screen.getByTestId("deal-custody");

function openReturnDialog() {
  fireEvent.click(within(panel()).getByRole("button", { name: salesEn.CustodyRecordReturn }));
  return screen.getByTestId("custody-returned-dialog");
}
function submitReturn(dialog: HTMLElement, amount: string) {
  fireEvent.change(within(dialog).getByLabelText(/Amount/), { target: { value: amount } });
  fireEvent.click(within(dialog).getByTestId("custody-returned-submit"));
}
const cancel = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole("button", { name: salesEn.Cancel }));
const failureShown = (dialog: HTMLElement) => waitFor(() => expect(within(dialog).getByRole("alert")).toBeTruthy());

describe("a custody movement's command identity is one nonce per opened dialog attempt", () => {
  test("a lost response keeps the key for the SAME attempt's retry — even with a corrected amount, which the server judges by fingerprint", async () => {
    const move = lostThenOk(MOVE, 2);
    renderCockpit([openRecord()]);
    const dialog = openReturnDialog();
    submitReturn(dialog, "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    // The dialog is still open with the failure, and a verbatim retry replays.
    await failureShown(dialog);
    submitReturn(dialog, "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(2));
    expect(keyOf(move, 1)).toBe(keyOf(move, 0));
    // A changed amount in the SAME attempt is still the same command: if the
    // first request landed, the server refuses the changed intent under the
    // retained key rather than this screen minting a second payment.
    await failureShown(dialog);
    submitReturn(dialog, "150");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(3));
    expect(keyOf(move, 2)).toBe(keyOf(move, 0));
    expect(argOf(move, 2)).toMatchObject({ amountMinor: 150_000 });
  });

  test("two separate attempts with an identical payload are two commands", async () => {
    const move = alwaysOk(MOVE);
    renderCockpit([openRecord()]);
    submitReturn(openReturnDialog(), "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("custody-returned-dialog")).toBeNull());
    submitReturn(openReturnDialog(), "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(2));
    expect(keyOf(move, 1)).not.toBe(keyOf(move, 0));
  });

  test("abandoning an attempt after a lost response rotates the key: the next identical movement is a NEW command, never a silent replay", async () => {
    const move = lostThenOk(MOVE, 1);
    renderCockpit([openRecord()]);
    const first = openReturnDialog();
    submitReturn(first, "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    await failureShown(first);
    cancel(first);
    await waitFor(() => expect(screen.queryByTestId("custody-returned-dialog")).toBeNull());
    // The operator sees whether the return landed and records the genuine
    // next one for the same amount: a different command.
    submitReturn(openReturnDialog(), "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(2));
    expect(keyOf(move, 1)).not.toBe(keyOf(move, 0));
  });

  test("the server's own refusal ends the attempt's identity: the retry is a new command", async () => {
    let calls = 0;
    const move = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new ConvexError("A return cannot exceed what was issued.");
      return "ok";
    });
    mutations.set(MOVE, move);
    renderCockpit([openRecord()]);
    const dialog = openReturnDialog();
    submitReturn(dialog, "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    await failureShown(dialog);
    submitReturn(dialog, "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(2));
    expect(keyOf(move, 1)).not.toBe(keyOf(move, 0));
  });
});

/** A mutation whose calls settle only when the test says so — the request on the wire. */
function deferred(name: string) {
  const settlers: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const fn = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        settlers.push({ resolve, reject });
      })
  );
  mutations.set(name, fn);
  return Object.assign(fn, {
    /** Settles the `call`-th request as a transport failure (no server answer). */
    lose: (call: number) => settlers[call].reject(new Error("Failed to fetch")),
    /** Settles the `call`-th request as a success. */
    land: (call: number) => settlers[call].resolve("ok"),
  });
}

/** Every route the dialog primitive would dismiss on, driven while the request is on the wire. */
async function attemptEveryCloseRoute(dialog: HTMLElement) {
  // Escape: the primitive listens on the document; the key bubbles there.
  fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
  // The corner X: a Radix Close, which asks the root to close.
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  // Outside: the dismissable layer registers its pointer listener a tick after mounting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.pointerDown(document.body);
  fireEvent.pointerUp(document.body);
  fireEvent.click(document.body);
}

describe("a custody dialog whose command is in flight cannot be closed by any route (R9)", () => {
  test("movement: Escape, the X and an outside click are all refused while busy; the lost response keeps the SAME key for the retry; once settled the routes reopen and the next attempt is a NEW command", async () => {
    const move = deferred(MOVE);
    renderCockpit([openRecord()]);
    const dialog = openReturnDialog();
    submitReturn(dialog, "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    // In flight: every route refused, nothing retired, nothing re-sent.
    await attemptEveryCloseRoute(dialog);
    expect(screen.getByTestId("custody-returned-dialog")).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: salesEn.Cancel })).toHaveProperty("disabled", true);
    expect(within(dialog).getByTestId("custody-returned-submit")).toHaveProperty("disabled", true);
    expect(move).toHaveBeenCalledTimes(1);
    // The response is lost: the dialog stays open with the failure, the
    // identity survives, and the retry replays under it.
    move.lose(0);
    await failureShown(dialog);
    submitReturn(dialog, "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(2));
    expect(keyOf(move, 1)).toBe(keyOf(move, 0));
    // In flight again: still not closable.
    await attemptEveryCloseRoute(dialog);
    expect(screen.getByTestId("custody-returned-dialog")).toBe(dialog);
    expect(move).toHaveBeenCalledTimes(2);
    // Landed: the container closes it. A dialog opened afterwards is a new
    // attempt, so its command cannot replay the one that just moved cash.
    move.land(1);
    await waitFor(() => expect(screen.queryByTestId("custody-returned-dialog")).toBeNull());
    submitReturn(openReturnDialog(), "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(3));
    expect(keyOf(move, 2)).not.toBe(keyOf(move, 0));
  });

  test("the guard is scoped to the flight: once a lost response has settled, Escape closes the dialog and abandons the attempt, so the next identical movement is a new command", async () => {
    const move = deferred(MOVE);
    renderCockpit([openRecord()]);
    const dialog = openReturnDialog();
    submitReturn(dialog, "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    move.lose(0);
    await failureShown(dialog);
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("custody-returned-dialog")).toBeNull());
    submitReturn(openReturnDialog(), "100");
    await waitFor(() => expect(move).toHaveBeenCalledTimes(2));
    expect(keyOf(move, 1)).not.toBe(keyOf(move, 0));
  });

  test("closure and issuance: the same routes are refused in flight, and the identity survives a lost response", async () => {
    const close = deferred(CLOSE);
    renderCockpit([openRecord(true)]);
    fireEvent.click(within(panel()).getByRole("button", { name: salesEn.CustodyClose }));
    const closeDialog = screen.getByTestId("custody-close-dialog");
    fireEvent.change(within(closeDialog).getByLabelText(salesEn.CustodyCloseNotes), { target: { value: "matched" } });
    fireEvent.click(within(closeDialog).getByTestId("custody-close-submit"));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await attemptEveryCloseRoute(closeDialog);
    expect(screen.getByTestId("custody-close-dialog")).toBe(closeDialog);
    close.lose(0);
    await failureShown(closeDialog);
    fireEvent.click(within(closeDialog).getByTestId("custody-close-submit"));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(keyOf(close, 1)).toBe(keyOf(close, 0));
    close.land(1);
    await waitFor(() => expect(screen.queryByTestId("custody-close-dialog")).toBeNull());
    cleanup();
    queryResults.clear();

    const open = deferred(OPEN);
    renderCockpit([], { userId: "u2", userName: "Rami", amountMinor: 500_000, note: null });
    fireEvent.click(within(panel()).getByTestId("custody-issue-button"));
    const issueDialog = screen.getByTestId("custody-issued-dialog");
    fireEvent.click(within(issueDialog).getByTestId("custody-issued-submit"));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await attemptEveryCloseRoute(issueDialog);
    expect(screen.getByTestId("custody-issued-dialog")).toBe(issueDialog);
    open.lose(0);
    await failureShown(issueDialog);
    fireEvent.click(within(issueDialog).getByTestId("custody-issued-submit"));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(keyOf(open, 1)).toBe(keyOf(open, 0));
  });
});

describe("closing a custody record carries the same per-attempt identity", () => {
  function openCloseDialog() {
    fireEvent.click(within(panel()).getByRole("button", { name: salesEn.CustodyClose }));
    return screen.getByTestId("custody-close-dialog");
  }
  function submitClose(dialog: HTMLElement, notes: string) {
    fireEvent.change(within(dialog).getByLabelText(salesEn.CustodyCloseNotes), { target: { value: notes } });
    fireEvent.click(within(dialog).getByTestId("custody-close-submit"));
  }

  test("a lost response replays under the same key; an abandoned attempt does not leak its key into the next closure", async () => {
    const close = lostThenOk(CLOSE, 2);
    renderCockpit([openRecord(true)]);
    const first = openCloseDialog();
    submitClose(first, "matched");
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await failureShown(first);
    submitClose(first, "matched");
    await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(keyOf(close, 1)).toBe(keyOf(close, 0));
    cancel(first);
    await waitFor(() => expect(screen.queryByTestId("custody-close-dialog")).toBeNull());
    // Reopened and closed again later: a different closure, a different command.
    submitClose(openCloseDialog(), "matched");
    await waitFor(() => expect(close).toHaveBeenCalledTimes(3));
    expect(keyOf(close, 2)).not.toBe(keyOf(close, 0));
    expect(argOf(close, 2)).toMatchObject({ orgId: ORG, custodyId: "cust1", notes: "matched" });
  });
});

describe("issuing the deal's custody carries the same per-attempt identity", () => {
  function openIssueDialog() {
    fireEvent.click(within(panel()).getByTestId("custody-issue-button"));
    return screen.getByTestId("custody-issued-dialog");
  }

  test("a lost response replays under the same key; an abandoned attempt does not leak its key into the next issuance to the same person", async () => {
    // The plan pre-selects the recipient and the amount, so the dialog is
    // submittable as opened.
    const open = lostThenOk(OPEN, 2);
    renderCockpit([], { userId: "u2", userName: "Rami", amountMinor: 500_000, note: null });
    const first = openIssueDialog();
    fireEvent.click(within(first).getByTestId("custody-issued-submit"));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(argOf(open, 0)).toMatchObject({ orgId: ORG, applicationId: APP, userId: "u2", issuedMinor: 500_000 });
    await failureShown(first);
    fireEvent.click(within(first).getByTestId("custody-issued-submit"));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(keyOf(open, 1)).toBe(keyOf(open, 0));
    cancel(first);
    await waitFor(() => expect(screen.queryByTestId("custody-issued-dialog")).toBeNull());
    fireEvent.click(within(openIssueDialog()).getByTestId("custody-issued-submit"));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(3));
    expect(keyOf(open, 2)).not.toBe(keyOf(open, 0));
  });
});
