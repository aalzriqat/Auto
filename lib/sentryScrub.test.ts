/**
 * SCRUM-1033: no URL query string or fragment may leave the browser inside a
 * Sentry event or breadcrumb. convex/email.ts mails /setup-account?ticket=<7-day
 * one-time sign-in ticket>, and the SDK records raw URLs in the event request,
 * its Referer header and navigation / fetch / xhr breadcrumbs.
 */
import type { Breadcrumb, ErrorEvent, StackFrame } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubEvent, stripQueryAndFragment } from "./sentryScrub";

const TICKET = "tkt-1";

function errorEvent(request?: ErrorEvent["request"]): ErrorEvent {
  return { type: undefined, message: "boom", ...(request ? { request } : {}) };
}

describe("stripQueryAndFragment", () => {
  it.each([
    ["absolute URL with query", `https://app.example.com/setup-account?ticket=${TICKET}`, "https://app.example.com/setup-account"],
    ["relative URL with query and fragment", `/setup-account?ticket=${TICKET}#y`, "/setup-account"],
    ["fragment only", `/deals/1#${TICKET}`, "/deals/1"],
    ["fragment before a question mark", `/a#frag?ticket=${TICKET}`, "/a"],
    ["URL with an embedded redirect_url", `/sign-in?redirect_url=%2Fsetup-account%3Fticket%3D${TICKET}`, "/sign-in"],
    ["no query or fragment", "https://app.example.com/deals/1", "https://app.example.com/deals/1"],
    ["empty string", "", ""],
    ["malformed URL", `ht!tp:/:/bad url?ticket=${TICKET}`, "ht!tp:/:/bad url"],
  ])("%s", (_label, input, expected) => {
    const result = stripQueryAndFragment(input);
    expect(result).toBe(expected);
    expect(result).not.toContain(TICKET);
    expect(result).not.toContain("ticket");
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
        url: `https://app.example.com/setup-account?ticket=${TICKET}`,
        query_string: `ticket=${TICKET}`,
        headers: {
          Referer: `https://app.example.com/sign-in?redirect_url=${TICKET}#x`,
          "User-Agent": "test-agent",
        },
      }),
    );
    expect(JSON.stringify(scrubbed)).not.toContain(TICKET);
    expect(JSON.stringify(scrubbed)).not.toContain("ticket");
    expect(scrubbed.request?.url).toBe("https://app.example.com/setup-account");
    expect(scrubbed.request).not.toHaveProperty("query_string");
    expect(scrubbed.request?.headers?.Referer).toBe("https://app.example.com/sign-in");
    expect(scrubbed.request?.headers?.["User-Agent"]).toBe("test-agent");
    expect(scrubbed.message).toBe("boom");
  });

  it("handles a relative request URL", () => {
    const scrubbed = scrubEvent(errorEvent({ url: `/setup-account?ticket=${TICKET}#y` }));
    expect(scrubbed.request?.url).toBe("/setup-account");
  });

  it.each(["referer", "REFERER", "Referer", "rEfErEr"])("scrubs the Referer header in any casing: %s", (name) => {
    const scrubbed = scrubEvent(errorEvent({ headers: { [name]: `https://a.example.com/x?ticket=${TICKET}` } }));
    expect(scrubbed.request?.headers?.[name]).toBe("https://a.example.com/x");
  });

  it("does not mutate its input", () => {
    const input = errorEvent({ url: `/a?ticket=${TICKET}`, query_string: `ticket=${TICKET}` });
    scrubEvent(input);
    expect(input.request?.url).toBe(`/a?ticket=${TICKET}`);
    expect(input.request?.query_string).toBe(`ticket=${TICKET}`);
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
      data: { from: `/setup-account?ticket=${TICKET}`, to: `/#${TICKET}` },
    };
    const scrubbed = scrubBreadcrumb(crumb);
    expect(JSON.stringify(scrubbed)).not.toContain(TICKET);
    expect(JSON.stringify(scrubbed)).not.toContain("ticket");
    expect(scrubbed?.data).toEqual({ from: "/setup-account", to: "/" });
  });

  it.each(["fetch", "xhr"])("scrubs data.url on %s breadcrumbs and keeps the rest", (category) => {
    const crumb: Breadcrumb = {
      category,
      type: "http",
      data: { url: `https://api.example.com/x?ticket=${TICKET}`, method: "GET", status_code: 200 },
    };
    const scrubbed = scrubBreadcrumb(crumb);
    expect(JSON.stringify(scrubbed)).not.toContain(TICKET);
    expect(JSON.stringify(scrubbed)).not.toContain("ticket");
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
    const crumb: Breadcrumb = { category: "navigation", data: { from: `/a?ticket=${TICKET}`, to: "/b" } };
    scrubBreadcrumb(crumb);
    expect(crumb.data?.from).toBe(`/a?ticket=${TICKET}`);
  });
});

