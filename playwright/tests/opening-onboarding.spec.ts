import { expect, test } from "@playwright/test";
import { makeFunctionReference } from "convex/server";
import { api } from "../../convex/_generated/api";
import {
  assertNativeOpening, assertOpeningPayload, fillOpening, freshOpening,
  openingActors, openingFunctions, openingResult,
} from "../fixtures/openingOnboarding";

/**
 * SCRUM-858: these are real form -> browser wire -> native backend witnesses.
 * The trusted workflow already created/attested/seeded the disposable Preview;
 * the test checks its actual browser URL binding, not a new marker attestation.
 * Backend Preview egress sinks remain inherited. Only the PR trusted lane has
 * its extra browser proxy. Newly added tests first execute after merge into
 * trusted main; old-controller PR runs cannot certify this file.
 */
test.describe("opening onboarding against the attested workflow Preview", () => {
  test.describe.configure({ retries: 0 });

  test("owner opening form posts exact native allocations once", async ({ browser, baseURL }, info) => {
    test.setTimeout(180000);
    const actors = await openingActors(browser, baseURL);
    try {
      const fixture = await freshOpening(actors, "owner");
      const dialog = await fillOpening(actors.owner, fixture);
      await actors.ownerWire.guard();
      actors.owner.once("dialog", async confirmation => {
        expect(confirmation.type()).toBe("confirm"); await confirmation.accept();
      });
      await dialog.getByRole("button", { name: "Post opening balance", exact: true }).click();
      const receipt = await actors.ownerWire.successful(openingFunctions.direct);
      assertOpeningPayload(receipt, fixture);
      await expect(actors.owner.getByText("Opening balance recorded.", { exact: true })).toBeVisible();
      const before = await assertNativeOpening(actors, fixture, receipt.result);
      await actors.owner.reload(); await actors.ownerWire.guard();
      await expect(actors.owner.getByRole("button", { name: "Set opening balance", exact: true })).toHaveCount(0);
      // Explicit API replay is separate from the browser-origin opening above.
      await expect(actors.ownerClient.mutation(makeFunctionReference<"mutation">(openingFunctions.direct), receipt.args))
        .rejects.toThrow(/opening balance has already been posted|opening balance has already been recorded/i);
      expect(await assertNativeOpening(actors, fixture, receipt.result)).toEqual(before);
      await info.attach("opening-owner-native-proof.json", { contentType: "application/json",
        body: Buffer.from(JSON.stringify({ scope: "three synthetic allocation families; browser direct post plus API replay refusal",
          connection: receipt.connection, orgId: fixture.orgId, ...before })) });
    } finally { await actors.close(); }
  });

  test("finance opening form drafts for a different reviewer and posts once", async ({ browser, baseURL }, info) => {
    test.setTimeout(180000);
    const actors = await openingActors(browser, baseURL);
    try {
      const fixture = await freshOpening(actors, "review");
      const dialog = await fillOpening(actors.finance, fixture);
      await actors.financeWire.guard();
      await dialog.getByRole("button", { name: "Save for approval", exact: true }).click();
      const draftReceipt = await actors.financeWire.successful(openingFunctions.draft);
      assertOpeningPayload(draftReceipt, fixture);
      const pending = await actors.ownerClient.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: fixture.orgId });
      expect(pending).toHaveLength(1);
      expect(pending[0]._id).toBe(openingResult(draftReceipt.result).draftId);
      expect(pending[0].createdBy).toBe(fixture.financeId);
      expect(pending[0].lines.map(({ accountId, debitMinor, creditMinor }) => ({ accountId, debitMinor, creditMinor })))
        .toEqual(draftReceipt.args.lines);
      expect(pending[0].allocations).toEqual(draftReceipt.args.allocations);
      expect(fixture.financeId).not.toBe(fixture.ownerId);
      const entries = await actors.ownerClient.query(api.accountingLedger.listJournalEntries, {
        orgId: fixture.orgId, paginationOpts: { cursor: null, numItems: 10 },
      });
      expect(entries.isDone).toBe(true); expect(entries.page).toHaveLength(0);
      expect(await actors.ownerClient.query(api.subledger.listReceivables, { orgId: fixture.orgId, limit: 10 })).toHaveLength(0);
      expect(await actors.ownerClient.query(api.prepaidExpenses.listSchedules, { orgId: fixture.orgId })).toHaveLength(0);
      await expect(actors.finance.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
      await actors.owner.goto(`/${fixture.orgId}/accounting?section=settings`);
      await actors.ownerWire.guard();
      await expect(actors.owner.getByText("Opening balance awaiting your approval", { exact: true })).toBeVisible();
      await actors.owner.getByRole("button", { name: "Approve", exact: true }).click();
      const approval = await actors.ownerWire.successful(openingFunctions.approve);
      expect(approval.args).toEqual({ orgId: fixture.orgId, draftId: pending[0]._id });
      const posted = { ...openingResult(approval.result), draftId: pending[0]._id };
      const before = await assertNativeOpening(actors, fixture, posted);
      await actors.owner.reload(); await actors.ownerWire.guard();
      await expect(actors.owner.getByText("Opening balance recorded.", { exact: true })).toBeVisible();
      await expect(actors.ownerClient.mutation(api.accountingCutover.approveOpeningBalance, { orgId: fixture.orgId, draftId: pending[0]._id }))
        .rejects.toThrow(/already been resolved/i);
      expect(await assertNativeOpening(actors, fixture, posted)).toEqual(before);
      await info.attach("opening-review-native-proof.json", { contentType: "application/json",
        body: Buffer.from(JSON.stringify({ scope: "three synthetic allocation families; browser draft/different-reviewer approval plus API replay refusal",
          preparerConnection: draftReceipt.connection, reviewerConnection: approval.connection, orgId: fixture.orgId, ...before })) });
    } finally { await actors.close(); }
  });
});
