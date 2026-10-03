/**
 * SCRUM-565 — the closed gate on the destructive financial reset.
 *
 * `RESET_PROTOCOL_COMPLETE` is false until every SCRUM-565 slice has shipped; while it is, every
 * destructive `resetOrgFinancialData` call (fresh or continuation) refuses with
 * `RESET_PROTOCOL_INCOMPLETE` before reading or writing anything. Dry runs still run.
 *
 * Only the final SCRUM-565 slice flips it, and it is a source constant on purpose: there is never a
 * runtime switch (argument, env var or setting), so opening the gate is a reviewed diff. The
 * run/verdict model bound to (orgId, generation, protocolVersion) lands in S4 (D-15).
 */
export const RESET_PROTOCOL_VERSION = 1;

export const RESET_PROTOCOL_COMPLETE = false;

/** English text of the refusal; `ServerError_RESET_PROTOCOL_INCOMPLETE` carries the Arabic. */
export const RESET_PROTOCOL_INCOMPLETE_MESSAGE =
  "The financial reset is temporarily disabled while its safety checks are being completed. Nothing was deleted.";
