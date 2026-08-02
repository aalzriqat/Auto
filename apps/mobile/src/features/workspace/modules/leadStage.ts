import { type MobileLeadStage } from "../../../convexApi";
import { type AppLocale } from "./moduleShared";

/**
 * Single source of truth for lead pipeline stages on mobile.
 *
 * Previously the leads screen advanced a lead one stage at a time through an
 * "Advance" button driven by a private `nextLeadStage()` walker. That hid the
 * pipeline, made moving backwards impossible, and cost N taps to move N
 * stages. Everything a stage selector needs — ordering, localized labels,
 * which stages close a lead, and the optimistic-write lifecycle — lives here
 * so it can be unit tested without mounting a screen.
 */

/** Working stages, in pipeline order. These do not close the lead. */
export const OPEN_LEAD_STAGES: readonly MobileLeadStage[] = [
  "NEW",
  "CONTACTED",
  "INTERESTED",
  "TEST_DRIVE",
  "NEGOTIATION",
  "RESERVED",
];

/**
 * Stages that take a lead out of the active pipeline. `leads.list` still
 * returns them, but `findOpenLead` on the backend treats WON/LOST as closed,
 * so landing on one is a consequential move and is confirmed before it fires.
 */
export const TERMINAL_LEAD_STAGES: readonly MobileLeadStage[] = ["WON", "LOST"];

/** Every stage the picker offers, in the order it presents them. */
export const LEAD_STAGES: readonly MobileLeadStage[] = [
  ...OPEN_LEAD_STAGES,
  ...TERMINAL_LEAD_STAGES,
];

const LEAD_STAGE_LABELS: Record<MobileLeadStage, Record<AppLocale, string>> = {
  NEW: { en: "New", ar: "جديد" },
  CONTACTED: { en: "Contacted", ar: "تم التواصل" },
  INTERESTED: { en: "Interested", ar: "مهتم" },
  TEST_DRIVE: { en: "Test drive", ar: "تجربة" },
  NEGOTIATION: { en: "Negotiation", ar: "تفاوض" },
  RESERVED: { en: "Reserved", ar: "محجوز" },
  WON: { en: "Won", ar: "ناجح" },
  LOST: { en: "Lost", ar: "خاسر" },
};

/**
 * Localized stage name. Falls back to the raw key rather than throwing, so a
 * stage added to the backend before mobile knows about it degrades to a
 * readable code instead of blanking the row.
 */
export function leadStageLabel(stage: MobileLeadStage, locale: AppLocale): string {
  return LEAD_STAGE_LABELS[stage]?.[locale] ?? stage;
}

export function isTerminalLeadStage(stage: MobileLeadStage): boolean {
  return TERMINAL_LEAD_STAGES.includes(stage);
}

/** Zero-based position in the pipeline; -1 for an unrecognized stage. */
export function leadStageIndex(stage: MobileLeadStage): number {
  return LEAD_STAGES.indexOf(stage);
}

export type LeadStageDirection = "forward" | "backward" | "same";

/**
 * Which way a move travels. Drives the sheet's accessibility hint so a screen
 * reader user hears "moves this lead back" rather than only a stage name.
 */
