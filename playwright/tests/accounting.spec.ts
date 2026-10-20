import { test, expect, type Browser } from "@playwright/test";
import { newContainedContext } from "../containedContext";
import { gotoOrgRoute, APPROVER_AUTH_FILE, resolveOrgId, authenticatedConvexClient } from "../utils";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { assertStillPending, pickSeededDraft } from "../legacyDraftScope";

/**
 * SCRUM-795 (SCRUM-50): manual journals are OFF for the narrowed pilot (owner
 * ruling SCRUM-760 c22474 / c22479). This spec proves the OFF state on a REAL
 * backend:
 *   (i)  the UI shows the pilot notice, disables "New manual journal" and every
 *        "Approve", and leaves "Reject" enabled for a legacy pending draft;
 *   (ii) the backend refuses create AND approve with MANUAL_JOURNALS_DISABLED,
 *        and the seeded legacy draft is still pending afterwards.
 *
 * The legacy pending draft is seeded by the E2E bootstrap
 * (convex/e2eBootstrap.ts, seedLegacyManualJournalDraft) ONLY when the bootstrap
 * runs with E2E_SEED_LEGACY_MANUAL_JOURNAL=1, and that is requested ONLY by
 * trusted-main-e2e.yml (scripts/legacyManualJournalSeedScope.test.ts pins it).
 * Why nowhere else:
 *   - browser-attack-swarm.yml runs TRUSTED MAIN's bootstrap script against the
 *     CANDIDATE backend. After merge, a seed request would reach un-rebased PR
 *     backends whose args validator does not know the field and reject it,
 *     failing the bootstrap for every other lane; before merge, main's script
 *     cannot seed at all. Script and backend are the same version only in
 *     trusted-main-e2e (main push, main's backend, its own preview).
 *   - The accounting rehearsal preview must stay UNSEEDED: a pending manual
 *     draft blocks the period-close checklist, which would turn its case P1
 *     (close the only open period) UNPROVEN.
 * So the real-backend approve refusal is its own test, REGISTERED ONLY where the
 * flag is "1" (a missing draft FAILS there). In every other lane (candidate
 * swarm, PR lanes) it is not registered: not run, not skipped, NOT CLAIMED, and
 * those lanes prove only the UI state and the create refusal. In trusted-main
 * E2E a dropped flag cannot go green: scripts/assertApproveDoorRan.mjs reads the
 * Playwright JSON report and requires exactly one passed approve-door test.
 * The refusal is sent as the
 * approver seat (a different user from the draft's creator), so it is the pilot
 * switch and not separation of duties.
 *
 * RETIRED (SCRUM-795 switch): the former 10-step lifecycle, because the pilot
 * build cannot post a manual journal. Its steps 7-10 (the GL register row's
 * accounting date, the period label and the balanced debit/credit lines of a
 * POSTED journal) are NOT RUN and NOT CLAIMED by this spec. A replay through an
 * owner's opening balance needs a design that cannot write to a promoted
 * production deployment; that work is parked on branch claude/replay-parked.
 * The evidence for the declared-date and closed-period rules is the backend
 * tests with the switch mocked off: convex/manualJournalAccountingDate.test.ts
 * and convex/accountingPhase10.test.ts.
 */
const REFUSAL_CODE = "MANUAL_JOURNALS_DISABLED";
const LEGACY_MEMO = "E2E legacy pending draft (SCRUM-795)";
const LEGACY_SEEDED = process.env.E2E_SEED_LEGACY_MANUAL_JOURNAL === "1";

function refusalCode(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && "code" in data) {
    return String((data as { code: unknown }).code);
  }
  return String((error as Error | null)?.message ?? "").includes(REFUSAL_CODE)
    ? REFUSAL_CODE
    : undefined;
}

type Pending = Array<{
  _id: Id<"manualJournalDrafts">;
  memo: string;
  createdBy: Id<"users">;
  orgId: Id<"organizations">;
}>;

