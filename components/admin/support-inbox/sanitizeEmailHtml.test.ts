import { describe, expect, test } from "vitest";
import { isStillUnsafe, sanitizeEmailHtml } from "./sanitizeEmailHtml";

function bodyOf(srcDoc: string): Document {
  return new DOMParser().parseFromString(srcDoc, "text/html");
}

const HOSTILE = `<!doctype html><html><head>
<meta http-equiv="refresh" content="0;url=https://evil.example">
<link rel="stylesheet" href="https://evil.example/x.css">
<base href="https://evil.example/">
<style>p{color:red}</style>
<script>window.parent.postMessage('x','*')</script>
</head><body onload="steal()" style="background:#eee">
<p onclick="steal()" style="color:blue">Hello</p>
<a href="javascript:steal()">js</a>
<a href=" jav&#x61;script:steal()">obfuscated</a>
<a href="data:text/html;base64,PHNjcmlwdD4=">data html</a>
<a href="https://ok.example/path">ok</a>
<a href="mailto:a@b.com">mail</a>
<iframe src="https://evil.example"></iframe>
<object data="https://evil.example/x.swf"></object>
<embed src="https://evil.example/x.swf">
<form action="https://evil.example"><input name="pw"><button>Go</button></form>
<svg><script>steal()</script><foreignObject><div>x</div></foreignObject></svg>
<img src="https://tracker.example/pixel.gif" alt="t">
<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">
<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="svg">
<div style="width:expression(alert(1))">expr</div>
</body></html>`;

describe("sanitizeEmailHtml", () => {
  const out = sanitizeEmailHtml(HOSTILE);
  const doc = bodyOf(out.srcDoc);

  test("the CSP meta is the first thing in <head> and forbids everything by default", () => {
    const first = doc.head.firstElementChild;
    expect(first?.tagName).toBe("META");
    // charset is first by convention; CSP must come before any content or style.
    const metas = Array.from(doc.head.querySelectorAll("meta"));
    const csp = metas.find((m) => m.getAttribute("http-equiv") === "Content-Security-Policy");
    expect(csp).toBeTruthy();
    const content = csp!.getAttribute("content")!;
    expect(content).toContain("default-src 'none'");
    expect(content).toContain("img-src data:");
    expect(content).not.toContain("https:");
    expect(content).toContain("font-src 'none'");
    expect(content).not.toMatch(/script-src/);
    expect(out.srcDoc.indexOf("Content-Security-Policy")).toBeLessThan(out.srcDoc.indexOf("<style"));
    // The attacker's meta refresh is gone; ours is the only http-equiv.
    expect(metas.filter((m) => m.hasAttribute("http-equiv"))).toHaveLength(1);
  });

  test("injects <base target=_blank> and drops the attacker's <base>", () => {
    const bases = Array.from(doc.querySelectorAll("base"));
    expect(bases).toHaveLength(1);
    expect(bases[0]!.getAttribute("target")).toBe("_blank");
    expect(bases[0]!.hasAttribute("href")).toBe(false);
  });

  test("removes scripts, frames, objects, embeds, forms and inputs", () => {
    for (const tag of ["script", "iframe", "object", "embed", "form", "input", "button", "link", "foreignObject"]) {
      expect(doc.querySelectorAll(tag), tag).toHaveLength(0);
    }
    expect(out.srcDoc).not.toContain("steal()");
    expect(out.srcDoc).not.toContain("postMessage");
  });

  test("removes every on* attribute", () => {
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) expect(attr.name.startsWith("on")).toBe(false);
    }
  });

  test("keeps http(s) and mailto links, drops javascript: and data:text/html links", () => {
    const hrefs = Array.from(doc.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://ok.example/path");
    expect(hrefs).toContain("mailto:a@b.com");
    expect(hrefs.filter((h) => h && /javascript|data:text/i.test(h))).toEqual([]);
    for (const a of Array.from(doc.querySelectorAll("a"))) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
  });

  test("blocks remote images, keeps inline data:image/png, drops data:image/svg+xml", () => {
    const srcs = Array.from(doc.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(srcs.some((s) => s?.includes("tracker.example"))).toBe(false);
    expect(srcs).toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(srcs.some((s) => s?.includes("svg"))).toBe(false);
    expect(out.hasRemoteImages).toBe(true);
  });

  test("drops dangerous inline styles but keeps ordinary ones and <style> blocks", () => {
    expect(out.srcDoc).not.toContain("expression(");
    expect(doc.querySelector("p")?.getAttribute("style")).toBe("color:blue");
    expect(out.srcDoc).toContain("p{color:red}");
  });

  // Review F3: the iframe srcdoc inherits the APP's CSP (next.config.ts), whose
  // img-src is an allowlist; a meta CSP can only narrow it. An opt-in "Show
  // images" could therefore never work, so remote images are always blocked.
  test("remote images are always blocked: the CSP never allows https images and no option can change that", () => {
    // A stale caller still passing the removed option must not be able to relax anything.
    const legacyCall = sanitizeEmailHtml as unknown as (html: string, options: { allowRemoteImages: boolean }) => ReturnType<typeof sanitizeEmailHtml>;
    const attempt = legacyCall(HOSTILE, { allowRemoteImages: true });
    const attemptDoc = bodyOf(attempt.srcDoc);
    const csp = attemptDoc.head.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
    expect(csp).toContain("img-src data:");
    expect(csp).not.toContain("https:");
    expect(attemptDoc.querySelector('img[src^="http"]')).toBeNull();
    expect(attempt.hasRemoteImages).toBe(true);
  });

  test("a message with no remote images reports hasRemoteImages=false", () => {
    expect(sanitizeEmailHtml("<p>plain</p>").hasRemoteImages).toBe(false);
    expect(sanitizeEmailHtml('<img src="data:image/png;base64,iVBORw0KGgo=">').hasRemoteImages).toBe(false);
  });

  test.each([
    ["a style attribute url()", '<div style="background:url(https://t.example/x.png)">x</div>'],
    ["a protocol-relative style url()", "<div style=\"background-image: url( '//t.example/x.png' )\">x</div>"],
    ["a <style> block url()", "<style>.a{background:url(https://t.example/x.png)}</style><p class=a>x</p>"],
    ["an SVG <image> href", '<svg><image href="https://t.example/x.png"></image></svg><p>x</p>'],
    ["an SVG <image> xlink:href", '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://t.example/x.png"/></svg><p>x</p>'],
    ["an img srcset", '<img srcset="https://t.example/a.png 1x, https://t.example/b.png 2x">'],
    ["a table background", '<table background="https://t.example/x.png"><tr><td>x</td></tr></table>'],
  ])("detects a remote image behind %s", (_name, html) => {
    expect(sanitizeEmailHtml(html).hasRemoteImages).toBe(true);
  });

  test("a hostile attribute value cannot break out of the CSP meta", () => {
    // csp content is a constant, but the body style attribute is copied: make sure it is escaped.
    const result = sanitizeEmailHtml('<body style="x&quot;><script>1</script>"><p>hi</p>');
    expect(bodyOf(result.srcDoc).querySelectorAll("script")).toHaveLength(0);
  });
});

