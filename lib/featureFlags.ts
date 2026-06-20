/**
 * Kill switch — mirrors `LIVE_CHAT_ENABLED` in convex/liveChat.ts (frontend
 * and Convex backend code live in separate bundles, so this is intentionally
 * duplicated rather than shared — flip both back to `true` together to
 * re-enable). Disabled because background presence/typing pings fanned out
 * into excessive Convex function-call usage; see convex/liveChat.ts for the
 * full explanation before re-enabling.
 */
export const LIVE_CHAT_ENABLED = false;
