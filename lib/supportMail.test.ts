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

/**
 * Fastest of three runs, in ms. The timing tests guard against super-linear
 * scans, which cost seconds at these sizes; taking the minimum keeps that signal
 * while a single slow run on a loaded CI worker cannot fail the bound.
 */
function fastestMs(fn: () => unknown): number {
  let best = Infinity;
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

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
    // `&#0;` is U+FFFD (browsers; round 5 J3), not left as a literal.
    expect(htmlToPlainText("<p>&nbsp;a&nbsp;&amp;&nbsp;b &#128512; &bogus; &#0;</p>")).toBe("a & b 😀 &bogus; �");
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
    expect(fastestMs(() => htmlToPlainText(payload))).toBeLessThan(200);
  });
  test.each(HOSTILE)("hostile 480 KB input (%s) builds a bounded preview in under 200 ms", (_name, payload) => {
    expect(fastestMs(() => buildPreview(undefined, payload))).toBeLessThan(200);
    const preview = buildPreview(undefined, payload);
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

  // Round 5 (J1): there is no "head mode" any more. Like a browser, text after
  // <head> is just text (the implied <body>); only script/style/title/template
  // are raw blocks, anywhere.
  test("text after an unclosed <head> is body text, as in a browser", () => {
    expect(htmlToPlainText("<p>before</p><head><title>x</title><p>shown</p>")).toBe("before\nshown");
    expect(htmlToPlainText("<head><title>Title</title><p>Actual customer question</p>")).toBe("Actual customer question");
  });

  test("a closed head still wins over a later literal 'body' word", () => {
    expect(htmlToPlainText("<head><title>x</title></head><p>the <b>body</b> text</p>")).toBe("the body text");
  });

  // Review H1 (round 3): the early-stop budget counted RAW characters before
  // entity decoding, so spacer markup used it up and the preview came out empty
  // or cut inside an entity ("&n"). There is no budget any more: the whole body
  // is converted in the one linear pass.
  const INVOICE = "<p>Hello, my invoice #123 is wrong.</p>";
  test.each([
    ["&nbsp; spacer table rows", `<table>${"<tr><td>&nbsp;</td></tr>".repeat(400)}</table>${INVOICE}`],
    ["&#32; entities", `<p>${"&#32;".repeat(400)}</p>${INVOICE}`],
    ["literal NBSP characters", `<p>${" ".repeat(2_000)}</p>${INVOICE}`],
  ])("preview survives a flood of invisible spacers (%s)", (_name, html) => {
    expect(buildPreview(undefined, html)).toBe("Hello, my invoice #123 is wrong.");
    expect(htmlToPlainText(html)).toContain("Hello, my invoice #123 is wrong.");
  });

  test("htmlToPlainText takes no options and does not truncate", () => {
    expect(htmlToPlainText.length).toBe(1);
    const text = "word ".repeat(5_000).trim();
    expect(htmlToPlainText(`<p>${text}</p><p>tail</p>`)).toBe(`${text}\ntail`);
  });

  test("a preview never ends inside an entity (fuzz over entity-heavy inputs)", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pieces = ["&nbsp;", "&amp;", "&#32;", "&#160;", "&lt;", "&#8212;", " ", "<br>", "<p>", "</p>", "x", "word", " ", "&n", "&#"];
    for (let i = 0; i < 300; i += 1) {
      let html = "";
      const count = 50 + Math.floor(rand() * 1_500);
      for (let j = 0; j < count; j += 1) html += pieces[Math.floor(rand() * pieces.length)];
      const preview = buildPreview(undefined, html);
      const fullText = htmlToPlainText(html).replace(/\s+/g, " ").trim();
      const points = Array.from(fullText);
      // Whatever the whole conversion produced is what is previewed, never a fragment of it.
      expect(fullText.startsWith(preview)).toBe(true);
      if (points.length <= 160) expect(preview).toBe(fullText);
      else expect(Array.from(preview).length).toBeLessThanOrEqual(160);
    }
  });

  // 1 MiB is Convex's document ceiling, so this is the worst input the webhook can see.
  const MIB = 1024 * 1024;
  const fill = (unit: string, tail = "") => unit.repeat(Math.floor(MIB / unit.length)) + tail; // whole units only
  const ONE_MIB: Array<[string, string]> = [
    ["&nbsp; spacer flood", fill("<tr><td>&nbsp;</td></tr>", INVOICE)],
    ["&#32; flood", fill("&#32;", INVOICE)],
    ["NBSP flood", fill(" ", INVOICE)],
    ["comment openers", fill("<!--")],
    ["head + 1 MB style", `<html><head><style>${"a{color:red}".repeat(90_000)}</style></head><body>${INVOICE}`],
    ["quote flood in head", `<head>${'<meta content="'.repeat(70_000)}`],
    ["unclosed quote in head", `<head><meta content="${"x".repeat(MIB)}`],
  ];
  test.each(ONE_MIB)("1 MiB hostile input (%s) builds a preview in under 200 ms", (_name, html) => {
    expect(fastestMs(() => buildPreview(undefined, html))).toBeLessThan(200);
    const preview = buildPreview(undefined, html);
    expect(Array.from(preview).length).toBeLessThanOrEqual(160);
  });
  test("the 1 MiB spacer and head cases still produce the real text", () => {
    expect(buildPreview(undefined, ONE_MIB[0]![1])).toBe("Hello, my invoice #123 is wrong.");
    expect(buildPreview(undefined, ONE_MIB[4]![1])).toBe("Hello, my invoice #123 is wrong.");
  });

  // Review H2 (round 3): the head scan ended at a `<body` that was only text or
  // an attribute value, and a closing tag matched on a name PREFIX.
  test.each([
    [
      "<body inside an attribute value",
      '<html><head><meta content="<body"><title>Internal heading</title></head><body>Actual customer question</body></html>',
    ],
    ["<body> mentioned in title text", "<head><title>Re: the <body> tag</title></head><body>Actual customer question"],
    ["unclosed head, <body in an attribute", '<head><meta content="<body"><title>Internal heading</title><body>Actual customer question'],
    ["a > inside a quoted attribute", '<head><meta content="a>b"><title>Internal heading</title></head>Actual customer question'],
  ])("head scan is quote-aware (%s)", (_name, html) => {
    expect(htmlToPlainText(html)).toBe("Actual customer question");
    expect(buildPreview(undefined, html)).toBe("Actual customer question");
  });

  test("a closing tag must match the whole name: </styleX> does not end a <style>", () => {
    expect(htmlToPlainText("<style>p{}</styleX>leaked</style><p>Real</p>")).toBe("Real");
    expect(htmlToPlainText("<script>x()</scriptable>leaked</script><p>Real</p>")).toBe("Real");
    expect(htmlToPlainText("<style>p{}</style ><p>Real</p>")).toBe("Real");
    expect(htmlToPlainText("<style>p{}</STYLE\n><p>Real</p>")).toBe("Real");
  });

  test("controls: <body inside a comment, style or script in the head is still ignored", () => {
    expect(htmlToPlainText("<head><!-- <body> --><title>t</title></head><body>Real")).toBe("Real");
    expect(htmlToPlainText("<head><style>/* <body> */</style><body>Real")).toBe("Real");
    expect(htmlToPlainText('<head><script>var a = "<body>";</script><body>Real')).toBe("Real");
    expect(htmlToPlainText("<head><title>x</title><body>Real")).toBe("Real");
  });

  // Review R4-01: a closing tag with no ">" made endOfHead rescan the same tail for
  // every "<" (quadratic: 250 KB took 9-13 s). A closing non-head tag WITH ">" is
  // skipped normally; one without swallows the rest, like an unterminated opener.
  test("a closing non-head tag with '>' is skipped; without '>' it swallows the rest", () => {
    expect(htmlToPlainText("<head></meta foo><body>Hello")).toBe("Hello");
    expect(buildPreview(undefined, "<head></meta foo><body>Hello")).toBe("Hello");
    expect(() => buildPreview(undefined, "<head></a x")).not.toThrow();
    expect(buildPreview(undefined, "<head></a x")).toBe("");
    expect(htmlToPlainText("<head></a x")).toBe("");
  });

  test("the preview is the text that comes AFTER a huge leading comment too", () => {
    const html = `<!--${"x".repeat(100_000)}--><p>Visible after the comment</p>`;
    expect(buildPreview(undefined, html)).toBe("Visible after the comment");
  });
});

