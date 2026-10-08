import { test, expect } from "@playwright/test";
import { gotoOrgRoute, resolveOrgId, authenticatedConvexClient } from "../utils";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * SCRUM-795 (SCRUM-50): manual journals are OFF for the narrowed pilot (owner
 * ruling SCRUM-760 c22474 / c22479). The former 10-step create/approve/GL-register
 * lifecycle cannot run with the switch on, so this spec now proves the OFF state:
 *   (i)  the UI shows the pilot notice and disables "New manual journal";
 *   (ii) the BACKEND refuses create and approve with MANUAL_JOURNALS_DISABLED.
 *
 * RETIRED (SCRUM-795 switch): steps 7-10 of the old lifecycle (GL register row,
 * accounting-date column, period label and line formatting of a MANUAL journal).
 * They need a posted manual journal, which no longer exists in this build. The
 * enabled behaviour stays proven at the backend level with the switch mocked off
 * (convex/manualJournalAccountingDate.test.ts, accountingPhase10.test.ts); the GL
 * register's rendering of posted entries is covered by the other accounting specs.
 * Re-enable the lifecycle when MANUAL_JOURNALS_PILOT_DISABLED is flipped to false.
 */
const REFUSAL_CODE = "MANUAL_JOURNALS_DISABLED";

function refusalCode(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && "code" in data) {
    return String((data as { code: unknown }).code);
  }
  return String((error as Error | null)?.message ?? "").includes(REFUSAL_CODE)
    ? REFUSAL_CODE
    : undefined;
}

test.describe("accounting workspace", () => {
  test("manual journals are off for the pilot: notice in the UI, refusal from the backend", async ({
    page,
  }) => {
    await gotoOrgRoute(page, "accounting");
    const orgId = (await resolveOrgId(page)) as Id<"organizations">;
    const client = await authenticatedConvexClient(page);

    await expect(page.getByRole("tab", { name: /overview/i }).first()).toBeVisible();

    // Navigate to Journal > Manual Journal.
    await page.getByRole("tab", { name: /journal/i }).first().click();
    await expect(page).toHaveURL(/section=journal/);
    const manualTab = page.getByRole("tab", { name: /manual journal/i }).first();
    await expect(manualTab).toBeVisible();
    await manualTab.click();

    // (i) UI: notice shown, creation disabled.
    await expect(page.getByTestId("manual-journals-pilot-off-notice")).toBeVisible();
    await expect(page.getByTestId("new-manual-journal-btn")).toBeDisabled();
    // Any legacy pending draft keeps Approve disabled; Reject is left to the owner.
    for (const approve of await page.getByTestId("approve-draft-btn").all()) {
      await expect(approve).toBeDisabled();
    }

    // (ii) Backend: create is refused with the coded reason, whatever the UI does.
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

    // Approve is refused before the draft is even looked up, so any draft id
    // shape-valid for the validator is refused; use the first pending one if any.
    const pending = (await client.query(api.financialAudit.listPendingManualJournals, {
      orgId,
    })) as Array<{ _id: Id<"manualJournalDrafts"> }>;
    if (pending.length > 0) {
      const approveError = await client
        .mutation(api.financialAudit.approveManualJournal, { orgId, draftId: pending[0]._id })
        .then(
          () => undefined,
          (e: unknown) => e
        );
      expect(approveError, "approve must be refused").toBeDefined();
      expect(refusalCode(approveError)).toBe(REFUSAL_CODE);
    }

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
