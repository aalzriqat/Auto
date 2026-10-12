import { describe, expect, test } from "vitest";
import {
  buildPreview,
  collapseBlankLines,
  htmlToPlainText,
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
    "info-noreply@x.com",
    "noreply-tag@x.com",
    "do-not-reply+abc@x.com",
  ])("%s is a no-reply address", (email) => {
    expect(isNoReplyAddress(email)).toBe(true);
  });

  // Reviewer ruling (SCRUM-825 round 1): the hard server refusal must only fire
  // for addresses that genuinely cannot receive mail. These are categorized as
  // Automated but a human can still reply to them.
  test.each(["notifications@github.com", "notification@x.com", "postmaster@x.com"])(
    "%s is repliable (not no-reply) but still likely automated",
    (email) => {
      expect(isNoReplyAddress(email)).toBe(false);
      expect(isLikelyAutomated(email)).toBe(true);
    }
  );

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

describe("htmlToPlainText", () => {
  test("keeps block structure as newlines, drops script/style/head", () => {
    const html =
      "<html><head><title>x</title><style>p{}</style></head><body><p>Hello&nbsp;<b>world</b></p><div>Line&nbsp;2<br>Line 3</div><script>alert(1)</script></body></html>";
    expect(htmlToPlainText(html)).toBe("Hello world\nLine 2\nLine 3");
  });

  test("decodes named and numeric entities and never turns an escaped tag into markup", () => {
    expect(htmlToPlainText("<p>a &amp; b &#8212; c</p>")).toBe("a & b — c");
    expect(htmlToPlainText("<p>&lt;script&gt;</p>")).toBe("<script>");
  });

  test("normal HTML-only email", () => {
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body><!-- c --><div><p>Hi Omar,</p><p>Your <a href="https://x.test/a?b=1&amp;c=2">invoice</a> is ready.</p></div></body></html>';
    expect(htmlToPlainText(html)).toBe("Hi Omar,\nYour invoice is ready.");
  });

  test("nested tables keep row structure", () => {
    const html = "<table><tr><td>A</td><td>B</td></tr><tr><td><table><tr><td>C</td></tr></table></td></tr></table>";
    expect(htmlToPlainText(html)).toBe("A B\nC");
  });

  test("br becomes a newline in every spelling", () => {
    expect(htmlToPlainText("a<br>b<BR/>c<br />d")).toBe("a\nb\nc\nd");
  });

  test("Arabic and emoji survive", () => {
    expect(htmlToPlainText("<p>السلام عليكم 😀</p><p>مرحبا</p>")).toBe("السلام عليكم 😀\nمرحبا");
  });

  test("entities decode as before", () => {
    expect(htmlToPlainText("<p>&nbsp;a&nbsp;&amp;&nbsp;b &#128512; &bogus; &#0;</p>")).toBe("a & b 😀 &bogus; &#0;");
  });

  test("an unclosed comment, script, style or head swallows the rest instead of leaking markup", () => {
    expect(htmlToPlainText("<p>before</p><!-- never closed <p>secret</p>")).toBe("before");
    expect(htmlToPlainText("<p>before</p><script>alert(1)")).toBe("before");
    expect(htmlToPlainText("<p>before</p><style>p{")).toBe("before");
    expect(htmlToPlainText("<p>before</p><head><title>x</title>")).toBe("before");
  });

  test("a stray less-than sign stays text", () => {
    expect(htmlToPlainText("<p>1 < 2 and 3 > 2</p>")).toBe("1 < 2 and 3 > 2");
  });

  // Reviewer finding F1 (HIGH): the regex pipeline was quadratic on these. They
  // run on the inbound-mutation path, which has ~1s of user code, so a hostile
  // sender could make the webhook retry forever. 480 KB each; budget 200 ms.
  const HOSTILE: Array<[string, string]> = [
    ["comment openers", "<!--".repeat(120_000)],
    ["head openers", "<head>".repeat(80_000)],
    ["style openers", "<style>".repeat(68_000)],
    ["unterminated tag openers", "<a ".repeat(160_000)],
  ];
  test.each(HOSTILE)("hostile 480 KB input (%s) converts in under 200 ms", (_name, payload) => {
    const started = performance.now();
    htmlToPlainText(payload);
    expect(performance.now() - started).toBeLessThan(200);
  });
  test.each(HOSTILE)("hostile 480 KB input (%s) builds a bounded preview in under 200 ms", (_name, payload) => {
    const started = performance.now();
    const preview = buildPreview(undefined, payload);
    expect(performance.now() - started).toBeLessThan(200);
    expect(Array.from(preview).length).toBeLessThanOrEqual(160);
  });

  // Review G3 (round 2): the first fix sliced the HTML to 64 KB BEFORE scanning,
  // so a large <head> (style block) left an empty preview, and a <head> with no
  // </head> (legal HTML) swallowed the whole message.
  test("a head longer than 64 KB does not empty the preview", () => {
    const css = "a{color:red}".repeat(6_500); // ~78 KB
    expect(css.length).toBeGreaterThan(64 * 1024);
    const html = `<html><head><style>${css}</style></head><body>Real message text</body></html>`;
    expect(buildPreview(undefined, html)).toBe("Real message text");
    expect(htmlToPlainText(html)).toBe("Real message text");
  });

  test("a <head> with no </head> ends at <body>", () => {
    const html = "<html><head><title>x</title><body><p>Real message text</p>";
    expect(htmlToPlainText(html)).toBe("Real message text");
    expect(buildPreview(undefined, html)).toBe("Real message text");
  });

  test("<body> ends an unclosed head case-insensitively and with attributes", () => {
    expect(htmlToPlainText("<HEAD><META x=1><BODY class=a>Hello</BODY>")).toBe("Hello");
    expect(htmlToPlainText("<head><style>p{}</style><Body\nbgcolor=#fff>Hello")).toBe("Hello");
  });

  test("a head that really never ends still swallows the rest (no body to resume at)", () => {
    expect(htmlToPlainText("<p>before</p><head><title>x</title><p>hidden</p>")).toBe("before");
  });

  test("a closed head still wins over a later literal 'body' word", () => {
    expect(htmlToPlainText("<head><title>x</title></head><p>the <b>body</b> text</p>")).toBe("the body text");
  });

  test("htmlToPlainText stops once maxOutputChars of visible text have accumulated", () => {
    const html = `<p>${"word ".repeat(200_000)}</p><p>never reached</p>`;
    const started = performance.now();
    const out = htmlToPlainText(html, { maxOutputChars: 2_000 });
    expect(performance.now() - started).toBeLessThan(200);
    expect(out.length).toBeGreaterThanOrEqual(1_000);
    expect(out.length).toBeLessThan(3_000);
    expect(out).not.toContain("never reached");
    // Without the option nothing is truncated.
    expect(htmlToPlainText("<p>aa</p><p>bb</p>")).toBe("aa\nbb");
  });

  test("the preview is the text that comes AFTER a huge leading comment too", () => {
    const html = `<!--${"x".repeat(100_000)}--><p>Visible after the comment</p>`;
    expect(buildPreview(undefined, html)).toBe("Visible after the comment");
  });
});

