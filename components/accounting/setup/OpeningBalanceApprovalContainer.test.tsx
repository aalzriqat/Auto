/**
 * The data-fetching half of the opening-balance approval panel.
 *
 * Round-1 adversarial review (Codex + Sonnet, independently) found three
 * defects that ALL lived in the container, and none of the six tests written
 * with the original fix could see any of them — every one rendered the pure
 * `OpeningBalanceApprovalView` directly. Sonnet's structural point was the
 * useful one: a presentational test proves the markup is right and says
 * nothing about whether the component is allowed to ask for the data, or what
 * it does before the data arrives.
 *
 * These tests exercise the container, and each one goes red against the
 * pre-fix implementation.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: (code: string) => (["JOD", "KWD", "BHD", "OMR"].includes(code) ? 3 : 2),
  errorMessage: (error: unknown) => String(error),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  /** functionName -> args it was called with, so "did it skip?" is assertable. */
  queryArgs: new Map<string, unknown>(),
  /**
   * Function names that reproduce the server's permission refusal when called
   * with real arguments. Convex's `useQuery` re-throws a server error during
   * render (node_modules/convex/dist/.../react/client.js), which is what took
   * the entire Setup tab to the dashboard error boundary.
   */
  throwOnRealArgs: new Set<string>(),
  /**
   * Stable per-function mutation spies. `useMutation: () => vi.fn()` returned a
   * FRESH spy on every render, so no test could inspect a call — a wrong
   * draftId or a dropped rejectionReason would have passed every test here and
   * failed only in production. CodeRabbit caught this.
   */
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryArgs.set(name, args);
      if (args !== "skip" && stubs.throwOnRealArgs.has(name)) {
        throw new Error(`Unauthorized: missing permission manage:finance (${name})`);
      }
      if (args === "skip") return undefined;
      return stubs.queryResults.get(name);
    },
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      let spy = stubs.mutations.get(name);
      if (!spy) {
        spy = vi.fn().mockResolvedValue({ journalId: "je_1" });
        stubs.mutations.set(name, spy);
      }
      return spy;
    },
  };
});

const { queryResults, queryArgs, throwOnRealArgs, mutations } = stubs;

import { OpeningBalanceApprovalPanel } from "./OpeningBalanceApprovalPanel";

const ORG = "org1" as Id<"organizations">;
const SCALE = 1_000;
const DRAFTS = "accountingCutover:listPendingOpeningBalanceDrafts";
const ACCOUNTS = "chartOfAccounts:list";
const ME = "users:getMe";

function pendingDraft() {
  return [
    {
      _id: "obd_1",
      asOfDate: Date.UTC(2026, 6, 1),
      memo: "Cutover",
      createdBy: "user_accountant",
      preparedByName: "Layla Haddad",
      currency: "JOD",
      denominationKnown: true,
      lines: [
        { accountId: "a1", debitMinor: 10_000 * SCALE, creditMinor: 0 },
        { accountId: "a2", debitMinor: 0, creditMinor: 10_000 * SCALE },
      ],
    },
  ];
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  queryArgs.clear();
  throwOnRealArgs.clear();
  mutations.clear();
});

