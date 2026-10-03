/**
 * SCRUM-565 — the version and completeness of the financial-reset protocol.
 *
 * `resetOrgFinancialData` deletes an organization's financial rows in several
 * committed batches. Its original protocol leaves positions standing without
 * the basis that explains them, so until every SCRUM-565 slice has shipped,
 * every DESTRUCTIVE invocation (a fresh run AND a continuation) refuses with
 * `RESET_PROTOCOL_INCOMPLETE` before it writes anything. Dry runs still run.
 *
 * ONLY THE FINAL SCRUM-565 SLICE FLIPS `RESET_PROTOCOL_COMPLETE`. Nothing at
 * runtime (no argument, env var or setting) may open this gate: it is a source
 * constant so that opening it is a reviewed diff.
 *
 * A certification verdict, once one exists, is bound to
 * (orgId, generation, protocolVersion): a verdict reached under another
 * version or generation proves nothing about this run.
 */
export const RESET_PROTOCOL_VERSION = 1;

export const RESET_PROTOCOL_COMPLETE = false;

/** English text of the refusal; `ServerError_RESET_PROTOCOL_INCOMPLETE` carries the Arabic. */
export const RESET_PROTOCOL_INCOMPLETE_MESSAGE =
  "The financial reset is temporarily disabled while its safety checks are being completed. Nothing was deleted.";
