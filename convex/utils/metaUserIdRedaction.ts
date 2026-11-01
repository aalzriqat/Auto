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
 * The replacement for a document that the readable text would push past Convex's 1 MiB
 * document limit. One ASCII character, so it is never longer than the id it replaces
 * (an id is at least one character): a patch that uses it cannot grow the document.
 */
export const REDACTED_META_USER_COMPACT = "*";

/**
 * The largest a redacted `webhookLogs` document may become, in `getDocumentSize` bytes.
 * Convex refuses a document above 1 MiB (https://docs.convex.dev/production/state/limits);
 * 4 KiB below that leaves room for the system fields and for the size being an estimate.
 */
export const META_LOG_DOCUMENT_BUDGET_BYTES = 1024 * 1024 - 4096;

/**
 * The most rows one redaction transaction asks for. Most `webhookLogs` rows are
 * one-line summaries, so this is the normal page. It is a ceiling, not a promise:
 * the delivery-inbox rows of the `instagram` and `facebook` sources also keep the
 * webhook body (`rawPayload` up to 700,000 characters and a 16 KiB `payloadPreview`),
 * Convex reads whole documents, and 100 such rows would exceed the 16 MiB read limit
 * of a transaction (https://docs.convex.dev/production/state/limits). The byte budget
 * below, not this number, is what keeps a page inside that limit.
 */
export const META_LOG_REDACTION_PAGE_SIZE = 100;

/**
 * The most bytes one redaction page may read (`maximumBytesRead` of `paginate`,
 * https://docs.convex.dev/api/interfaces/server.PaginationOptions). Why 6 MiB:
 *  - A Convex document is at most 1 MiB, so a page of ONE row always fits, and a
 *    page that reaches the budget can be retried at half the size until it does.
 *  - A transaction may read 16 MiB and write 16 MiB, separately. Redaction patches
 *    each row it reads, and the replacement text ("[redacted Meta user]", 20 characters)
 *    is longer than a short id, so the bytes written can exceed the bytes read. The
 *    readable rewrites of a page are therefore capped (`META_LOG_REDACTION_MAX_READABLE_WRITE_BYTES`),
 *    and a row past the cap, or one that would outgrow the document limit, is rewritten
 *    with a one-character replacement that cannot grow it.
 *  - The job and receipt rows, and the scheduler call, are a few hundred bytes.
 */
export const META_LOG_REDACTION_MAX_BYTES_READ = 6 * 1024 * 1024;

/**
 * The most bytes of readable-text rewrites one page may write. The rest of the page is
 * rewritten with the compact replacement, which never grows a row, so a page writes at
 * most this plus the bytes it read (at most about 7 MiB): under the 16 MiB a transaction
 * may write, whatever the length of the id.
 */
export const META_LOG_REDACTION_MAX_READABLE_WRITE_BYTES = 8 * 1024 * 1024;

/**
 * The page size to ask for next, from what the last page cost. It targets half the
 * byte budget at the average row size just seen, so a log of one-line summaries
 * stays at the full page and a log of large webhook bodies settles at a few rows.
 * Never below one row, never above `META_LOG_REDACTION_PAGE_SIZE`. A page that
 * reached the budget anyway is halved by the caller instead (that page is discarded).
 */
export function nextRedactionPageSize(rowsRead: number, bytesRead: number): number {
  if (rowsRead <= 0 || bytesRead <= 0) return META_LOG_REDACTION_PAGE_SIZE;
  const averageRowBytes = bytesRead / rowsRead;
  const fitting = Math.floor(META_LOG_REDACTION_MAX_BYTES_READ / 2 / averageRowBytes);
  return Math.min(META_LOG_REDACTION_PAGE_SIZE, Math.max(1, fitting));
}

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
 *    `rawPayload`).
 * The other platform's sources are never walked.
 *
 * An Instagram account has TWO ids in this codebase, and they differ: the callbacks
 * name the business account id (`instagramBusinessAccountId`, the token exchange's
 * `user_id`), while webhook bodies carry the id in `entry[].id`, stored as
 * `instagramWebhookAccountId` (the profile's `user_id`; see schema.ts and
 * instagramEngagement.ts). The walk therefore redacts a list of ids, not only the id
 * the callback named; the caller reads the list before the disconnect clears it.
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
 * Replaces every occurrence of one Meta user id in `text` with `replacement` (readable
 * text by default; the compact one when the document must not grow). A match must stand
 * alone: an id that merely contains this one (a different user) is left as it is.
 */
export function redactMetaUserIdInText(
  text: string,
  metaUserId: string,
  replacement: string = REDACTED_META_USER,
): string {
  if (!metaUserId) return text;
  const standalone = new RegExp(`(?<![A-Za-z0-9])${regexEscape(metaUserId)}(?![A-Za-z0-9])`, "g");
  return text.replace(standalone, () => replacement);
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
