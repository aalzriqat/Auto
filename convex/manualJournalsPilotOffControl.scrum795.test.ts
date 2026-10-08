/**
 * SCRUM-795 item 1 (SCRUM-50) — enabled-build CONTROL for the manual-journal
 * pilot switch.
 *
 * The leaf module is mocked to OFF so the SAME fixture used by
 * `manualJournalsPilotOff.scrum795.test.ts` must succeed here. Without this a
 * refusal proves nothing: it could equally be a broken fixture. It also proves
 * the switch is reversible — flipping the one constant restores today's behaviour.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { seedManualJournalWorld } from "../test-utils/manualJournalPilotFixture";
import { MANUAL_JOURNALS_PILOT_DISABLED } from "./utils/pilotSwitches";

vi.mock("./utils/pilotSwitches", async (importOriginal) => ({ ...(await importOriginal<typeof import("./utils/pilotSwitches")>()), MANUAL_JOURNALS_PILOT_DISABLED: false }));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

describe("SCRUM-795 control — the same fixtures succeed when the switch is off", () => {
  test("the mock took effect (otherwise this file proves nothing)", () => {
    expect(MANUAL_JOURNALS_PILOT_DISABLED).toBe(false);
  });

  test("create then approve posts a journal entry", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "on_create");
    const created = await w.asPoster.mutation(api.financialAudit.createManualJournal, {
      orgId: w.orgId,
      memo: "Enabled build",
      lines: w.lines,
      idempotencyKey: "on_create_1",
      accountingDate: Date.now(),
    });
    expect(created.alreadyCreated).toBe(false);
    await w.asReviewer.mutation(api.financialAudit.approveManualJournal, {
      orgId: w.orgId,
      draftId: created.draftId,
    });
    const draft = await w.t.run((ctx) => ctx.db.get(created.draftId));
    expect(draft?.status).toBe("POSTED");
    expect(draft?.journalEntryId).toBeDefined();
  });

  test("the seeded legacy pending draft is approvable by a second finance user", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "on_approve");
    await w.asReviewer.mutation(api.financialAudit.approveManualJournal, {
      orgId: w.orgId,
      draftId: w.legacyDraftId,
    });
    const draft = await w.t.run((ctx) => ctx.db.get(w.legacyDraftId));
    expect(draft?.status).toBe("POSTED");
    const entries = await w.t.run((ctx) => ctx.db.query("journalEntries").take(50));
    expect(entries.length).toBeGreaterThan(0);
  });

  test("the exact call that the default build refuses returns alreadyCreated with the seeded legacy draft", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "on_true_replay");
    const seeded = await w.t.run((ctx) => ctx.db.get(w.legacyDraftId));
    const replay = await w.asPoster.mutation(api.financialAudit.createManualJournal, {
      orgId: w.orgId,
      memo: seeded!.memo,
      lines: seeded!.lines,
      idempotencyKey: seeded!.idempotencyKey,
      accountingDate: seeded!.accountingDate,
    });
    expect(replay.alreadyCreated).toBe(true);
    expect(replay.draftId).toEqual(w.legacyDraftId);
  });

  test("an idempotent replay returns the existing draft", async () => {
    const w = await seedManualJournalWorld(MODULE_GLOB, "on_replay");
    const accountingDate = Date.now();
    const args = {
      orgId: w.orgId,
      memo: "Replay",
      lines: w.lines,
      idempotencyKey: "on_replay_1",
      accountingDate,
    };
    const first = await w.asPoster.mutation(api.financialAudit.createManualJournal, args);
    const second = await w.asPoster.mutation(api.financialAudit.createManualJournal, args);
    expect(second.alreadyCreated).toBe(true);
    expect(second.draftId).toEqual(first.draftId);
  });
});
