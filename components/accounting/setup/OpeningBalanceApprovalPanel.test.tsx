/**
 * SCRUM-52 — the opening-balance approval dead-end.
 *
 * The backend has always been able to approve or reject an opening-balance
 * draft (`accountingCutover.approveOpeningBalance` /
 * `rejectOpeningBalanceDraft`, and `listPendingOpeningBalanceDrafts` to find
 * one). Nothing in the product ever called them.
 *
 * The consequence was not cosmetic. `canPostDirectly` is `isOwner &&
 * canManageFinance`, so an ACCOUNTANT — the person whose job this is — is
 * routed to `draftOpeningBalance` and creates a PENDING_APPROVAL row. From that
 * moment `OpeningBalanceCard`'s `alreadyResolved` hides the "set opening
 * balance" button for EVERY role including the owner, and no screen could
 * approve the draft. The organization's GL then permanently starts from zero,
 * and only a developer running `convex run` could recover it.
 *
 * These tests render the panel that resolves it. They assert the BEHAVIOUR that
 * was missing — a reviewer can see the pending draft, see who prepared it, read
 * the lines they are being asked to approve, and act on it — rather than the
 * shape of the patch.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    // Identity `t` so a MISSING translation surfaces as its key instead of
    // silently rendering something plausible.
    t: (key: string) => key,
    isRtl: false,
    locale: "en" as const,
  }),
}));

// Currency-AWARE, matching the real helper for the currencies these tests use.
// A constant 3 would make every scale assertion pass by construction, which is
// exactly the class of defect a hardcoded ×1000 already caused elsewhere in
// this product.
vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: (code: string) => (["JOD", "KWD", "BHD", "OMR"].includes(code) ? 3 : 2),
  errorMessage: (error: unknown) => String(error),
}));

import {
  OpeningBalanceApprovalView,
  computeApprovalGate,
  type PendingOpeningBalanceDraft,
} from "./OpeningBalanceApprovalPanel";

const SCALE = 1_000; // JOD — 3 decimal places

function draftFixture(
  overrides: Partial<PendingOpeningBalanceDraft> = {}
): PendingOpeningBalanceDraft {
  return {
    _id: "obd_1",
    asOfDate: Date.UTC(2026, 6, 1),
    memo: "Cutover 1 July 2026",
    createdBy: "user_accountant",
    preparedByName: "Layla Haddad",
    currency: "JOD",
    denominationKnown: true,
    lines: [
      { accountId: "acc_bank", accountName: "Bank — Arab Bank", debitMinor: 10_000 * SCALE, creditMinor: 0 },
      { accountId: "acc_inv", accountName: "Vehicle Inventory", debitMinor: 90_000 * SCALE, creditMinor: 0 },
      { accountId: "acc_cap", accountName: "Owner Capital", debitMinor: 0, creditMinor: 100_000 * SCALE },
    ],
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("opening-balance approval panel", () => {
  test("renders nothing when there is no pending draft", () => {
    const { container } = render(
      <OpeningBalanceApprovalView
        draft={null}
        isOwnDraft={false}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    // A panel that shouts about an empty queue would be noise on the tab every
    // accounting user lands on first.
    // Plain DOM assertion on purpose: this repo's vitest.setup.ts does not
    // install jest-dom, and one test is not a reason to add a global matcher
    // dependency.
    expect(container.firstChild).toBeNull();
  });

  test("surfaces the pending draft, its preparer, and every line being approved", () => {
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture()}
        isOwnDraft={false}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );

    // Who prepared it is the whole basis of the segregation-of-duties decision.
    expect(screen.getByText(/Layla Haddad/)).toBeTruthy();

    // The reviewer must be able to read what they are approving. Approving
    // opaque account ids would make the two-person control theatre.
    const panel = screen.getByTestId("opening-balance-approval");
    expect(within(panel).getByText("Bank — Arab Bank")).toBeTruthy();
    expect(within(panel).getByText("Vehicle Inventory")).toBeTruthy();
    expect(within(panel).getByText("Owner Capital")).toBeTruthy();
  });

  test("approve and reject are both reachable for a reviewer who did not prepare it", () => {
    const onApprove = vi.fn();
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture()}
        isOwnDraft={false}
        busy={false}
        onApprove={onApprove}
        onReject={vi.fn()}
      />
    );

    const approve = screen.getByTestId("opening-balance-approve");
    expect(approve.hasAttribute("disabled")).toBe(false);
    expect(screen.getByTestId("opening-balance-reject").hasAttribute("disabled")).toBe(false);

    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  test("the preparer cannot approve their own draft, and is told why", () => {
    const onApprove = vi.fn();
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture()}
        isOwnDraft
        busy={false}
        onApprove={onApprove}
        onReject={vi.fn()}
      />
    );

    // Mirrors approveOpeningBalance's server-side refusal. The UI must not
    // offer an action the backend will reject — and must say why, or the user
    // reads a disabled button as the same dead-end this ticket is about.
    expect(screen.getByTestId("opening-balance-approve").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("opening-balance-reject").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("OpeningBalanceSegregationOfDutiesNotice")).toBeTruthy();
  });

  test("actions are disabled while a decision is in flight", () => {
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture()}
        isOwnDraft={false}
        busy
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    // Posting an opening balance twice is not recoverable in-product.
    expect(screen.getByTestId("opening-balance-approve").hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("opening-balance-reject").hasAttribute("disabled")).toBe(true);
  });

  test("a draft with no recorded currency is not approvable, and says why (Sonnet round 2)", () => {
    // Not hypothetical: `draftOpeningBalance` was already reachable from
    // OpeningBalanceCard before this panel existed, so every org whose
    // accountant hit the dead-end has a stranded draft in exactly this state —
    // and those are the orgs this panel is built for. approveOpeningBalance
    // refuses them server-side; the UI must not offer the click.
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture({ denominationKnown: false })}
        isOwnDraft={false}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    expect(screen.getByTestId("opening-balance-unknown-currency")).toBeTruthy();
    expect(screen.getByTestId("opening-balance-approve").hasAttribute("disabled")).toBe(true);
    // Reject must stay live, or the stranded draft becomes a second dead end.
    expect(screen.getByTestId("opening-balance-reject").hasAttribute("disabled")).toBe(false);
  });

  test("amounts render at the DRAFT's scale, which is the SCRUM-62 defect in miniature", () => {
    // The scaleForCurrency mock is currency-aware on purpose, but until now no
    // assertion depended on it — so a regression to a fixed scale, or to the
    // org's currency instead of the draft's, would have passed. CodeRabbit
    // caught that the guard was inert.
    const lines = [
      { accountId: "a1", accountName: "Bank", debitMinor: 1_000_000, creditMinor: 0 },
      { accountId: "a2", accountName: "Capital", debitMinor: 0, creditMinor: 1_000_000 },
    ];

    const { unmount } = render(
      <OpeningBalanceApprovalView
        draft={draftFixture({ currency: "JOD", lines })}
        isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()}
      />
    );
    // Scale 3. The identical minor units at scale 2 would read 10,000.00 —
    // exactly the 10x misstatement SCRUM-62 was about.
    expect(screen.getAllByText("1,000.000").length).toBeGreaterThan(0);
    unmount();

    render(
      <OpeningBalanceApprovalView
        draft={draftFixture({ currency: "USD", lines })}
        isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()}
      />
    );
    expect(screen.getAllByText("10,000.00").length).toBeGreaterThan(0);
  });

  test("an undenominated draft shows RAW minor units, not a fallback-currency amount", () => {
    // ChatGPT round-4 LOW: the query falls back to the org currency for a draft
    // that never recorded one, so formatting would render a historic JOD amount
    // at USD scale beside a line saying the denomination is unknown. Approval is
    // already fail-closed, so this misleads the human rather than the ledger.
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture({
          currency: "USD",
          denominationKnown: false,
          lines: [
            { accountId: "a1", accountName: "Bank", debitMinor: 1_000_000, creditMinor: 0 },
            { accountId: "a2", accountName: "Capital", debitMinor: 0, creditMinor: 1_000_000 },
          ],
        })}
        isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()}
      />
    );
    expect(screen.getAllByText("1000000").length).toBeGreaterThan(0);
    expect(screen.queryByText("10,000.00")).toBeNull();
  });

  test("an unbalanced draft is shown as unbalanced rather than silently approvable", () => {
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture({
          lines: [
            { accountId: "acc_bank", accountName: "Bank — Arab Bank", debitMinor: 10_000 * SCALE, creditMinor: 0 },
            { accountId: "acc_cap", accountName: "Owner Capital", debitMinor: 0, creditMinor: 9_000 * SCALE },
          ],
        })}
        isOwnDraft={false}
        busy={false}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />
    );
    // validateManualJournalLines throws on an unbalanced draft at approval
    // time. Letting the reviewer discover that by clicking Approve and reading
    // a red toast wastes the one decision this screen exists for.
    expect(screen.getByTestId("opening-balance-unbalanced")).toBeTruthy();
    expect(screen.getByTestId("opening-balance-approve").hasAttribute("disabled")).toBe(true);
  });
});

/**
 * The gate itself, exercised as a truth table.
 *
 * Round 3 stopped iterative patching here. Four independent booleans had been
 * bolted onto one button, each rendering its own advisory line, and the
 * combination nobody tested — the preparer viewing their own undenominated
 * draft — rendered "reject it and submit it again" directly above "you cannot
 * reject it yourself", with Reject disabled.
 *
 * These cases assert the COMBINATIONS, which is what one-flag-at-a-time tests
 * structurally could not.
 */
