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

// Mutable so a test can switch to Arabic. `accountDisplayName` picks `nameAr`
// only when the locale is "ar", so a permanently-English mock would make the
// localized-account-name assertion unwritable.
const language = { locale: "en" as "en" | "ar" };

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    // Identity `t` so a MISSING translation surfaces as its key instead of
    // silently rendering something plausible.
    t: (key: string) => key,
    isRtl: language.locale === "ar",
    locale: language.locale,
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

/**
 * Renders a major-unit amount the way the component will, for THIS machine.
 *
 * `formatMinor` goes through `toLocaleString(undefined, ...)`, so the group and
 * decimal separators follow the runner's default locale: what reads "1,000.000"
 * on an en-US machine reads "1.000,000" on a de-DE one, and a hardcoded string
 * fails there for a reason that has nothing to do with the code. CodeRabbit
 * caught it.
 *
 * The `scale` argument stays HARDCODED at each call site on purpose. The scale
 * is the entire subject of the SCRUM-62 assertion — the same minor units read
 * at 3 vs 2 decimal places — so deriving it from the component would make the
 * test agree with whatever the component did and prove nothing. Only the
 * separators, which are environmental noise, are derived.
 */
function atScale(majorUnits: number, scale: number): string {
  return majorUnits.toLocaleString(undefined, {
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  });
}

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
      { accountId: "acc_bank", accountCode: "1010", accountName: "Bank — Arab Bank", debitMinor: 10_000 * SCALE, creditMinor: 0 },
      { accountId: "acc_inv", accountCode: "1400", accountName: "Vehicle Inventory", debitMinor: 90_000 * SCALE, creditMinor: 0 },
      { accountId: "acc_cap", accountCode: "3010", accountName: "Owner Capital", debitMinor: 0, creditMinor: 100_000 * SCALE },
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
    // Asserted per-cell rather than with getByText, because each cell now
    // renders `code — name` and getByText matches an element's whole content.
    const panel = screen.getByTestId("opening-balance-approval");
    const cells = [...panel.querySelectorAll("tbody tr")].map(
      (row) => row.querySelector("td")?.textContent ?? ""
    );
    expect(cells[0]).toContain("Bank — Arab Bank");
    expect(cells[0]).toContain("1010");
    expect(cells[1]).toContain("Vehicle Inventory");
    expect(cells[2]).toContain("Owner Capital");
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
      { accountId: "a1", accountCode: "1010", accountName: "Bank", debitMinor: 1_000_000, creditMinor: 0 },
      { accountId: "a2", accountCode: "3010", accountName: "Capital", debitMinor: 0, creditMinor: 1_000_000 },
    ];

    const { unmount } = render(
      <OpeningBalanceApprovalView
        draft={draftFixture({ currency: "JOD", lines })}
        isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()}
      />
    );
    // Scale 3. The identical minor units at scale 2 would read 10,000.00 —
    // exactly the 10x misstatement SCRUM-62 was about.
    expect(screen.getAllByText(atScale(1_000, 3)).length).toBeGreaterThan(0);
    unmount();

    render(
      <OpeningBalanceApprovalView
        draft={draftFixture({ currency: "USD", lines })}
        isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()}
      />
    );
    expect(screen.getAllByText(atScale(10_000, 2)).length).toBeGreaterThan(0);
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
            { accountId: "a1", accountCode: "1010", accountName: "Bank", debitMinor: 1_000_000, creditMinor: 0 },
            { accountId: "a2", accountCode: "3010", accountName: "Capital", debitMinor: 0, creditMinor: 1_000_000 },
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
            { accountId: "acc_bank", accountCode: "1010", accountName: "Bank — Arab Bank", debitMinor: 10_000 * SCALE, creditMinor: 0 },
            { accountId: "acc_cap", accountCode: "3010", accountName: "Owner Capital", debitMinor: 0, creditMinor: 9_000 * SCALE },
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

/**
 * Both defects below were invisible to every previous round — five adversarial
 * reviews, 57 passing tests and a green CI — and took about four seconds to see
 * once the panel was rendered in a browser. They are the same class the panel's
 * own account-name fallback already guards against: the reviewer is asked to
 * approve something they cannot fully read.
 */
