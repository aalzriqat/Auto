import { describe, expect, test } from "vitest";
import { sanitizeEmailHtml } from "./sanitizeEmailHtml";

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
  const out = sanitizeEmailHtml(HOSTILE, { allowRemoteImages: false });
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

  test("blocks remote images by default, keeps inline data:image/png, drops data:image/svg+xml", () => {
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

  test("allowing remote images relaxes only img-src and keeps the remote src", () => {
    const shown = sanitizeEmailHtml(HOSTILE, { allowRemoteImages: true });
    const shownDoc = bodyOf(shown.srcDoc);
    const csp = shownDoc.head
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute("content")!;
    expect(csp).toContain("img-src data: https:");
    expect(csp).toContain("default-src 'none'");
    expect(Array.from(shownDoc.querySelectorAll("img")).map((i) => i.getAttribute("src"))).toContain(
      "https://tracker.example/pixel.gif"
    );
    // Everything else stays removed.
    expect(shownDoc.querySelectorAll("script, iframe, form, object, embed")).toHaveLength(0);
  });

  test("a message with no remote images reports hasRemoteImages=false", () => {
    expect(sanitizeEmailHtml("<p>plain</p>", { allowRemoteImages: false }).hasRemoteImages).toBe(false);
  });

  test("a hostile attribute value cannot break out of the CSP meta", () => {
    // csp content is a constant, but the body style attribute is copied: make sure it is escaped.
    const result = sanitizeEmailHtml('<body style="x&quot;><script>1</script>"><p>hi</p>', {
      allowRemoteImages: false,
    });
    expect(bodyOf(result.srcDoc).querySelectorAll("script")).toHaveLength(0);
  });
});