export function leadStageDirection(
  from: MobileLeadStage,
  to: MobileLeadStage,
): LeadStageDirection {
  const fromIndex = leadStageIndex(from);
  const toIndex = leadStageIndex(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return "same";
  return toIndex > fromIndex ? "forward" : "backward";
}

const LEAD_STAGE_DIRECTION_HINTS: Record<LeadStageDirection, Record<AppLocale, string>> = {
  backward: {
    en: "Moves this lead back to an earlier stage.",
    ar: "يعيد الفرصة إلى مرحلة سابقة.",
  },
  forward: {
    en: "Moves this lead forward to a later stage.",
    ar: "ينقل الفرصة إلى مرحلة لاحقة.",
  },
  same: {
    en: "This is the current stage.",
    ar: "المرحلة الحالية.",
  },
};

/** Screen-reader hint for one row of the picker. */
export function leadStageDirectionHint(
  direction: LeadStageDirection,
  locale: AppLocale,
): string {
  return LEAD_STAGE_DIRECTION_HINTS[direction][locale];
}

export interface LeadStageConfirmation {
  body: string;
  cancelLabel: string;
  confirmLabel: string;
  destructive: boolean;
  title: string;
}

/**
 * Confirmation copy for a move that closes the lead, or `null` when the move
 * is routine and should apply on a single tap. Reversibility is stated
 * explicitly: the backend puts no forward-only restriction on `leads.update`,
 * so a mistaken close really can be undone from the same picker.
 */
const TERMINAL_CONFIRMATION_BODY: Record<"WON" | "LOST", Record<AppLocale, string>> = {
  LOST: {
    en: "This lead will leave the active pipeline. You can move it back later from the same picker.",
    ar: "ستخرج الفرصة من خط المبيعات النشط. يمكنك إعادتها لاحقاً من نفس القائمة.",
  },
  WON: {
    en: "This lead will leave the active pipeline and can be linked to a sale. You can move it back later from the same picker.",
    ar: "ستخرج الفرصة من خط المبيعات النشط ويمكن ربطها ببيع. يمكنك إعادتها لاحقاً من نفس القائمة.",
  },
};

export function leadStageConfirmation(
  nextStage: MobileLeadStage,
  locale: AppLocale,
): LeadStageConfirmation | null {
  if (!isTerminalLeadStage(nextStage)) return null;

  const isArabic = locale === "ar";
  const stageName = leadStageLabel(nextStage, locale);
  const lost = nextStage === "LOST";

  return {
    destructive: lost,
    title: isArabic ? `نقل الفرصة إلى "${stageName}"؟` : `Move this lead to "${stageName}"?`,
    body: TERMINAL_CONFIRMATION_BODY[lost ? "LOST" : "WON"][locale],
    cancelLabel: isArabic ? "إلغاء" : "Cancel",
    confirmLabel: isArabic ? `نقل إلى "${stageName}"` : `Move to "${stageName}"`,
  };
}

/**
 * Pulls a user-safe message out of a rejected Convex mutation.
 *
 * Only the explicit `ConvexError` payload is read — never `error.message` or a
 * stack — so a thrown application error reaches the user while an unexpected
 * runtime failure still degrades to the caller's generic fallback. That keeps
 * schema names and query internals out of the UI.
 */
export function leadStageErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  if (typeof data === "string" && data.trim().length > 0) {
    return data.trim();
  }

  if (data && typeof data === "object") {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }

  return fallback;
}

/** Optimistic stages held per lead while their writes are in flight. */
export type PendingLeadStages = Readonly<Record<string, MobileLeadStage>>;

/**
 * Sets or clears one lead's optimistic stage, leaving every other lead's
 * entry untouched.
 *
 * Keying by lead id is load-bearing, not tidiness. Two rows are visible at
 * once, so two writes can overlap; with a single shared slot the second write
 * would evict the first, and whichever settled first would clear the *other*
 * lead's entry mid-flight — dropping its busy state and re-enabling a picker
 * whose mutation was still running.
 */
export function setPendingLeadStage(
  current: PendingLeadStages,
  leadId: string,
  stage: MobileLeadStage | null,
): PendingLeadStages {
  if (stage) {
    return { ...current, [leadId]: stage };
  }

  if (current[leadId] === undefined) return current;
  const { [leadId]: _cleared, ...rest } = current;
  return rest;
}

export interface CommitLeadStageDeps {
  /** Fires the mutation. Rejecting must roll the optimistic stage back. */
  applyStage: (stage: MobileLeadStage) => Promise<unknown>;
  /** Reports a failure to the user. Never called on the success path. */
  onError: (error: unknown) => void;
  /**
   * Paints the pending stage. Called with the target before the write and with
   * `null` once the write settles — on success the server value has landed and
   * takes over, on failure clearing it *is* the rollback.
   */
  setOptimisticStage: (stage: MobileLeadStage | null) => void;
}

export type LeadStageCommitResult = "unchanged" | "committed" | "failed";

/**
 * Applies a stage change optimistically and rolls back if the server rejects
 * it.
 *
 * The UI never ends up showing a stage the server refused: the optimistic
 * value is cleared in both the success and the failure path, so the rendered
 * stage always falls back to whatever the reactive query currently holds.
 * Selecting the stage the lead is already on writes nothing at all — no
 * mutation, no audit-trail row, no notification.
 */
export async function commitLeadStageChange(
  currentStage: MobileLeadStage,
  nextStage: MobileLeadStage,
  deps: CommitLeadStageDeps,
): Promise<LeadStageCommitResult> {
  if (currentStage === nextStage) {
    return "unchanged";
  }

  deps.setOptimisticStage(nextStage);
  try {
    await deps.applyStage(nextStage);
    deps.setOptimisticStage(null);
    return "committed";
  } catch (error) {
    deps.setOptimisticStage(null);
    deps.onError(error);
    return "failed";
  }
}