describe("the reviewer can actually read what they are approving", () => {
  function headerCells() {
    const panel = screen.getByTestId("opening-balance-approval");
    const head = panel.querySelector("thead");
    if (!head) throw new Error("no <thead> — the amount columns are unlabelled");
    // Scoped to the header row rather than a global getByText: "Debit" and
    // "Credit" are short words and a global query would keep passing off any
    // other occurrence on the screen.
    return [...head.querySelectorAll("th")].map((th) => th.textContent?.trim());
  }

  test("the two amount columns are labelled debit and credit", () => {
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture()}
        isOwnDraft={false}
        busy={false}
        onApprove={() => {}}
        onReject={() => {}}
      />
    );
    // Order matters: this is the only thing telling the reviewer which side is
    // which, and the columns swap visually between LTR and RTL.
    expect(headerCells()).toEqual(["Account", "Debit", "Credit"]);
  });

  test("the scrollable lines region can be reached and named by a keyboard user", () => {
    // The table holds no focusable elements, so the scroll container only
    // enters the tab order if it says so itself — and WebKit, unlike Blink and
    // Gecko, will not focus an overflow container on its own. Without this a
    // keyboard-only Safari user tabs straight from the heading to Approve,
    // unable to reach columns that are clipped in exactly the undenominated
    // case the container exists for. Asserted as attributes because that IS
    // the contract; jsdom performs no layout, so the scrolling itself is
    // verified in a browser instead. Raised by Codex.
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture()}
        isOwnDraft={false}
        busy={false}
        onApprove={() => {}}
        onReject={() => {}}
      />
    );
    const panel = screen.getByTestId("opening-balance-approval");
    const table = panel.querySelector("table");
    const region = table?.closest("[role='region']");
    expect(region, "the table is not inside a named region").not.toBeNull();
    expect(region?.getAttribute("tabindex")).toBe("0");
    // An unnamed region is announced as just "region" and is worse than none.
    expect(region?.getAttribute("aria-label")).toBeTruthy();
    // And it must be the element that actually scrolls, not a bare wrapper.
    expect(region?.className).toContain("overflow-x-auto");
  });

  test("each line shows the account's unique code, not just a name", () => {
    // `name` is not unique — nothing stops an org having two accounts called
    // "Cash" — and the code is the identifier account creation enforces. The
    // preparer picks accounts as "code — name" in OpeningBalanceCard, so an
    // approver shown only the name is reading a different description of the
    // same thing. Raised by Codex.
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture({
          lines: [
            { accountId: "a1", accountCode: "1010", accountName: "Cash", debitMinor: 5_000, creditMinor: 0 },
            { accountId: "a2", accountCode: "1020", accountName: "Cash", debitMinor: 0, creditMinor: 5_000 },
          ],
        })}
        isOwnDraft={false}
        busy={false}
        onApprove={() => {}}
        onReject={() => {}}
      />
    );
    const panel = screen.getByTestId("opening-balance-approval");
    const rows = [...panel.querySelectorAll("tbody tr")].map((r) =>
      r.querySelector("td")?.textContent?.trim()
    );
    // Two accounts sharing a display name are told apart only by the code, so
    // asserting the codes is asserting the reviewer can distinguish the rows.
    expect(rows[0]).toContain("1010");
    expect(rows[1]).toContain("1020");
    expect(rows[0]).not.toBe(rows[1]);
  });

  test("an Arabic reviewer reads the Arabic account name", () => {
    // The approver is the second pair of eyes on the org's entire starting GL
    // position. Handing an Arabic-speaking reviewer an untranslated English
    // account name is the same failure as handing them a raw account id — the
    // thing the fallback below this already guards against.
    language.locale = "ar";
    try {
      render(
        <OpeningBalanceApprovalView
          draft={draftFixture({
            lines: [
              {
                accountId: "a1",
                accountCode: "1010",
                accountName: "Cash on hand",
                accountNameAr: "النقدية بالصندوق",
                debitMinor: 5_000,
                creditMinor: 0,
              },
              { accountId: "a2", accountCode: "3010", accountName: "Capital", debitMinor: 0, creditMinor: 5_000 },
            ],
          })}
          isOwnDraft={false}
          busy={false}
          onApprove={() => {}}
          onReject={() => {}}
        />
      );
      const panel = screen.getByTestId("opening-balance-approval");
      const first = panel.querySelector("tbody tr td")?.textContent ?? "";
      expect(first).toContain("النقدية بالصندوق");
      expect(first).not.toContain("Cash on hand");
      // An account with no Arabic name still falls back rather than blanking.
      const rows = [...panel.querySelectorAll("tbody tr")];
      expect(rows[1]?.querySelector("td")?.textContent).toContain("Capital");
    } finally {
      language.locale = "en";
    }
  });

  test("the amounts state the currency they are denominated in", () => {
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture()}
        isOwnDraft={false}
        busy={false}
        onApprove={() => {}}
        onReject={() => {}}
      />
    );
    // The label is a bare text node sharing the meta paragraph with the
    // preparer and the date, so it is asserted on that paragraph's text rather
    // than with getByText, which only matches an element's whole content.
    const meta = screen.getByTestId("opening-balance-meta");
    expect(meta.textContent).toContain("Currency");
    // The code itself is in its own <bdi> — a Latin currency code inside an
    // Arabic sentence is the same bidi hazard as the preparer's name.
    expect(within(meta).getByText("JOD").tagName).toBe("BDI");
  });

  test("the currency shown is the DRAFT's, not a fixed one", () => {
    // The whole of SCRUM-62 is that a draft's denomination and the org's
    // current currency can differ. A test that only ever saw JOD would pass
    // against a hardcoded label.
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture({ currency: "USD" })}
        isOwnDraft={false}
        busy={false}
        onApprove={() => {}}
        onReject={() => {}}
      />
    );
    const panel = screen.getByTestId("opening-balance-approval");
    expect(within(panel).getByText("USD")).toBeTruthy();
    expect(within(panel).queryByText("JOD")).toBeNull();
  });

  test("no currency is asserted when the draft never recorded one", () => {
    // `listPendingOpeningBalanceDrafts` falls back to the org's current
    // currency for these. Printing that fallback would state as fact the exact
    // thing the red line underneath says is unknown.
    render(
      <OpeningBalanceApprovalView
        draft={draftFixture({ denominationKnown: false })}
        isOwnDraft={false}
        busy={false}
        onApprove={() => {}}
        onReject={() => {}}
      />
    );
    const panel = screen.getByTestId("opening-balance-approval");
    expect(within(panel).queryByText("JOD")).toBeNull();
    expect(within(panel).queryByText("Currency")).toBeNull();
    // ...but the columns are still labelled — the reviewer has to read the
    // raw units to decide whether to reject.
    expect(headerCells()).toEqual(["Account", "Debit", "Credit"]);
  });
});