// Permanent linearity matrix: each pattern repeated to ~1 MiB, in a head and a body
// context, must convert in under MIB_BUDGET_MS. One line per future pattern.
describe("scanner linearity matrix (1 MiB, head and body contexts)", () => {
  const MIB = 1024 * 1024;
  // Linear runs take ~90 ms locally but ~205 ms in CI under coverage instrumentation
  // (PR #567, slice 2/4). A quadratic rescan at this size takes seconds or minutes
  // (R4-01 measured 181 s), so 1 s still separates the two by an order of magnitude.
  const MIB_BUDGET_MS = 1000;
  const repeatTo = (unit: string) => unit.repeat(Math.floor(MIB / unit.length));
  // [name, unit, optional wrapper prefix that opens the raw block the unit sits in]
  const PATTERNS: Array<[string, string, string?]> = [
    ["</a x", "</a x"],
    ['</a "', '</a "'],
    ["</he", "</he"],
    ["<a x", "<a x"],
    ['<a "', '<a "'],
    ['<a ""', '<a ""'],
    ["</", "</"],
    ["<style", "<style"],
    ["</stylex inside <style>", "</stylex", "<style>"],
    ["<title>", "<title>"],
    ["<!--", "<!--"],
    ["</head x", "</head x"],
    ["<!x", "<!x"],
    ["<?", "<?"],
    ["</scriptx inside <script>", "</scriptx", "<script>"],
    ["&#", "&#"],
    ["&#1234567", "&#1234567"],
    ["&nbsp;", "&nbsp;"],
    ["<head>", "<head>"],
    [" < (stray less-than flood)", " <"],
    ["<p>&amp;", "<p>&amp;"],
  ];
  const CONTEXTS: Array<[string, string]> = [
    ["head", "<head>"],
    ["body", "<body>"],
  ];
  // Shapes that are not "one unit repeated": [name, builder(prefix)].
  const SHAPES: Array<[string, (prefix: string) => string]> = [
    // A terminated tag whose quoted value contains MANY tag-like openers: resuming at
    // `<` + 1 instead of past the tag's `>` would rescan the tail once per opener.
    ['rescan after an ended tag (<meta content=" + <x ×n)', (p) => `${p}<meta content="${"<x ".repeat(MIB / 3)}">Visible text`],
    ["rescan after an ended tag, no space (<x><x>…)", (p) => `${p}<meta content="${"<x>".repeat(MIB / 3)}">Visible text`],
  ];
  const CASES = [
    ...PATTERNS.flatMap(([name, unit, wrap]) =>
      CONTEXTS.map(([ctx, prefix]) => [`${name} in ${ctx}`, `${prefix}${wrap ?? ""}${repeatTo(unit)}`] as [string, string])
    ),
    ...SHAPES.flatMap(([name, build]) => CONTEXTS.map(([ctx, prefix]) => [`${name} in ${ctx}`, build(prefix)] as [string, string])),
  ];
  test.each(CASES)("%s", (_name, html) => {
    const preview = buildPreview(undefined, html);
    expect(Array.from(preview).length).toBeLessThanOrEqual(160);
    expect(fastestMs(() => buildPreview(undefined, html))).toBeLessThan(MIB_BUDGET_MS);
    expect(fastestMs(() => htmlToPlainText(html))).toBeLessThan(MIB_BUDGET_MS);
  });
});

