/**
 * Pilot switches: single code constants that turn a risky path OFF for the
 * narrowed pilot.
 *
 * LEAF MODULE: no imports at all. The Convex backend AND the web client import
 * this file, so one constant is the single source of truth for both (SCRUM-795
 * D6). Flipping a switch is a reviewed code change plus a deploy, never an env
 * var, org setting or database flag.
 */

/**
 * Owner ruling SCRUM-760 c22474 / SCRUM-795 c22479 (SCRUM-50): manual journal
 * entries are OFF for the pilot. While `true`, EXACTLY
 * `financialAudit.createManualJournal` and `financialAudit.approveManualJournal`
 * refuse with `MANUAL_JOURNALS_DISABLED` after authentication and before any read
 * or write. Rejecting a legacy pending draft, and the opening-balance doors in
 * `accountingCutover.ts`, are deliberately NOT covered. Setting it to `false`
 * restores the previous behaviour exactly.
 *
 * Scope assumption: global for the narrowed pilot. Production is expected to hold
 * only the pilot dealer after the SCRUM-231 clean-slate start; if another live
 * org is added, this must become explicitly scoped (owner ruling SCRUM-795 c22479
 * Q1/Q3).
 */
export const MANUAL_JOURNALS_PILOT_DISABLED = true as const;
