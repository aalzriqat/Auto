import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  avatarColorClass,
  errorToastMessage,
  formatListTime,
  includesQuery,
  isAutomatedAck,
  replySubject,
  senderInitial,
} from "./format";

// Local-time constructors: the helpers format in the viewer's timezone.
const NOW = new Date(2026, 9, 12, 10, 30).getTime();
const at = (day: number, hour = 9, minute = 5) => new Date(2026, 9, day, hour, minute).getTime();

describe("formatListTime", () => {
  test("today shows the time", () => {
    expect(formatListTime(at(12, 8, 15), NOW, "en")).toMatch(/8:15/);
  });
  test("within the last 6 days shows the weekday (Latin text in en, Arabic name in ar)", () => {
    expect(formatListTime(at(10), NOW, "en")).toBe("Sat");
    expect(formatListTime(at(10), NOW, "ar")).toMatch(/[؀-ۿ]/);
  });
  test("older than 6 days shows day and month with Latin digits in both locales", () => {
    expect(formatListTime(at(4), NOW, "en")).toBe("4 Oct");
    const ar = formatListTime(at(4), NOW, "ar");
    expect(ar).toMatch(/^4 /);
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toMatch(/[٠-٩]/);
  });
});

describe("avatar + initial", () => {
  test("colour is deterministic per address", () => {
    expect(avatarColorClass("omar@nasserauto.com")).toBe(avatarColorClass("omar@nasserauto.com"));
    expect(avatarColorClass("a@b.c")).toMatch(/^bg-/);
  });
  test("initial handles latin, arabic and empty", () => {
    expect(senderInitial("omar")).toBe("O");
    expect(senderInitial("لينا")).toBe("ل");
    expect(senderInitial("  ")).toBe("?");
    expect(senderInitial(undefined)).toBe("?");
  });
});

describe("replySubject", () => {
  test("adds Re: once", () => {
    expect(replySubject("Help")).toBe("Re: Help");
    expect(replySubject("Re: Help")).toBe("Re: Help");
  });
});

describe("isAutomatedAck", () => {
  const ack = "(Automated acknowledgment — your message was received and a team member will follow up shortly.)";
  test("OUTBOUND with no author and the ack text is automated", () => {
    expect(isAutomatedAck({ direction: "OUTBOUND", bodyText: ack })).toBe(true);
  });
  test("a human reply is not, with or without sentByUserId", () => {
    expect(isAutomatedAck({ direction: "OUTBOUND", sentByUserId: "u1", bodyText: ack })).toBe(false);
    expect(isAutomatedAck({ direction: "OUTBOUND", bodyText: "Hi, we fixed it." })).toBe(false);
  });
  test("an inbound message is never an ack", () => {
    expect(isAutomatedAck({ direction: "INBOUND", bodyText: ack })).toBe(false);
  });
});

describe("errorToastMessage", () => {
  test("shows a ConvexError string, falls back for anything else", () => {
    expect(errorToastMessage(new ConvexError("This sender does not accept replies."), "fallback")).toBe(
      "This sender does not accept replies."
    );
    expect(errorToastMessage(new ConvexError({ code: "X" }), "fallback")).toBe("fallback");
    expect(errorToastMessage(new Error("[CONVEX A(x)] Server Error stack"), "fallback")).toBe("fallback");
    expect(errorToastMessage({ weird: true }, "fallback")).toBe("fallback");
    expect(errorToastMessage(new ConvexError("  "), "fallback")).toBe("fallback");
  });
});

describe("includesQuery", () => {
  test("empty query matches; matching is case-insensitive across fields; undefined fields are safe", () => {
    expect(includesQuery(["x"], "  ")).toBe(true);
    expect(includesQuery([undefined, "Omar Nasser"], "NASSER")).toBe(true);
    expect(includesQuery([undefined, null], "q")).toBe(false);
  });
});
