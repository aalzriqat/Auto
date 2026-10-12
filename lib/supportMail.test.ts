import { describe, expect, test } from "vitest";
import {
  buildPreview,
  collapseBlankLines,
  isLikelyAutomated,
  isNoReplyAddress,
  resolveThreadCategory,
  splitBodyText,
} from "./supportMail";

describe("isNoReplyAddress", () => {
  test.each([
    "no-reply@email.claude.com",
    "noreply@po.atlassian.net",
    "NoReply@Example.com",
    "noreply+cffa368@id.atlassian.com",
    "no-reply-uamktlmn8suimnjukb003e6y@slack.com",
    "no_reply@x.com",
    "do-not-reply@x.com",
    "donotreply@x.com",
    "mailer-daemon@x.com",
    "postmaster@x.com",
    "notifications@github.com",
    "notification@x.com",
    "info-noreply@x.com",
  ])("%s is a no-reply address", (email) => {
    expect(isNoReplyAddress(email)).toBe(true);
  });

  test.each([
    "reply-ztecovhsgwh5_tikctu-qw@mail.anthropic.com",
    "omar@nasserauto.com",
    "sara.haddad@gmail.com",
    "noreplying@x.com",
    "replyto@x.com",
    "accounts@saleh-auto.com",
    "",
  ])("%j is repliable", (email) => {
    expect(isNoReplyAddress(email)).toBe(false);
  });

  test("a no-reply token in the DOMAIN alone does not count", () => {
    expect(isNoReplyAddress("sales@noreply-motors.com")).toBe(false);
  });

  test("null and undefined are not no-reply", () => {
    expect(isNoReplyAddress(null)).toBe(false);
    expect(isNoReplyAddress(undefined)).toBe(false);
  });
});

describe("isLikelyAutomated", () => {
  test.each([
    "no-reply@email.claude.com",
    "events@send.zapier.com",
    "learn@send.zapier.com",
    "news@send.zapier.com",
    "notify@mail.notion.com",
    "reply-ztecovhsgwh5_tikctu-qw@mail.anthropic.com", // repliable but bulk subdomain
    "someone@em.bulk.example.org",
  ])("%s is likely automated", (email) => {
    expect(isLikelyAutomated(email)).toBe(true);
  });

  test.each([
    "omar@nasserauto.com",
    "khaled@almasri-motors.jo",
    "sara.haddad@gmail.com",
    "accounts@saleh-auto.com",
    "billing@dealer.jo",
    "info@dealer.jo",
    "lina@mail.com", // two labels: "mail" is the registrable domain, not a bulk subdomain
  ])("%s is a person", (email) => {
    expect(isLikelyAutomated(email)).toBe(false);
  });
});

describe("resolveThreadCategory", () => {
  test("heuristic when there is no override", () => {
    expect(resolveThreadCategory({ participantEmail: "noreply@x.com" })).toBe("automated");
    expect(resolveThreadCategory({ participantEmail: "omar@nasserauto.com" })).toBe("people");
  });
  test("an override always wins", () => {
    expect(resolveThreadCategory({ participantEmail: "noreply@x.com", categoryOverride: "people" })).toBe("people");
    expect(resolveThreadCategory({ participantEmail: "omar@a.com", categoryOverride: "automated" })).toBe("automated");
  });
});

describe("buildPreview", () => {
  test("collapses whitespace and removes <https://> link dumps", () => {
    expect(buildPreview("Hi\n\n  there\n<https://a.com/x?y=1&z=2>\n<http://b.org>\nbye")).toBe("Hi there bye");
  });

  test("falls back to tag-stripped HTML when text is blank", () => {
    expect(buildPreview("   ", "<style>a{}</style><p>One &amp; two</p><script>x()</script>")).toBe("One & two");
    expect(buildPreview(undefined, "<div>Hello<br>world</div>")).toBe("Hello world");
  });

  test("prefers bodyText over bodyHtml", () => {
    expect(buildPreview("plain", "<p>html</p>")).toBe("plain");
  });

  test("is capped at 160 characters and never splits a surrogate pair", () => {
    const long = "ab ".repeat(200);
    expect(buildPreview(long).length).toBeLessThanOrEqual(160);
    const emoji = "😀".repeat(200);
    const out = buildPreview(emoji);
    expect(Array.from(out)).toHaveLength(160);
    expect(out).toBe("😀".repeat(160));
  });

  test("returns an empty string when there is nothing", () => {
    expect(buildPreview()).toBe("");
    expect(buildPreview("<https://only.link/x>")).toBe("");
  });

  test("keeps Arabic text intact", () => {
    expect(buildPreview("السلام عليكم\n\nلدينا ثلاثة معارض")).toBe("السلام عليكم لدينا ثلاثة معارض");
  });
});

describe("collapseBlankLines / splitBodyText", () => {
  test("collapses 3+ blank lines to one blank line", () => {
    expect(collapseBlankLines("a\n\n\n\n\nb")).toBe("a\n\nb");
    expect(collapseBlankLines("a\n\nb")).toBe("a\n\nb");
  });

  test("turns <https://…> dumps into link segments with the hostname", () => {
    const segments = splitBodyText("Ready.\n<https://www.claude.ai/?#footerLogo>\n<http://apps.apple.com/us/app/x>\nBye");
    expect(segments.filter((s) => s.kind === "link")).toEqual([
      { kind: "link", url: "https://www.claude.ai/?#footerLogo", host: "claude.ai" },
      { kind: "link", url: "http://apps.apple.com/us/app/x", host: "apps.apple.com" },
    ]);
    expect(segments[0]).toEqual({ kind: "text", text: "Ready.\n" });
    expect(segments[segments.length - 1]).toEqual({ kind: "text", text: "\nBye" });
  });

  test("never turns a non-http scheme into a link", () => {
    const segments = splitBodyText("<javascript:alert(1)> and <mailto:a@b.com>");
    expect(segments).toEqual([{ kind: "text", text: "<javascript:alert(1)> and <mailto:a@b.com>" }]);
  });

  test("text with no links is one text segment; empty is none", () => {
    expect(splitBodyText("just words")).toEqual([{ kind: "text", text: "just words" }]);
    expect(splitBodyText("")).toEqual([]);
  });
});
