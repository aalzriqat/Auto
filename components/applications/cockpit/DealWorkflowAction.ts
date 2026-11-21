import type { FinanceDecisionDialog } from "./FinanceCompanyDecisionCard";

/** The recorded figure or currency, beside the org's current currency. */
export type SettlementDenominationDetail = {
  recordedLabel: string;
  recordedAmount: string;
  orgLabel: string;
  orgCurrency: string;
};

/**
 * What a focus-row step opens when the dialog or pane it needs is owned by the
 * VIEW rather than the container (SCRUM-417). The view resolves it to its own
 * handler, so the focus row reuses the exact dialog the card or panel opens —
 * never a second copy of it.
 */
export type WorkflowActionTarget =
  | FinanceDecisionDialog
  | "DOCUMENTS"
  | "SETTLE_SUPPLIER";

/** The one next step for the stage the rail names — see `DealCockpitView`. */
export type WorkflowAction = {
  stageKey: string;
  /** i18n key for the button label — never a raw string. */
  actionKey: string;
  /** Absent when `opens` names a view-owned target instead. */
  onStart?: () => void;
  opens?: WorkflowActionTarget;
  /** A sentence under the step saying why THIS is the next step. */
  noteKey?: string;
  /** A quieter alternative on the same step, where one must be preserved. */
  secondary?: { actionKey: string; onStart: () => void };
  /** Set when the step cannot be taken; the button is withheld and this is shown. */
  unavailableReasonKey?: string;
  /** The withheld figure in its own currency, shown under the reason. */
  unavailableDetail?: SettlementDenominationDetail;
  /**
   * Where the blocker is resolved, when that is another EXISTING page (SCRUM-417
   * UX1, S4). Set by the container only for a caller who can act there; the step
   * shows it under the reason.
   */
  unavailableLink?: { href: string; labelKey: string };
  /**
   * Said instead of the link to a caller who cannot act at that destination:
   * names who does (never a dead end, never a link to a refusal).
   */
  unavailableNoteKey?: string;
};