describe("computeApprovalGate", () => {
  const clean = { isOwnDraft: false, busy: false, balanced: true, denominationKnown: true };

  test("a clean draft for an eligible reviewer offers both actions and says nothing", () => {
    const gate = computeApprovalGate(clean);
    expect(gate.canApprove).toBe(true);
    expect(gate.canReject).toBe(true);
    expect(gate.blockingFacts).toHaveLength(0);
    // Silence is the correct output — a panel that always lectures is noise.
    expect(gate.recoveryKey).toBeNull();
  });

  test("THE ROUND-3 DEFECT: the preparer's own undenominated draft never tells them to reject it", () => {
    const gate = computeApprovalGate({ ...clean, isOwnDraft: true, denominationKnown: false });

    expect(gate.canApprove).toBe(false);
    // Segregation of duties gates BOTH actions server-side, so the UI must not
    // imply the preparer can reject.
    expect(gate.canReject).toBe(false);
    expect(gate.recoveryKey).toBe("OpeningBalanceOwnDraftNeedsAnotherReviewer");
    // The instruction they cannot follow must be absent, not merely outranked.
    expect(gate.recoveryKey).not.toBe("OpeningBalanceRejectAndResubmit");
    // The fact still shows — they should know WHY, just not be told to do the
    // impossible about it.
    expect(gate.blockingFacts.map((f) => f.key)).toContain("OpeningBalanceCurrencyUnknown");
  });

  test("the same draft seen by an eligible reviewer gets the actionable instruction", () => {
    const gate = computeApprovalGate({ ...clean, denominationKnown: false });
    expect(gate.canApprove).toBe(false);
    expect(gate.canReject).toBe(true);
    expect(gate.recoveryKey).toBe("OpeningBalanceRejectAndResubmit");
  });

  test("multiple blocking facts are all reported, with one instruction", () => {
    const gate = computeApprovalGate({ ...clean, balanced: false, denominationKnown: false });
    expect(gate.blockingFacts.map((f) => f.key)).toEqual([
      "OpeningBalanceUnbalanced",
      "OpeningBalanceCurrencyUnknown",
    ]);
    // Exactly one instruction regardless of how many facts apply — that is the
    // property that makes contradictory guidance unrepresentable.
    expect(gate.recoveryKey).toBe("OpeningBalanceRejectAndResubmit");
  });

  test("the preparer of an otherwise-clean draft still gets the segregation notice", () => {
    const gate = computeApprovalGate({ ...clean, isOwnDraft: true });
    expect(gate.recoveryKey).toBe("OpeningBalanceSegregationOfDutiesNotice");
    expect(gate.blockingFacts).toHaveLength(0);
  });

  test("busy blocks both actions without inventing a blocking fact", () => {
    const gate = computeApprovalGate({ ...clean, busy: true });
    expect(gate.canApprove).toBe(false);
    expect(gate.canReject).toBe(false);
    // In-flight is not a defect in the draft; claiming otherwise would show a
    // red line every time someone clicks.
    expect(gate.blockingFacts).toHaveLength(0);
    expect(gate.recoveryKey).toBeNull();
  });
});