// Review F4: namespace-confusion (mXSS). The payload below survives one
// DOMParser pass and turns into live <img onerror> markup when the produced
// string is parsed again inside the iframe. Sandbox and CSP contained it, but
// the sanitizer must not claim more than it does.
describe("sanitizeEmailHtml: mutation XSS", () => {
  const MXSS =
    '<math><mtext><table><mglyph><style><!--</style><xmp>--><a href="https://evil.test/" id=pwn>x</a><img src="https://tracker.test/mx4.png" onerror="1"></xmp>';

  function assertInert(srcDoc: string) {
    const again = bodyOf(srcDoc);
    expect(again.querySelectorAll("[onerror]")).toHaveLength(0);
    expect(again.querySelectorAll('img[src^="http"]')).toHaveLength(0);
    expect(again.querySelectorAll("math, svg, script, iframe, xmp")).toHaveLength(0);
    for (const el of Array.from(again.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) expect(attr.name.startsWith("on"), attr.name).toBe(false);
    }
  }

  test("the reported payload is inert after the iframe re-parses the srcDoc", () => {
    assertInert(sanitizeEmailHtml(MXSS).srcDoc);
  });

  test.each([
    ["svg style", '<svg><style><!--</style><img src="https://t.test/a.png" onerror="1">--></style></svg>'],
    ["math annotation-xml", '<math><annotation-xml encoding="text/html"><img src=x onerror=1></annotation-xml></math>'],
    ["svg title", '<svg><title><style><img src="https://t.test/b.png" onerror="1"></style></title></svg>'],
    ["svg with script and remote image", '<svg><script>alert(1)</script><image href="https://t.test/c.png"/></svg><p>kept</p>'],
  ])("variant: %s", (_name, html) => {
    assertInert(sanitizeEmailHtml(html).srcDoc);
  });

  test("svg and math content is removed, ordinary content around it is kept", () => {
    const out = sanitizeEmailHtml('<p>before</p><svg><circle r="1"/></svg><math><mi>x</mi></math><p>after</p>');
    const doc = bodyOf(out.srcDoc);
    expect(doc.querySelectorAll("svg, math")).toHaveLength(0);
    expect(doc.body.textContent).toContain("before");
    expect(doc.body.textContent).toContain("after");
  });

  test.each([
    ["a removed element", "<p>x</p><svg></svg>"],
    ["an on* attribute", "<p onclick=1>x</p>"],
    ["a remote image source", '<img src="https://t.test/x.png">'],
    ["a javascript: link", '<a href="javascript:1">x</a>'],
    ["a dangerous inline style", '<p style="width:expression(1)">x</p>'],
  ])("the fixed-point check flags re-parsed markup that still has %s", (_name, markup) => {
    expect(isStillUnsafe(markup)).toBe(true);
  });

  test("the fixed-point check passes clean markup", () => {
    expect(isStillUnsafe('<p style="color:red">x</p><a href="https://ok.test/">y</a><img src="data:image/png;base64,AA==">')).toBe(false);
  });

  test("normal mail is not flagged unsafe", () => {
    const out = sanitizeEmailHtml("<p>Hello <b>there</b></p><table><tr><td>x</td></tr></table>");
    expect(out.unsafe).toBe(false);
    expect(bodyOf(out.srcDoc).body.textContent).toContain("Hello");
  });
});
