/**
 * How long a Facebook revocation fence (`facebookRevocations`) can block an
 * OAuth attempt; `facebookIntegrations` refuses attempts older than this.
 *
 * A fence only matters to an OAuth attempt begun at or before it. An attempt
 * cannot outlive its 10-minute OAuth state plus the action that consumes it, so
 * an hour is far past any live attempt.
 *
 * Fences are never deleted (SCRUM-807: operational records are preserved), so
 * this is an attempt-age window, not a deletion schedule. Correctness does not
 * depend on removal: an attempt older than this window is refused whether or not
 * its fence exists, and a lingering fence blocks only attempts begun at or
 * before it.
 */
export const FACEBOOK_REVOCATION_RETENTION_MS = 60 * 60 * 1000;
