/**
 * SCRUM-795 item 1 (SCRUM-50) — manual journals are OFF for the pilot.
 *
 * Owner ruling SCRUM-760 c22474. This suite runs the build AS SHIPPED: the leaf
 * module is NOT mocked, so it fails if `MANUAL_JOURNALS_PILOT_DISABLED` is ever
 * flipped without a deliberate change here. The enabled-build control (the same
 * fixture succeeds when the switch is off) is
 * `manualJournalsPilotOffControl.scrum795.test.ts`.
 */
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { expectAppError } from "../test-utils/expectAppError";
import { seedManualJournalWorld } from "../test-utils/manualJournalPilotFixture";
import { MANUAL_JOURNALS_PILOT_DISABLED } from "./utils/pilotSwitches";
import { MANUAL_JOURNALS_DISABLED_MESSAGE } from "./utils/manualJournalContainment";
import { dictionaries } from "../lib/i18n/dictionaries";

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const ALL_TABLES = Object.keys(schema.tables);
const CODE = "MANUAL_JOURNALS_DISABLED";

describe("SCRUM-795 — manual journals are off in the shipped build", () => {
  test("the shipped default is ON", () => {
    expect(MANUAL_JOURNALS_PILOT_DISABLED).toBe(true);
  });

  test("createManualJournal is refused with the coded reason and changes nothing", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "off_create");
    const before = await dbSnapshot(w.t, ALL_TABLES);
    await expectAppError(
      w.asPoster.mutation(api.financialAudit.createManualJournal, {
        orgId: w.orgId,
        memo: "Should not be drafted",
        lines: w.lines,
        idempotencyKey: "off_create_1",
        accountingDate: Date.now(),
      }),
      CODE,
      MANUAL_JOURNALS_DISABLED_MESSAGE
    );
    expect(await dbSnapshot(w.t, ALL_TABLES)).toEqual(before);
  });

  test("a replay of an existing create key is refused too (the refusal precedes the idempotent lookup)", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "off_replay");
    // Resend the seeded draft's EXACT content, read back from the database.
    const seeded = await w.t.run((ctx) => ctx.db.get(w.legacyDraftId));
    expect(seeded).not.toBeNull();
    const before = await dbSnapshot(w.t, ALL_TABLES);
    await expectAppError(
      w.asPoster.mutation(api.financialAudit.createManualJournal, {
        orgId: w.orgId,
        memo: seeded!.memo,
        lines: seeded!.lines,
        idempotencyKey: seeded!.idempotencyKey,
        accountingDate: seeded!.accountingDate,
      }),
      CODE,
      MANUAL_JOURNALS_DISABLED_MESSAGE
    );
    expect(await dbSnapshot(w.t, ALL_TABLES)).toEqual(before);
  });

  test("approving an otherwise-approvable legacy pending draft is refused and posts nothing", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "off_approve");
    const before = await dbSnapshot(w.t, ALL_TABLES);
    await expectAppError(
      w.asReviewer.mutation(api.financialAudit.approveManualJournal, {
        orgId: w.orgId,
        draftId: w.legacyDraftId,
      }),
      CODE,
      MANUAL_JOURNALS_DISABLED_MESSAGE
    );
    expect(await dbSnapshot(w.t, ALL_TABLES)).toEqual(before);
    const draft = await w.t.run((ctx) => ctx.db.get(w.legacyDraftId));
    expect(draft?.status).toBe("PENDING_APPROVAL");
    expect(draft?.journalEntryId).toBeUndefined();
  });

  test("a second finance user can still reject the legacy draft", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "off_reject");
    await w.asReviewer.mutation(api.financialAudit.rejectManualJournal, {
      orgId: w.orgId,
      draftId: w.legacyDraftId,
      rejectionReason: "Pilot: manual journals are off",
    });
    const draft = await w.t.run((ctx) => ctx.db.get(w.legacyDraftId));
    expect(draft?.status).toBe("REJECTED");
    // Reading the pending list is unchanged and now empty.
    const pending = await w.asReviewer.query(api.financialAudit.listPendingManualJournals, {
      orgId: w.orgId,
    });
    expect(pending).toEqual([]);
  });

  test("listPendingManualJournals keeps its shape for a legacy draft", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "off_list");
    const pending = await w.asReviewer.query(api.financialAudit.listPendingManualJournals, {
      orgId: w.orgId,
    });
    expect(pending).toHaveLength(1);
    expect(Object.keys(pending[0]).sort()).toEqual(
      expect.arrayContaining(["_id", "memo", "lines", "createdBy", "creatorName", "accountingDate"])
    );
  });

  test("the refusal sits behind authentication: a caller without finance authority gets the auth error", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "off_auth");
    const unauth = await w.t
      .mutation(api.financialAudit.createManualJournal, {
        orgId: w.orgId,
        memo: "x",
        lines: w.lines,
        idempotencyKey: "off_auth_1",
        accountingDate: Date.now(),
      })
      .then(
        () => undefined,
        (e: unknown) => e as { data?: { code?: string }; message?: string }
      );
    expect(unauth).toBeDefined();
    expect(unauth?.data?.code).not.toBe(CODE);

    const unauthorised = await w.asSales
      .mutation(api.financialAudit.approveManualJournal, {
        orgId: w.orgId,
        draftId: w.legacyDraftId,
      })
      .then(
        () => undefined,
        (e: unknown) => e as { data?: { code?: string }; message?: string }
      );
    expect(unauthorised).toBeDefined();
    expect(unauthorised?.data?.code).not.toBe(CODE);
  });

  // Owner ruling SCRUM-795 c22479: the switch is EXACTLY create + approve. Both
  // opening-balance paths post a journal through the same GL machinery and must
  // keep working in the shipped build.
  async function openingLines(w: Awaited<ReturnType<typeof seedManualJournalWorld>>) {
    const accounts = await w.asPoster.query(api.chartOfAccounts.list, { orgId: w.orgId, activeOnly: true });
    const cash = accounts.find((a) => a.systemKey === "CASH_ON_HAND")!;
    const capital = accounts.find((a) => a.systemKey === "PARTNER_CAPITAL")!;
    return [
      { accountId: cash._id, debitMinor: 1_000_000, creditMinor: 0 },
      { accountId: capital._id, debitMinor: 0, creditMinor: 1_000_000 },
    ];
  }

  test("draftOpeningBalance then approveOpeningBalance still succeeds with the switch ON", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "off_ob_draft");
    const draft = await w.asPoster.mutation(api.accountingCutover.draftOpeningBalance, {
      orgId: w.orgId,
      expectedCurrency: "JOD",
      asOfDate: Date.now(),
      lines: await openingLines(w),
    });
    const result = await w.asReviewer.mutation(api.accountingCutover.approveOpeningBalance, {
      orgId: w.orgId,
      draftId: draft.draftId as Id<"openingBalanceDrafts">,
    });
    const journal = await w.t.run((ctx) => ctx.db.get(result.journalId as Id<"journalEntries">));
    expect(journal?.category).toBe("OPENING_BALANCE");
    expect(journal?.status).toBe("POSTED");
  });

  test("postOpeningBalanceDirect still succeeds for the owner with the switch ON", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "off_ob_direct");
    const result = await w.asOwner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId: w.orgId,
      expectedCurrency: "JOD",
      asOfDate: Date.now(),
      memo: "Cutover",
      lines: await openingLines(w),
    });
    const journal = await w.t.run((ctx) => ctx.db.get(result.journalId as Id<"journalEntries">));
    expect(journal?.category).toBe("OPENING_BALANCE");
    expect(journal?.status).toBe("POSTED");
  });

  test("the server text equals the English dictionary entry and Arabic exists (D8)", () => {
    const key = `ServerError_${CODE}`;
    expect((dictionaries.en as Record<string, string>)[key]).toBe(MANUAL_JOURNALS_DISABLED_MESSAGE);
    const ar = (dictionaries.ar as Record<string, string>)[key];
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toBe(MANUAL_JOURNALS_DISABLED_MESSAGE);
  });
});