describe("opening-balance approval container", () => {
  test("a VIEW_FINANCE-only user does not crash the Setup tab (CX-2 / Sonnet-1)", () => {
    // `listPendingOpeningBalanceDrafts` requires MANAGE_FINANCE, but the whole
    // Accounting route is gated on `view:finance` and roles are customizable
    // per-org — a read-only bookkeeper is a supported configuration. Before the
    // fix the container called the query unconditionally and the thrown server
    // error replaced the entire dashboard content area, every visit.
    throwOnRealArgs.add(DRAFTS);
    queryResults.set(DRAFTS, pendingDraft());

    expect(() =>
      render(<OpeningBalanceApprovalPanel orgId={ORG} canManageFinance={false} />)
    ).not.toThrow();
  });

  test("without MANAGE_FINANCE every query is skipped, not merely ignored (CX-2)", () => {
    render(<OpeningBalanceApprovalPanel orgId={ORG} canManageFinance={false} />);

    // Asserting "skip" rather than "rendered nothing": a container that still
    // issued the request and discarded the result would look identical on
    // screen while continuing to crash for the very users this protects.
    expect(queryArgs.get(DRAFTS)).toBe("skip");
    expect(queryArgs.get(ACCOUNTS)).toBe("skip");
    expect(queryArgs.get(ME)).toBe("skip");
  });

  test("with MANAGE_FINANCE the queries are actually issued", () => {
    queryResults.set(DRAFTS, []);
    render(<OpeningBalanceApprovalPanel orgId={ORG} canManageFinance />);

    // The other half of the gate — a fix that skipped unconditionally would
    // pass the test above and silently disable the whole feature.
    expect(queryArgs.get(DRAFTS)).toEqual({ orgId: ORG });
  });

  test("approve is held until the account list resolves (CX-3 / Sonnet-2)", () => {
    queryResults.set(DRAFTS, pendingDraft());
    queryResults.set(ME, { _id: "user_owner" });
    // chartOfAccounts.list deliberately left undefined — still loading.

    render(<OpeningBalanceApprovalPanel orgId={ORG} canManageFinance />);

    // While accounts are unresolved every line renders its raw account id.
    // Approving ids the reviewer cannot read is the rubber-stamp this panel
    // exists to prevent, and an opening balance cannot be un-posted.
    expect(screen.getByTestId("opening-balance-approve").hasAttribute("disabled")).toBe(true);
  });

  test("approve is held until the current user resolves (CX-3 / Sonnet-4)", () => {
    queryResults.set(DRAFTS, pendingDraft());
    queryResults.set(ACCOUNTS, [{ _id: "a1", name: "Bank" }, { _id: "a2", name: "Capital" }]);
    // users.getMe deliberately left undefined — still loading.

    render(<OpeningBalanceApprovalPanel orgId={ORG} canManageFinance />);

    // `isOwnDraft` computes false while `me` is undefined, so the PREPARER
    // would briefly be offered an action the backend refuses.
    expect(screen.getByTestId("opening-balance-approve").hasAttribute("disabled")).toBe(true);
  });

  test("a legacy draft with no recorded currency reaches the view as unapprovable", () => {
    // Sonnet round 2: the container built its `draft` object without
    // `denominationKnown`, so the server's refusal never reached the UI and
    // Approve stayed clickable for exactly the stranded drafts this panel
    // surfaces for the first time.
    const [draft] = pendingDraft();
    queryResults.set(DRAFTS, [{ ...draft, currency: "JOD", denominationKnown: false }]);
    queryResults.set(ACCOUNTS, [{ _id: "a1", name: "Bank" }, { _id: "a2", name: "Capital" }]);
    queryResults.set(ME, { _id: "user_owner" });

    render(<OpeningBalanceApprovalPanel orgId={ORG} canManageFinance />);

    expect(screen.getByTestId("opening-balance-unknown-currency")).toBeTruthy();
    expect(screen.getByTestId("opening-balance-approve").hasAttribute("disabled")).toBe(true);
  });

  function readyPanel() {
    queryResults.set(DRAFTS, pendingDraft());
    queryResults.set(ACCOUNTS, [{ _id: "a1", name: "Bank" }, { _id: "a2", name: "Capital" }]);
    queryResults.set(ME, { _id: "user_owner" });
    render(<OpeningBalanceApprovalPanel orgId={ORG} canManageFinance />);
  }

  test("approve reaches the server with the right identifiers", () => {
    readyPanel();
    fireEvent.click(screen.getByTestId("opening-balance-approve"));
    // A wrong draftId would have passed every previous test in this file,
    // because the old stub returned a fresh spy on each render.
    expect(mutations.get("accountingCutover:approveOpeningBalance")).toHaveBeenCalledWith({
      orgId: ORG,
      draftId: "obd_1",
    });
  });

  test("reject reaches the server with a trimmed, non-empty reason", () => {
    readyPanel();
    // Two-step by design: reveal the field, then confirm.
    fireEvent.click(screen.getByTestId("opening-balance-reject"));
    fireEvent.change(screen.getByTestId("opening-balance-reject-reason"), {
      target: { value: "  wrong figures  " },
    });
    fireEvent.click(screen.getByTestId("opening-balance-reject"));
    expect(mutations.get("accountingCutover:rejectOpeningBalanceDraft")).toHaveBeenCalledWith({
      orgId: ORG,
      draftId: "obd_1",
      rejectionReason: "wrong figures",
    });
  });

  test("an empty rejection reason never reaches the server", () => {
    readyPanel();
    fireEvent.click(screen.getByTestId("opening-balance-reject"));
    fireEvent.click(screen.getByTestId("opening-balance-reject"));

    expect(screen.getByTestId("opening-balance-reason-missing")).toBeTruthy();
    // The spy EXISTS (useMutation ran during render); what must not happen is a
    // call. Asserting undefined would have been asserting the wrong thing.
    expect(mutations.get("accountingCutover:rejectOpeningBalanceDraft")).not.toHaveBeenCalled();
  });

  test("once both resolve, a reviewer can act", () => {
    queryResults.set(DRAFTS, pendingDraft());
    queryResults.set(ACCOUNTS, [{ _id: "a1", name: "Bank" }, { _id: "a2", name: "Capital" }]);
    queryResults.set(ME, { _id: "user_owner" });

    render(<OpeningBalanceApprovalPanel orgId={ORG} canManageFinance />);

    // Guards that never open are indistinguishable from the dead-end this
    // whole ticket is about.
    expect(screen.getByTestId("opening-balance-approve").hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Bank")).toBeTruthy();
  });
});