describe("scrubEvent: stack frames and debug images", () => {
  const ORIGIN = "https://app.example.com";

  function eventWithFrames(frames: StackFrame[], request?: ErrorEvent["request"]): ErrorEvent {
    return {
      type: undefined,
      exception: { values: [{ type: "Error", value: "boom", stacktrace: { frames } }] },
      ...(request ? { request } : {}),
    };
  }

  const framesOf = (event: ErrorEvent) => event.exception?.values?.flatMap((value) => value.stacktrace?.frames ?? []) ?? [];

  it.each([
    ["the SDK fallback frame (absolute filename)", `${ORIGIN}/setup-account?ticket=tkt-1`, "/setup-account"],
    ["the normalised app:// filename", "app:///setup-account?ticket=tkt-1", "app:///setup-account"],
    ["a filename with a fragment", `${ORIGIN}/a#tkt-1`, "/a"],
  ])("strips the query string from %s, with and without a request", (_label, filename, expectedSuffix) => {
    const frame = { colno: 1, lineno: 2, filename, function: "?", in_app: true };
    for (const request of [undefined, { url: `${ORIGIN}/x` }]) {
      const scrubbed = scrubEvent(eventWithFrames([frame], request));
      const out = framesOf(scrubbed)[0];
      expect(out?.filename?.endsWith(expectedSuffix)).toBe(true);
      expect(out).toMatchObject({ colno: 1, lineno: 2, function: "?", in_app: true });
      expect(JSON.stringify(scrubbed)).not.toContain("tkt-1");
      expect(JSON.stringify(scrubbed)).not.toContain("ticket");
    }
  });

  it("scrubs abs_path as well as filename", () => {
    const scrubbed = scrubEvent(
      eventWithFrames([{ filename: "app:///_next/a.js", abs_path: `${ORIGIN}/setup-account?ticket=tkt-1` }]),
    );
    expect(framesOf(scrubbed)[0]?.abs_path).toBe(`${ORIGIN}/setup-account`);
    expect(framesOf(scrubbed)[0]?.filename).toBe("app:///_next/a.js");
  });

  it("scrubs every frame of every chained exception", () => {
    const input: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          { type: "Error", stacktrace: { frames: [{ filename: "app:///a.js?ticket=tkt-1" }, { filename: "app:///b.js#tkt-1" }] } },
          { type: "TypeError", stacktrace: { frames: [{ filename: `${ORIGIN}/c?ticket=tkt-1`, abs_path: "app:///c?ticket=tkt-1" }] } },
          { type: "NoStack" },
        ],
      },
    };
    const scrubbed = scrubEvent(input);
    expect(framesOf(scrubbed).map((frame) => frame.filename)).toEqual(["app:///a.js", "app:///b.js", `${ORIGIN}/c`]);
    expect(JSON.stringify(scrubbed)).not.toContain("tkt-1");
    expect(scrubbed.exception?.values?.[2]).toEqual({ type: "NoStack" });
  });

  it("scrubs debug image code_file values derived from frame paths", () => {
    const input: ErrorEvent = {
      type: undefined,
      debug_meta: { images: [{ type: "sourcemap", code_file: "app:///a.js?ticket=tkt-1", debug_id: "d-1" }] },
    };
    const scrubbed = scrubEvent(input);
    expect(scrubbed.debug_meta?.images).toEqual([{ type: "sourcemap", code_file: "app:///a.js", debug_id: "d-1" }]);
  });

  it("tolerates odd shapes without throwing", () => {
    const odd = [
      { type: undefined, exception: {} },
      { type: undefined, exception: { values: [] } },
      { type: undefined, exception: { values: [{ stacktrace: {} }] } },
      { type: undefined, exception: { values: [{ stacktrace: { frames: [{}, { filename: 5 }] } }] } },
      { type: undefined, exception: { values: [null] } },
      { type: undefined, debug_meta: {} },
      { type: undefined, debug_meta: { images: [null, { type: "sourcemap" }] } },
    ] as unknown as ErrorEvent[];
    for (const event of odd) expect(() => scrubEvent(event)).not.toThrow();
  });

  it("does not mutate the input event", () => {
    const input = eventWithFrames([{ filename: "app:///a.js?ticket=tkt-1" }], { url: "/a?ticket=tkt-1" });
    const before = JSON.stringify(input);
    scrubEvent(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("whole-object credential checks", () => {
  it("leaves neither the parameter name nor the value anywhere in a fully loaded event", () => {
    const input: ErrorEvent = {
      type: undefined,
      message: "boom",
      request: {
        url: "https://app.example.com/setup-account?ticket=tkt-1",
        query_string: "ticket=tkt-1",
        headers: { Referer: "https://app.example.com/sign-in?redirect_url=tkt-1#ticket", "User-Agent": "ua" },
      },
      exception: {
        values: [
          { type: "Error", stacktrace: { frames: [{ filename: "app:///setup-account?ticket=tkt-1", abs_path: "https://app.example.com/setup-account?ticket=tkt-1" }] } },
          { type: "Cause", stacktrace: { frames: [{ filename: "https://app.example.com/setup-account?ticket=tkt-1#tkt-1" }] } },
        ],
      },
      debug_meta: { images: [{ type: "sourcemap", code_file: "app:///x.js?ticket=tkt-1", debug_id: "d-1" }] },
    };
    const text = JSON.stringify(scrubEvent(input));
    expect(text).not.toContain("tkt-1");
    expect(text).not.toContain("ticket");
    expect(text).toContain("/setup-account");
  });

  it.each([
    ["navigation", { from: "/setup-account?ticket=tkt-1", to: "/#tkt-1" }],
    ["fetch", { url: "https://api.example.com/x?ticket=tkt-1", method: "GET" }],
    ["xhr", { url: "/x?ticket=tkt-1#tkt-1" }],
  ])("leaves neither name nor value in a %s breadcrumb", (category, data) => {
    const text = JSON.stringify(scrubBreadcrumb({ category, data }));
    expect(text).not.toContain("tkt-1");
    expect(text).not.toContain("ticket");
  });

  it.each([["a string", "oops"], ["a number", 7], ["an array", ["/a?ticket=tkt-1"]], ["true", true]])(
    "does not throw when breadcrumb data is %s",
    (_label, data) => {
      for (const category of ["navigation", "fetch", "xhr"]) {
        const crumb = { category, data } as unknown as Breadcrumb;
        expect(() => scrubBreadcrumb(crumb)).not.toThrow();
      }
    },
  );
});