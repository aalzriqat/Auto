/**
 * Retention window for Facebook revocation fences (`facebookRevocations`).
 *
 * A leaf module — it imports nothing — so both `facebookIntegrations` (which
 * refuses attempts older than this) and `adminSystem` (whose hourly sweep deletes
 * fences older than this) can share ONE value without an import cycle.
 *
 * A fence only matters to an OAuth attempt begun at or before it. An attempt
 * cannot outlive its 10-minute OAuth state plus the action that consumes it, so
 * an hour is far past any live attempt.
 *
 * Removal is expected, not guaranteed: with the sweep running hourly, a fence is
 * normally gone within about two hours of the user's latest callback. That sweep
 * deletes at most adminSystem's RETENTION_DELETE_BATCH rows per run and depends
 * on its cron firing, so a backlog or a missed run lets fences linger longer.
 * Correctness does not depend on the sweep: an attempt older than this window is
 * refused whether or not its fence still exists, and a lingering fence blocks
 * only attempts begun at or before it.
 */
export const FACEBOOK_REVOCATION_RETENTION_MS = 60 * 60 * 1000;