// Review G4 (round 2, Opus M-2): the blank-line collapse regex was super-linear on
// long whitespace runs and runs in the browser (plain-text view) on raw bodyText.
describe("collapseBlankLines is linear", () => {
  const timed = fastestMs;

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


// Round 5 J1: reproductions from review, each validated against a real browser parser.
describe("scanner follows the browser (round 5 J1)", () => {
  const CUSTOMER = "Customer cannot pay invoice";
  test.each([
    [
      "R4-02a: '>' and '<body>' inside a quoted head attribute",
      `<head data="> <body>">${"<title>INTERNAL HEADING</title>".repeat(15)}</head><body>${CUSTOMER}</body>`,
      CUSTOMER,
    ],
    ["R4-02b: head then a paragraph, no <body>", "<head><title>Title</title><p>Actual customer question</p>", "Actual customer question"],
    ["R5-01: unquoted value with an apostrophe", "<head><meta name=a content=O'Brien></head><body>Body text</body>", "Body text"],
    ['R5-01: doubled closing quote', '<head><meta charset="utf-8""></head><body>Body text</body>', "Body text"],
    ["R5-01: a quote inside an attribute NAME", '<head><meta na"me=x></head><body>Body text</body>', "Body text"],
    ["R5-01: a quote inside an unquoted value", "<head><meta content=a\"b></head><body>Body text</body>", "Body text"],
    ["<bodyx> is an unknown tag, not the body", "<bodyx>Body text</bodyx>", "Body text"],
    ["a title in the body is not body text", "<body><title>t</title>Body text</body>", "Body text"],
    ["a template is not body text", "<template><p>hidden</p></template><p>Body text</p>", "Body text"],
  ])("%s", (_name, html, expected) => {
    expect(htmlToPlainText(html)).toBe(expected);
    expect(buildPreview(undefined, html)).toBe(expected);
  });

  // Round 6 K3: <noscript> is a raw block again. The reading pane's sanitizer
  // (sanitizeEmailHtml.ts) removes it, so the preview must not show text the message
  // view never shows. (This reverses round 5 J1, which displayed it.)
  test("<noscript> content is skipped, matching what the reading pane shows", () => {
    expect(buildPreview(undefined, "<p>Hi</p><noscript>Enable JS</noscript><p>Body</p>")).toBe("Hi Body");
    expect(htmlToPlainText("<head><noscript><p>Enable JS</p></noscript></head><body>Real</body>")).toBe("Real");
  });

  test("an unterminated quoted value or tag swallows the rest", () => {
    expect(buildPreview(undefined, '<p>kept</p><meta content="never closed <p>gone</p>')).toBe("kept");
    expect(buildPreview(undefined, "<p>kept</p><a href=x <p gone")).toBe("kept");
  });
});

// Round 5 J2/J3: character references.
describe("character references (round 5 J2, J3)", () => {
  const wellFormed = (s: string) => (s as unknown as { isWellFormed(): boolean }).isWellFormed();

  test("named entities decode (Latin-1 + typographic) and the Latin-1 table is exactly 96 names", () => {
    expect(htmlToPlainText("<p>Caf&eacute; &copy; 2026 &mdash; &ldquo;ok&rdquo; &hellip; &euro;5 &pound;3 &times; &Eacute;</p>")).toBe(
      "Café © 2026 — “ok” … €5 £3 × É"
    );
    expect(htmlToPlainText("<p>&yuml;&nbsp;&agrave;&THORN;&divide;&deg;&laquo;&raquo;&bull;&middot;&trade;&reg;</p>")).toBe("ÿ àÞ÷°«»•·™®");
  });
  test("hex and decimal numeric references decode", () => {
    expect(htmlToPlainText("<p>&#x1F600; &#X41; &#65; &#8212;</p>")).toBe("😀 A A —");
  });
  // Round 6 K1: 0x80-0x9F use the HTML spec's Windows-1252 table, as browsers do.
  test("numeric references 0x80-0x9F use the Windows-1252 replacement table", () => {
    expect(htmlToPlainText("<p>It&#146;s due</p>")).toBe("It’s due");
    expect(htmlToPlainText("<p>&#128;</p>")).toBe("€");
    expect(htmlToPlainText("<p>&#147;quoted&#148;</p>")).toBe("“quoted”");
    expect(htmlToPlainText("<p>&#150;&#151;&#153;&#x85;&#x9F;</p>")).toBe("–—™…Ÿ");
    // No mapping in the table (0x81 0x8D 0x8F 0x90 0x9D): the code point stays.
    expect(htmlToPlainText("<p>a&#129;b</p>")).toBe("a\u0081b");
    expect(htmlToPlainText("<p>&#157;</p>")).toBe("\u009d");
  });
  test("references are decoded exactly once", () => {
    expect(htmlToPlainText("<p>&amp;#60;</p>")).toBe("&#60;");
    expect(htmlToPlainText("<p>&amp;amp;</p>")).toBe("&amp;");
    expect(htmlToPlainText("<p>&amp;lt;b&amp;gt;</p>")).toBe("&lt;b&gt;");
    expect(htmlToPlainText("<p>&lt;script&gt;</p>")).toBe("<script>");
  });
  test("unknown or malformed references stay literal", () => {
    expect(htmlToPlainText("<p>&bogus; &copy &#; &#x; AT&T</p>")).toBe("&bogus; © &#; &#x; AT&T".replace("©", "&copy"));
  });
  test("a reference is decoded BEFORE the 160-code-point cut; the cut itself is plain truncation (round 6 K2)", () => {
    expect(buildPreview(undefined, `<p>${"x".repeat(158)}&copy; tail</p>`)).toBe(`${"x".repeat(158)}©`);
    expect(buildPreview(undefined, `<p>${"x".repeat(157)}&eacute;&eacute; tail</p>`)).toBe(`${"x".repeat(157)}éé`);
    // Entities are already decoded, so any "&..." left at the cut is LITERAL text; cutting it is
    // ordinary truncation (what a browser shows), not a half-entity to repair.
    expect(buildPreview(undefined, `<p>${"x".repeat(158)}R&Demand</p>`)).toBe(`${"x".repeat(158)}R&`.slice(0, 160));
    expect(buildPreview(undefined, `<p>${"x".repeat(157)}AT&Tail</p>`)).toBe(`${"x".repeat(157)}AT&`);
    expect(buildPreview(undefined, `<p>${"x".repeat(158)}&bogus; tail</p>`)).toBe(`${"x".repeat(158)}&b`);
    // …but an ampersand inside text that fits is kept.
    expect(buildPreview(undefined, `<p>${"x".repeat(155)}AT&T</p>`)).toBe(`${"x".repeat(155)}AT&T`);
  });

  test.each([
    ["decimal surrogate", "<p>&#55357;x</p>"],
    ["hex low surrogate", "<p>&#xDE00;x</p>"],
    ["above U+10FFFF", "<p>&#1114112;x</p>"],
    ["NUL", "<p>&#0;x</p>"],
    ["far above range", "<p>&#4294967295;x</p>"],
  ])("a numeric reference to an invalid code point becomes U+FFFD (%s)", (_name, html) => {
    expect(htmlToPlainText(html)).toBe("\ufffdx");
    const preview = buildPreview(undefined, html);
    expect(preview).toBe("\ufffdx");
    expect(wellFormed(preview)).toBe(true);
  });

  test("a lone surrogate in raw text never reaches the preview", () => {
    for (const html of ["<p>a\ud83dx</p>", "<p>a\ude00x</p>", "<p>a\ud83d</p>"]) {
      expect(wellFormed(buildPreview(undefined, html))).toBe(true);
    }
    expect(buildPreview("a\ud83dx")).toBe("a\ufffdx");
    expect(buildPreview("😀\ude00")).toBe("😀\ufffd");
    expect(buildPreview("😀")).toBe("😀"); // a valid pair is untouched
  });
});

// Round 5 J5: the browser is the oracle. jsdom's HTML parser (the same spec tokenizer
// the inbox iframe uses) gives `document.body.textContent`; the preview must equal it.
//
// Deliberate divergences, applied to the ORACLE so the comparison stays exact:
//  - <script>, <style>, <title>, <template>, <noscript> are removed (we never show them; a browser
//    would render a <style>/<script> inside <body> as textContent, but not as visible text);
//  - a space is inserted around every element (our scanner turns every tag into
//    whitespace, so `wor<b>d</b>` previews as "wor d", where textContent gives "word");
// and by construction: only the ~110 named references in the table decode (the corpus
// stays inside it), and `<https://…>` link dumps are removed by buildPreview.
describe("browser oracle (round 5 J5)", () => {
  const oracle = (html: string): string => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, title, template, noscript").forEach((el) => el.remove());
    doc.body.querySelectorAll("*").forEach((el) => {
      el.before(" ");
      el.after(" ");
    });
    const text = (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
    const points = Array.from(text);
    return points.length <= 160 ? text : points.slice(0, 160).join("").trimEnd();
  };

  const INVOICE = "<p>Hello, my invoice #123 is wrong.</p>";
  const OUTLOOK =
    '<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--><style type="text/css">p{margin:0}</style><title></title></head><body style="margin:0"><div><p>Hi team,</p><p>The invoice is wrong.</p></div></body></html>';
  const CORPUS: Array<[string, string]> = [
    ["R4-02a", `<head data="> <body>">${"<title>INTERNAL HEADING</title>".repeat(15)}</head><body>Customer cannot pay invoice</body>`],
    ["R4-02b", "<head><title>Title</title><p>Actual customer question</p>"],
    ["R5-01 apostrophe", "<head><meta name=a content=O'Brien></head><body>Body text</body>"],
    ["R5-01 doubled quote", '<head><meta charset="utf-8""></head><body>Body text</body>'],
    ["R5-01 quote in name", '<head><meta na"me=x></head><body>Body text</body>'],
    ["bodyx", "<bodyx>Body text</bodyx>"],
    ["H1 &nbsp; rows", `<table>${"<tr><td>&nbsp;</td></tr>".repeat(400)}</table>${INVOICE}`],
    ["H1 &#32;", `<p>${"&#32;".repeat(400)}</p>${INVOICE}`],
    ["H1 NBSP", `<p>${"\u00a0".repeat(2_000)}</p>${INVOICE}`],
    ["H2 attribute <body", '<html><head><meta content="<body"><title>Internal heading</title></head><body>Actual customer question</body></html>'],
    ["H2 title text", "<head><title>Re: the <body> tag</title></head><body>Actual customer question"],
    ["noscript between paragraphs", "<p>Hi</p><noscript>Enable JS</noscript><p>Body</p>"],
    ["K1 &#146; apostrophe", "<p>It&#146;s due</p>"],
    ["K1 &#128; euro", "<p>&#128;5 only</p>"],
    ["K1 &#147; &#148; quotes", "<p>&#147;quoted&#148; and &#150; dash &#151; &#153;</p>"],
    // (A <p> inside a HEAD <noscript> is not in the corpus: with scripting disabled the parser
    // closes the head there and the text lands in the body, which is a parser quirk the oracle's
    // "remove noscript" rule cannot model. The unit test above covers that shape directly.)
    ["H2 > in attribute", '<head><meta content="a>b"><title>Internal heading</title></head>Actual customer question'],
    ["Outlook MSO head", OUTLOOK],
    ["marketing spacers", `<table width="600"><tr><td style="font-size:0;line-height:0">&nbsp;</td></tr>${"<tr><td height=\"8\">&nbsp;</td></tr>".repeat(50)}<tr><td><h1>Spring sale</h1><p>20% off all <b>hatchbacks</b> this week.</p></td></tr></table>`],
    ["plain paragraph", "<p>Hello there</p>"],
    ["no html/head/body", "<div>Just a <span>div</span> with a<br>break</div>"],
    ["bare text", "Plain words only"],
    ["doctype only wrapper", "<!doctype html><html><body><p>Doctype mail</p></body></html>"],
    ["Arabic RTL", '<div dir="rtl"><p>مرحبا بكم في أوتوفلو</p><p>لدينا ثلاثة معارض</p></div>'],
    ["entities", "<p>Caf&eacute; &copy; 2026 &mdash; &ldquo;ok&rdquo; &amp;#60; &#x1F600; &lt;b&gt;</p>"],
    ["invalid numeric refs", "<p>&#55357;x &#0;y &#1114112;z</p>"],
    ["comment and style in body text flow", "<p>one</p><!-- hidden --><p>two</p>"],
    ["long mail cut at 160", `<p>${"word ".repeat(100)}</p>`],
    ["emoji at the cut", `<p>${"x".repeat(159)}😀 tail</p>`],
  ];
  test.each(CORPUS)("%s", (_name, html) => {
    expect(buildPreview(undefined, html)).toBe(oracle(html));
  });
});
