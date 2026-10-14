/**
 * Retention window for Facebook revocation fences (`facebookRevocations`).
 *
 * A leaf module — it imports nothing — so both `facebookIntegrations` (which
 * refuses attempts older than this) and `adminSystem` (whose hourly sweep deletes
 * fences older than this) can share ONE value without an import cycle.
 *
 * A fence only matters to an OAuth attempt begun at or before it. An attempt
 * cannot outlive its 10-minute OAuth state plus the action that consumes it, so
 * an hour is far past any live attempt. Because the sweep runs hourly, a fence
 * is gone within about two hours of the callback.
 */
export const FACEBOOK_REVOCATION_RETENTION_MS = 60 * 60 * 1000;
