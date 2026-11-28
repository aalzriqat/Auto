/**
 * SCRUM-1033: no URL query string or fragment may leave the browser inside a
 * Sentry event or breadcrumb. convex/email.ts mails /setup-account?ticket=<7-day
 * one-time sign-in ticket>, and the SDK records raw URLs in the event request,
 * its Referer header and navigation / fetch / xhr breadcrumbs.
 */
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubEvent, stripQueryAndFragment } from "./sentryScrub";

const SECRET = "TICKET-7f3a9c-SECRET";

function errorEvent(request?: ErrorEvent["request"]): ErrorEvent {
  return { type: undefined, message: "boom", ...(request ? { request } : {}) };
}

describe("stripQueryAndFragment", () => {
  it.each([
    ["absolute URL with query", `https://app.example.com/setup-account?ticket=${SECRET}`, "https://app.example.com/setup-account"],
    ["relative URL with query and fragment", `/setup-account?ticket=${SECRET}#y`, "/setup-account"],
    ["fragment only", `/deals/1#${SECRET}`, "/deals/1"],
    ["fragment before a question mark", `/a#frag?ticket=${SECRET}`, "/a"],
    ["URL with an embedded redirect_url", `/sign-in?redirect_url=%2Fsetup-account%3Fticket%3D${SECRET}`, "/sign-in"],
    ["no query or fragment", "https://app.example.com/deals/1", "https://app.example.com/deals/1"],
    ["empty string", "", ""],
    ["malformed URL", `ht!tp:/:/bad url?ticket=${SECRET}`, "ht!tp:/:/bad url"],
  ])("%s", (_label, input, expected) => {
    const result = stripQueryAndFragment(input);
    expect(result).toBe(expected);
    expect(result).not.toContain(SECRET);
  });

  it("returns non-strings unchanged", () => {
    const object = { a: 1 };
    expect(stripQueryAndFragment(undefined)).toBeUndefined();
    expect(stripQueryAndFragment(null)).toBeNull();
    expect(stripQueryAndFragment(42)).toBe(42);
    expect(stripQueryAndFragment(object)).toBe(object);
  });
});

describe("scrubEvent (beforeSend)", () => {
  it("removes the ticket from the request URL, query string and Referer header", () => {
    const scrubbed = scrubEvent(
      errorEvent({
        url: `https://app.example.com/setup-account?ticket=${SECRET}`,
        query_string: `ticket=${SECRET}`,
        headers: {
          Referer: `https://app.example.com/sign-in?redirect_url=${SECRET}#x`,
          "User-Agent": "test-agent",
        },
      }),
    );
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    expect(scrubbed.request?.url).toBe("https://app.example.com/setup-account");
    expect(scrubbed.request).not.toHaveProperty("query_string");
    expect(scrubbed.request?.headers?.Referer).toBe("https://app.example.com/sign-in");
    expect(scrubbed.request?.headers?.["User-Agent"]).toBe("test-agent");
    expect(scrubbed.message).toBe("boom");
  });

  it("handles a relative request URL", () => {
    const scrubbed = scrubEvent(errorEvent({ url: `/setup-account?ticket=${SECRET}#y` }));
    expect(scrubbed.request?.url).toBe("/setup-account");
  });

  it.each(["referer", "REFERER", "Referer", "rEfErEr"])("scrubs the Referer header in any casing: %s", (name) => {
    const scrubbed = scrubEvent(errorEvent({ headers: { [name]: `https://a.example.com/x?ticket=${SECRET}` } }));
    expect(scrubbed.request?.headers?.[name]).toBe("https://a.example.com/x");
  });

  it("does not mutate its input", () => {
    const input = errorEvent({ url: `/a?ticket=${SECRET}`, query_string: `ticket=${SECRET}` });
    scrubEvent(input);
    expect(input.request?.url).toBe(`/a?ticket=${SECRET}`);
    expect(input.request?.query_string).toBe(`ticket=${SECRET}`);
  });

  it("returns an event with no request unchanged", () => {
    const input = errorEvent();
    expect(scrubEvent(input)).toEqual(input);
    expect(scrubEvent(input)).not.toHaveProperty("request");
  });

  it("leaves a request without URL or headers alone", () => {
    expect(scrubEvent(errorEvent({ method: "GET" })).request).toEqual({ method: "GET" });
  });
});

describe("scrubBreadcrumb (beforeBreadcrumb)", () => {
  it("scrubs from and to on navigation breadcrumbs", () => {
    const crumb: Breadcrumb = {
      category: "navigation",
      data: { from: `/setup-account?ticket=${SECRET}`, to: `/#${SECRET}` },
    };
    const scrubbed = scrubBreadcrumb(crumb);
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    expect(scrubbed?.data).toEqual({ from: "/setup-account", to: "/" });
  });

  it.each(["fetch", "xhr"])("scrubs data.url on %s breadcrumbs and keeps the rest", (category) => {
    const crumb: Breadcrumb = {
      category,
      type: "http",
      data: { url: `https://api.example.com/x?ticket=${SECRET}`, method: "GET", status_code: 200 },
    };
    const scrubbed = scrubBreadcrumb(crumb);
    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    expect(scrubbed?.data).toEqual({ url: "https://api.example.com/x", method: "GET", status_code: 200 });
    expect(scrubbed?.type).toBe("http");
  });

  it("passes an unrelated breadcrumb through untouched", () => {
    const crumb: Breadcrumb = { category: "ui.click", message: "button#save", data: { url: "/a?b=c" } };
    expect(scrubBreadcrumb(crumb)).toBe(crumb);
  });

  it("leaves a navigation breadcrumb without data alone", () => {
    const crumb: Breadcrumb = { category: "navigation" };
    expect(scrubBreadcrumb(crumb)).toEqual(crumb);
  });

  it("does not mutate its input", () => {
    const crumb: Breadcrumb = { category: "navigation", data: { from: `/a?ticket=${SECRET}`, to: "/b" } };
    scrubBreadcrumb(crumb);
    expect(crumb.data?.from).toBe(`/a?ticket=${SECRET}`);
  });
});