async function proveLegacyApproveRefused(browser: Browser, orgId: Id<"organizations">): Promise<void> {
  // (ii-b) approve of the seeded legacy draft is refused. MANDATORY where the draft is seeded.
  // Sent as the AUTHORIZED, DISTINCT reviewer (the approver seat), not as the
  // draft's creator, so the refusal is the pilot switch and nothing else.
  const approverContext = await newContainedContext(browser, { storageState: APPROVER_AUTH_FILE });
  try {
    const approverPage = await approverContext.newPage();
    await gotoOrgRoute(approverPage, "accounting");
    const approverClient = await authenticatedConvexClient(approverPage);

    const pending = (await approverClient.query(api.financialAudit.listPendingManualJournals, {
      orgId,
    })) as Pending;
    const seeded = pickSeededDraft(pending, LEGACY_MEMO, orgId);
    if (!seeded) {
      throw new Error(
        "fixture missing: e2e bootstrap did not seed the SCRUM-795 legacy draft (run the bootstrap with E2E_SEED_LEGACY_MANUAL_JOURNAL=1)"
      );
    }
    const approverMe = (await approverClient.query(api.users.getMe, {})) as { _id: Id<"users"> };
    expect(approverMe._id, "the approver must be a different user from the draft's creator").not.toBe(
      seeded.createdBy
    );

    const approveError = await approverClient
      .mutation(api.financialAudit.approveManualJournal, { orgId, draftId: seeded._id })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(approveError, "approve must be refused").toBeDefined();
    expect(refusalCode(approveError)).toBe(REFUSAL_CODE);

    // Nothing posted: the draft is still pending.
    const after = (await approverClient.query(api.financialAudit.listPendingManualJournals, {
      orgId,
    })) as Pending;
    assertStillPending(after, seeded._id, orgId);

    // (i-b) Reject stays enabled for a second finance user (the creator cannot
    // reject their own draft). Looked at, not clicked.
    await approverPage.getByRole("tab", { name: /journal/i }).first().click();
    await approverPage.getByRole("tab", { name: /manual journal/i }).first().click();
    const card = approverPage.locator(
      `[data-testid='manual-journal-draft-card'][data-memo='${LEGACY_MEMO}']`
    );
    await expect(card).toBeVisible();
    await expect(card.getByTestId("reject-draft-btn")).toBeEnabled();
    await expect(card.getByTestId("approve-draft-btn")).toBeDisabled();
  } finally {
    await approverContext.close();
  }
}

test.describe("accounting workspace", () => {
  test("manual journals are off for the pilot: notice in the UI, create refused by the backend", async ({
    page,
  }) => {
    await gotoOrgRoute(page, "accounting");
    const orgId = (await resolveOrgId(page)) as Id<"organizations">;
    const client = await authenticatedConvexClient(page);

    await expect(page.getByRole("tab", { name: /overview/i }).first()).toBeVisible();

    await page.getByRole("tab", { name: /journal/i }).first().click();
    await expect(page).toHaveURL(/section=journal/);
    const manualTab = page.getByRole("tab", { name: /manual journal/i }).first();
    await expect(manualTab).toBeVisible();
    await manualTab.click();

    // (i) UI as the creator: notice, New disabled, at least one Approve and all disabled.
    await expect(page.getByTestId("manual-journals-pilot-off-notice")).toBeVisible();
    await expect(page.getByTestId("new-manual-journal-btn")).toBeDisabled();
    if (LEGACY_SEEDED) {
      await expect(
        page.locator(`[data-testid='manual-journal-draft-card'][data-memo='${LEGACY_MEMO}']`)
      ).toBeVisible();
    }
    const approveButtons = await page.getByTestId("approve-draft-btn").all();
    if (LEGACY_SEEDED) {
      expect(approveButtons.length, "expected the seeded legacy draft's Approve button").toBeGreaterThanOrEqual(1);
    }
    for (const approve of approveButtons) {
      await expect(approve).toBeDisabled();
    }

    // (ii-a) create is refused by the backend whatever the UI does.
    const accounts = (await client.query(api.chartOfAccounts.list, { orgId })) as Array<{
      _id: Id<"chartOfAccounts">;
      allowManualPosting: boolean;
    }>;
    const manual = accounts.filter((a) => a.allowManualPosting);
    expect(manual.length).toBeGreaterThanOrEqual(2);
    const createError = await client
      .mutation(api.financialAudit.createManualJournal, {
        orgId,
        memo: `E2E manual journal refused ${Date.now()}`,
        accountingDate: Date.now(),
        idempotencyKey: `e2e-scrum795-${Date.now()}`,
        lines: [
          { accountId: manual[0]._id, debitMinor: 10_000, creditMinor: 0 },
          { accountId: manual[1]._id, debitMinor: 0, creditMinor: 10_000 },
        ],
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(createError, "create must be refused").toBeDefined();
    expect(refusalCode(createError)).toBe(REFUSAL_CODE);

    // (ii-b) the real-backend approve refusal is a SEPARATE test, registered
    // only when the seed flag is "1" (see the end of this file).

    // The rest of the accounting workspace still navigates.
    await page.getByRole("tab", { name: /receivables|claims/i }).first().click();
    await expect(page).toHaveURL(/section=receivables/);

    await page.getByRole("tab", { name: /cash|bank/i }).first().click();
    await expect(page).toHaveURL(/section=cash/);

    await page.getByRole("tab", { name: /settings|setup/i }).first().click();
    await expect(page).toHaveURL(/section=settings/);

    await expect(
      page.getByRole("heading", { name: /chart of accounts|accounting/i }).first()
    ).toBeVisible();
  });
});

// The approve-door proof exists ONLY in a lane that seeds the legacy draft. In
// every other lane this test is not registered, so it is neither run, skipped
// nor claimed (SCRUM-795). Where the flag is "1" a missing draft FAILS.
if (LEGACY_SEEDED) {
  test.describe("accounting workspace: legacy manual-journal draft (seeded lane only)", () => {
    test("approve of the seeded legacy draft is refused by the backend and the draft stays pending", async ({
      page,
      browser,
    }) => {
      await gotoOrgRoute(page, "accounting");
      const orgId = (await resolveOrgId(page)) as Id<"organizations">;
      await proveLegacyApproveRefused(browser, orgId);
    });
  });
}
