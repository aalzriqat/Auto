import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

/**
 * SCRUM-1033: keep URL query strings and fragments out of Sentry.
 *
 * The browser SDK records the raw page URL (event.request.url), the Referer
 * header and the URLs in navigation / fetch / xhr breadcrumbs. Our emailed
 * links carry credentials in the query (/setup-account?ticket=..., a one-time
 * sign-in ticket; /accept-invite?token=...). The path and origin are kept so we
 * still know which page failed.
 *
 * Applied at the one place data leaves the browser (beforeSend /
 * beforeBreadcrumb), so no call site has to remember to hide anything.
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

/** `beforeSend`: scrubs the request URL, drops the query string and scrubs the Referer header. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const request = event.request;
  if (!request) return event;

  const { query_string: _queryString, ...rest } = request;
  const scrubbed: NonNullable<ErrorEvent["request"]> = { ...rest };
  if (typeof rest.url === "string") scrubbed.url = stripQueryAndFragment(rest.url);
  if (rest.headers) {
    scrubbed.headers = Object.fromEntries(
      Object.entries(rest.headers).map(([name, value]) => [
        name,
        name.toLowerCase() === "referer" ? stripQueryAndFragment(value) : value,
      ]),
    );
  }
  return { ...event, request: scrubbed };
}

const NAVIGATION_KEYS = ["from", "to"] as const;
const HTTP_KEYS = ["url"] as const;

function scrubDataKeys(crumb: Breadcrumb, keys: readonly string[]): Breadcrumb {
  const data = crumb.data;
  if (!data) return crumb;
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
