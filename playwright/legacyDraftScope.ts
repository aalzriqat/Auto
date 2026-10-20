// SCRUM-795: the approve-door proof picks the seeded legacy draft out of a
// pending-drafts read. A memo is not a tenant boundary, so every read must also
// prove the row belongs to the seeded org, and fail loudly otherwise.
export type PendingDraft = { _id: string; memo: string; createdBy: string; orgId: string };

export function assertDraftInOrg<T extends { orgId: string }>(draft: T, orgId: string, where: string): T {
  if (draft.orgId !== orgId) {
    throw new Error(
      `${where}: draft row belongs to org ${String(draft.orgId)}, not the seeded org ${orgId}`
    );
  }
  return draft;
}

/** First read: pick by memo, then require the seeded org. Undefined when absent. */
export function pickSeededDraft<T extends { memo: string; orgId: string }>(
  rows: T[],
  memo: string,
  orgId: string
): T | undefined {
  const row = rows.find((d) => d.memo === memo);
  return row ? assertDraftInOrg(row, orgId, "initial pending read") : undefined;
}

/** Read-back: the draft must still be pending, and still in the seeded org. */
export function assertStillPending<T extends { _id: string; orgId: string }>(
  rows: T[],
  draftId: string,
  orgId: string
): void {
  const row = rows.find((d) => d._id === draftId);
  if (!row) throw new Error("read-back: the seeded draft is no longer pending");
  assertDraftInOrg(row, orgId, "read-back pending read");
}