// Review G4 (round 2, Opus M-2): the blank-line collapse regex was super-linear on
// long whitespace runs and runs in the browser (plain-text view) on raw bodyText.
describe("collapseBlankLines is linear", () => {
  const timed = (fn: () => unknown) => {
    const started = performance.now();
    fn();
    return performance.now() - started;
  };

  test.each([
    ["space-tab pairs then text", " \t".repeat(100_000) + "x"],
    ["tabs only", "\t".repeat(200_000)],
    ["spaces then newline-less text", " ".repeat(300_000) + "x"],
    ["alternating blank lines", " \n".repeat(150_000) + "x"],
    ["CRLF runs", "\r\n \t".repeat(80_000) + "x"],
  ])("splitBodyText on %s finishes in under 200 ms", (_name, payload) => {
    expect(timed(() => splitBodyText(payload))).toBeLessThan(200);
    expect(timed(() => collapseBlankLines(payload))).toBeLessThan(200);
  });

  // The previous implementation is the oracle: the rewrite must match it exactly.
  const reference = (text: string) => text.replace(/(?:[ \t]*\r?\n){3,}/g, "\n\n");

  test("matches the previous regex output exactly on edge cases", () => {
    for (const sample of [
      "",
      "\n\n\n",
      "a\n\n\nb",
      "a\n\nb",
      "a\nb",
      "a  \n \t \n\t\n\nb",
      "a\r\n\r\n\r\nb",
      "\n\n\nabc\n\n\n",
      "x \n \n \n y",
      "a\n \nb",
      "  \n\n\n  tail",
      "tail\n\n\n   ",
    ]) {
      expect(collapseBlankLines(sample), JSON.stringify(sample)).toBe(reference(sample));
    }
  });

  test("matches the previous regex output exactly on random whitespace-heavy input", () => {
    const alphabet = [" ", "\t", "\n", "\r\n", "a", "b"];
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 2_000; i += 1) {
      const length = next() % 40;
      let sample = "";
      for (let j = 0; j < length; j += 1) sample += alphabet[next() % alphabet.length];
      expect(collapseBlankLines(sample), JSON.stringify(sample)).toBe(reference(sample));
    }
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
