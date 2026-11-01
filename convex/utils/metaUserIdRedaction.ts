// SCRUM-842: a Meta user id must not stay readable in retained webhook logs.
//
// Before SCRUM-842 the deauthorize and data-deletion callbacks wrote
// "Deauthorized by <Platform> user <id>" and "Data deletion requested by
// <Platform> user <id>" into `webhookLogs`. SCRUM-807 forbids deleting
// operational history, so the disposition is redaction: the identifier is
// replaced with fixed text and the row (time, status, source) stays.
//
// Two pure functions, so the stored-row rewrite and the admin reader share one
// definition of "Meta user id" and neither can drift from the other.

export const REDACTED_META_USER = "[redacted Meta user]";

/**
 * Rows examined per redaction transaction. A page reads at most this many
 * `webhookLogs` documents and patches at most this many. Most rows are one-line
 * summaries, but the delivery-inbox rows of the `instagram` and `facebook` sources
 * also keep the webhook body (`rawPayload` up to 700,000 characters and a 16 KiB
 * `payloadPreview`), and Convex reads whole documents. 100 rows keeps a page inside
 * the 16 MiB read limit while the average row is below about 160 KB, and is far inside
 * the limits of 32,000 documents scanned and 16,000 written
 * (https://docs.convex.dev/production/state/limits).
 */
export const META_LOG_REDACTION_PAGE_SIZE = 100;

export type MetaPlatform = "facebook" | "instagram";

/** The `webhookLogs.source` the OAuth and callback routes of a platform log under. */
export function metaOauthLogSource(platform: MetaPlatform): "facebook-oauth" | "instagram-oauth" {
  return `${platform}-oauth`;
}

/**
 * Every `webhookLogs.source` that can hold one platform's Meta user id, in the
 * order the redaction walks them:
 *  - `<platform>-oauth`: the deauthorize / data-deletion callback rows, written
 *    before SCRUM-842 with the id in the summary;
 *  - `<platform>`: the delivery inbox and outcome rows of that platform's webhook
 *    and engagement code (`DM from <id>`, `Auto-reply DM to <id> failed`, the
 *    Instagram `subscribed_apps failed for IG account <id>` rows, the webhook body in
 *    `rawPayload`). The Instagram business account id is both the account id in
 *    `entry[].id` and the id the Instagram callbacks name.
 * The other platform's sources are never walked.
 */
export function metaLogRedactionSources(
  platform: MetaPlatform,
): readonly [ReturnType<typeof metaOauthLogSource>, MetaPlatform] {
  return [metaOauthLogSource(platform), platform];
}

/** The text fields of a `webhookLogs` row that can carry a Meta user id. */
export const META_LOG_REDACTED_FIELDS = ["summary", "error", "rawPayload", "payloadPreview"] as const;

const regexEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces every occurrence of one Meta user id in `text`. A match must stand
 * alone: an id that merely contains this one (a different user) is left as it is.
 */
export function redactMetaUserIdInText(text: string, metaUserId: string): string {
  if (!metaUserId) return text;
  const standalone = new RegExp(`(?<![A-Za-z0-9])${regexEscape(metaUserId)}(?![A-Za-z0-9])`, "g");
  return text.replace(standalone, () => REDACTED_META_USER);
}

const META_LOG_SOURCES: ReadonlySet<string> = new Set(["instagram", "facebook", "instagram-oauth", "facebook-oauth"]);
const META_OAUTH_LOG_SOURCES: ReadonlySet<string> = new Set(["instagram-oauth", "facebook-oauth"]);

// The wording the pre-SCRUM-842 callbacks used; the token after "user" is the id.
const LEGACY_USER_PHRASE = /\b(Instagram|Facebook) user (?!\[redacted Meta user\])\S+/g;
// A bare run of nine or more digits: the shape of a Meta user id. Only applied to
// the callback sources, where the id was logged; page and account ids that
// operators read in the webhook sources are left alone.
const NUMERIC_ID_RUN = /(?<![A-Za-z0-9])\d{9,}(?![A-Za-z0-9])/g;
// "IG account <id>": the wording of the pre-fix Instagram `subscribed_apps failed`
// row. That id is the Instagram business account id, the same id the Instagram
// deauthorize / data-deletion callbacks name (http.ts), so it is a user id.
const IG_ACCOUNT_PHRASE = /\bIG account (?!\[redacted Meta user\])[A-Za-z0-9_-]+/g;

/**
 * Defence in depth for the admin reader (OWASP: sanitize after collection and
 * before display). A summary from a Meta source never leaves the backend with the
 * user id in it, including a row the stored redaction has not reached yet. The
 * stored row is not changed here.
 */
export function maskMetaUserIdsForAdmin(source: string, summary: string): string {
  if (!META_LOG_SOURCES.has(source)) return summary;
  let masked = summary
    .replace(LEGACY_USER_PHRASE, (_match, label: string) => `${label} user ${REDACTED_META_USER}`)
    .replace(IG_ACCOUNT_PHRASE, () => `IG account ${REDACTED_META_USER}`);
  if (META_OAUTH_LOG_SOURCES.has(source)) masked = masked.replace(NUMERIC_ID_RUN, () => REDACTED_META_USER);
  return masked;
}

/**
 * The same read-time mask for a row's `error` field. The error text of a Meta
 * source is provider-sourced (a Graph error can quote the object id it rejected),
 * so every id-shaped run is masked in all four Meta sources, not only the
 * callback ones. Returns `undefined` for a row with no error. The stored row is
 * not changed.
 */
export function maskMetaErrorForAdmin(source: string, error: string | undefined): string | undefined {
  if (error === undefined || !META_LOG_SOURCES.has(source)) return error;
  return error
    .replace(LEGACY_USER_PHRASE, (_match, label: string) => `${label} user ${REDACTED_META_USER}`)
    .replace(IG_ACCOUNT_PHRASE, () => `IG account ${REDACTED_META_USER}`)
    .replace(NUMERIC_ID_RUN, () => REDACTED_META_USER);
}
