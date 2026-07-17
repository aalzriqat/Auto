import { parseNotificationLink } from "./pushLink";

describe("parseNotificationLink", () => {
  it("returns a same-app absolute path", () => {
    expect(parseNotificationLink({ link: "/org/123/leads" })).toBe("/org/123/leads");
  });

  it("trims surrounding whitespace", () => {
    expect(parseNotificationLink({ link: "  /messages  " })).toBe("/messages");
  });

  it("rejects protocol-relative and external links", () => {
    expect(parseNotificationLink({ link: "//evil.com" })).toBeNull();
    expect(parseNotificationLink({ link: "https://evil.com" })).toBeNull();
  });

  it("returns null for missing or non-string link", () => {
    expect(parseNotificationLink({})).toBeNull();
    expect(parseNotificationLink({ link: 42 })).toBeNull();
    expect(parseNotificationLink(null)).toBeNull();
    expect(parseNotificationLink("nope")).toBeNull();
  });
});
