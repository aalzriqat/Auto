import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

/**
 * SCRUM-1033: keep URL query strings and fragments out of Sentry.
 *
 * The browser SDK records the page URL in several places. Our emailed links
 * carry credentials in the query (/setup-account?ticket=..., a one-time sign-in
 * ticket; /accept-invite?token=...). These hooks cut each of the following at the
 * first `?` or `#`; path and origin stay, so we still know which page failed:
 *   - beforeSend: event.request.url, event.request.query_string (dropped), the
 *     Referer header, stack frame filename and abs_path of every exception
 *     (the global-error fallback frame uses location.href as its filename), and
 *     debug_meta image code_file (derived from those frame paths);
 *   - beforeBreadcrumb: navigation from / to and fetch / xhr url.
 *
 * Limits: beforeSend does not see session pings, client reports or the SDK's own
 * internal-error events, and nothing here scrubs exception messages or other
 * breadcrumb categories.
 * Sources: https://docs.sentry.io/platforms/javascript/guides/nextjs/data-management/sensitive-data/
 * (breadcrumb URLs carry the query string and fragment and "may need to be
 * scrubbed") and the OWASP Logging Cheat Sheet (access tokens are data to
 * exclude from logs).
 */

/** Cuts at the first `?` or `#`. Pure string work, so it cannot throw on malformed input. */
export function stripQueryAndFragment(value: string): string;
export function stripQueryAndFragment(value: unknown): unknown;
export function stripQueryAndFragment(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A copy of `item` with the named string fields cut; anything that is not a plain object is returned as is. */
function scrubFields<T>(item: T, keys: readonly string[]): T {
  if (!isRecord(item)) return item;
  const copy: Record<string, unknown> = { ...item };
  for (const key of keys) {
    if (key in copy) copy[key] = stripQueryAndFragment(copy[key]);
  }
  return copy as T;
}

function scrubRequest(request: NonNullable<ErrorEvent["request"]>): NonNullable<ErrorEvent["request"]> {
  const { query_string: _queryString, ...rest } = request;
  const scrubbed: NonNullable<ErrorEvent["request"]> = { ...rest };
  if (typeof rest.url === "string") scrubbed.url = stripQueryAndFragment(rest.url);
  if (isRecord(rest.headers)) {
    scrubbed.headers = Object.fromEntries(
      Object.entries(rest.headers).map(([name, value]) => [
        name,
        name.toLowerCase() === "referer" ? stripQueryAndFragment(value) : value,
      ]),
    );
  }
  return scrubbed;
}

type ExceptionValue = NonNullable<NonNullable<ErrorEvent["exception"]>["values"]>[number];

function scrubExceptionValue(value: ExceptionValue): ExceptionValue {
  if (!isRecord(value) || !isRecord(value.stacktrace) || !Array.isArray(value.stacktrace.frames)) return value;
  const frames = value.stacktrace.frames.map((frame) => scrubFields(frame, ["filename", "abs_path"]));
  return { ...value, stacktrace: { ...value.stacktrace, frames } };
}

/**
 * `beforeSend`: scrubs the request URL, drops the query string, scrubs the Referer
 * header, the stack frame paths of every exception and the debug image paths.
 * Returns a copy; the input is not mutated.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed: ErrorEvent = { ...event };
  if (isRecord(event.request)) scrubbed.request = scrubRequest(event.request);
  if (isRecord(event.exception) && Array.isArray(event.exception.values)) {
    scrubbed.exception = { ...event.exception, values: event.exception.values.map(scrubExceptionValue) };
  }
  if (isRecord(event.debug_meta) && Array.isArray(event.debug_meta.images)) {
    scrubbed.debug_meta = {
      ...event.debug_meta,
      images: event.debug_meta.images.map((image) => scrubFields(image, ["code_file"])),
    };
  }
  return scrubbed;
}
const NAVIGATION_KEYS = ["from", "to"] as const;
const HTTP_KEYS = ["url"] as const;

function scrubDataKeys(crumb: Breadcrumb, keys: readonly string[]): Breadcrumb {
  const data = crumb.data;
  if (!isRecord(data)) return crumb;
  const scrubbed: Record<string, unknown> = { ...data };
  for (const key of keys) {
    if (key in data) scrubbed[key] = stripQueryAndFragment(data[key]);
  }
  return { ...crumb, data: scrubbed };
}

/** `beforeBreadcrumb`: scrubs navigation from/to and fetch/xhr url; other breadcrumbs pass through. */
export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  if (crumb.category === "navigation") return scrubDataKeys(crumb, NAVIGATION_KEYS);
  if (crumb.category === "fetch" || crumb.category === "xhr") return scrubDataKeys(crumb, HTTP_KEYS);
  return crumb;
}
