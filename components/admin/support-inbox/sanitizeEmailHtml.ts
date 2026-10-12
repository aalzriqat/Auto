/**
 * Builds the `srcDoc` for the sandboxed email iframe.
 *
 * The HTML body of an inbound email is attacker-controlled. Three independent
 * layers keep it inert, and none of them relies on the others:
 *
 *   1. The iframe is `sandbox` WITHOUT allow-scripts and WITHOUT allow-same-origin
 *      (set by the caller): no script can run and the frame has an opaque origin
 *      with no access to the app's cookies, storage or DOM.
 *   2. A CSP <meta> that is the FIRST thing in <head>: `default-src 'none'`, so
 *      even a sanitizer miss cannot load a script, frame, font, form target or
 *      a remote image. Remote images are ALWAYS blocked: an iframe srcdoc also
 *      inherits the app's own CSP (next.config.ts), whose img-src is an
 *      allowlist that a meta tag can only narrow, never widen, so an opt-in
 *      "show images" could not work and is not offered.
 *   3. This DOMParser pass, which drops the dangerous elements and attributes,
 *      followed by a fixed-point check: the produced markup is parsed AGAIN (as
 *      the iframe will) and, if anything dangerous reappears — the mutation-XSS
 *      class, where one parse and one serialization disagree about namespaces —
 *      the body is discarded and `unsafe` is reported. It is defence in depth,
 *      not the primary control.
 *
 * Client-only (needs DOMParser). The result is a string for `srcDoc`; it is
 * never injected into the main document.
 */

/**
 * Elements removed outright, together with their children. `svg` and `math`
 * are removed wholesale: their different parsing rules are what namespace
 * confusion (mXSS) abuses, and email has no need for them.
 */
const REMOVED_SELECTOR = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "meta",
  "link",
  "base",
  "title",
  "noscript",
  "template",
  "foreignObject",
  "svg",
  "math",
  "audio",
  "video",
  "source",
  "track",
].join(",");

const URL_ATTRIBUTES = ["href", "src", "xlink:href", "action", "formaction", "background", "poster", "data", "cite"];

const IMAGE_SOURCE_ATTRIBUTES = ["src", "background", "poster"];

/** `url(http…)` / `url(//…)` in CSS: a remote image (or font) reference. */
const REMOTE_CSS_URL = /url\(\s*['"]?\s*(?:https?:)?\/\//i;

/** SVG elements whose href loads an image. Detected before svg is removed. */
const SVG_IMAGE_ELEMENTS: ReadonlySet<string> = new Set(["image", "feimage"]);

export interface SanitizedEmail {
  /** Complete HTML document for `<iframe srcDoc>`. */
  srcDoc: string;
  /** True when the original message references at least one remote image (all are blocked). */
  hasRemoteImages: boolean;
  /**
   * True when the markup could not be made safe and the body was discarded
   * (`srcDoc` then has an empty body). The caller shows a placeholder instead.
   */
  unsafe: boolean;
}

function isRemoteUrl(value: string): boolean {
  return /^\s*(?:https?:)?\/\//i.test(value);
}

/** Only these schemes may remain in href/src-like attributes. */
function isSafeUrl(attribute: string, value: string): boolean {
  const trimmed = value.replace(/[\u0000- ]+/g, "").toLowerCase();
  if (trimmed === "" || trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("data:")) return /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);/.test(trimmed);
  if (/^(?:https?:)?\/\//.test(trimmed)) return true;
  if (attribute === "href" && (trimmed.startsWith("mailto:") || trimmed.startsWith("tel:"))) return true;
  // Relative paths have nowhere to resolve to inside an opaque-origin srcDoc.
  return !/^[a-z][a-z0-9+.-]*:/.test(trimmed);
}

const DANGEROUS_STYLE = /expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:|@import/i;

const BASE_STYLE =
  "html,body{margin:0;padding:0}body{padding:12px;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f1e1d;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'";

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Does this element reference a remote image (attribute, CSS url(), or SVG href)? */
function referencesRemoteImage(element: Element): boolean {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    if (IMAGE_SOURCE_ATTRIBUTES.includes(name) && isRemoteUrl(value)) return true;
    if (name === "srcset" && /(?:^|[\s,])(?:https?:)?\/\//i.test(value)) return true;
    if (name === "style" && REMOTE_CSS_URL.test(value)) return true;
    if (
      (name === "href" || name === "xlink:href") &&
      SVG_IMAGE_ELEMENTS.has(element.localName.toLowerCase()) &&
      isRemoteUrl(value)
    ) {
      return true;
    }
  }
  if (element.localName.toLowerCase() === "style" && REMOTE_CSS_URL.test(element.textContent ?? "")) return true;
  return false;
}

/**
 * The fixed-point check. Parses `markup` the way the iframe will and reports
 * whether anything the sanitizer is supposed to have removed is present: a
 * removed element, an on* attribute, an unsafe or remote URL, a dangerous style.
 */
export function isStillUnsafe(markup: string): boolean {
  if (typeof DOMParser === "undefined") return false;
  const doc = parse(markup);
  if (doc.querySelector(REMOVED_SELECTOR)) return true;
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    if (element.localName.toLowerCase() === "style" && DANGEROUS_STYLE.test(element.textContent ?? "")) return true;
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) return true;
      if (name === "style" && DANGEROUS_STYLE.test(attribute.value)) return true;
      if (name === "srcset" && attribute.value.trim() !== "") return true;
      if (URL_ATTRIBUTES.includes(name)) {
        if (!isSafeUrl(name, attribute.value)) return true;
        if (IMAGE_SOURCE_ATTRIBUTES.includes(name) && isRemoteUrl(attribute.value)) return true;
      }
    }
  }
  return false;
}

export function sanitizeEmailHtml(html: string): SanitizedEmail {
  const shell = (head: string, body: string, bodyAttributes = "") =>
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(
      CSP
    )}"><base target="_blank">${head}</head><body${bodyAttributes}>${body}</body></html>`;

  if (typeof DOMParser === "undefined") {
    // Server render / non-DOM environment: render nothing rather than raw markup.
    return { srcDoc: shell(`<style>${BASE_STYLE}</style>`, ""), hasRemoteImages: false, unsafe: false };
  }

  const doc = parse(html);

  // Remote-image detection runs BEFORE removal so that images referenced from
  // inside elements that are about to be dropped (SVG <image>) still count.
  let hasRemoteImages = false;
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    if (referencesRemoteImage(element)) {
      hasRemoteImages = true;
      break;
    }
  }

  // Style blocks are kept (email layout depends on them) but are scanned first.
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    if (DANGEROUS_STYLE.test(style.textContent ?? "")) style.remove();
  }

  for (const element of Array.from(doc.querySelectorAll(REMOVED_SELECTOR))) element.remove();

  for (const element of Array.from(doc.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;

      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style") {
        if (DANGEROUS_STYLE.test(value)) element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "srcset") {
        // Remote images are always blocked; the CSP would refuse the load anyway.
        element.removeAttribute(attribute.name);
        continue;
      }
      if (URL_ATTRIBUTES.includes(name)) {
        if (!isSafeUrl(name, value)) {
          element.removeAttribute(attribute.name);
          continue;
        }
        // Dropping the attribute as well as relying on the CSP avoids a
        // broken-image icon and a needless request attempt.
        if (IMAGE_SOURCE_ATTRIBUTES.includes(name) && isRemoteUrl(value)) element.removeAttribute(attribute.name);
      }
    }

    if (element.tagName.toLowerCase() === "a") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer nofollow");
    }
  }

  const headStyles = Array.from(doc.head.querySelectorAll("style"))
    .map((style) => style.outerHTML)
    .join("");
  // Remaining <style> in the body stay in place via body.innerHTML.
  const bodyHtml = doc.body.innerHTML;

  // Fixed point: what the iframe will parse must be as clean as what we built.
  if (isStillUnsafe(`${headStyles}${bodyHtml}`)) {
    return { srcDoc: shell(`<style>${BASE_STYLE}</style>`, ""), hasRemoteImages, unsafe: true };
  }

  const bodyStyle = doc.body.getAttribute("style");
  const bodyBgColor = doc.body.getAttribute("bgcolor");
  const bodyAttributes =
    (bodyStyle && !DANGEROUS_STYLE.test(bodyStyle) ? ` style="${escapeAttribute(bodyStyle)}"` : "") +
    (bodyBgColor ? ` bgcolor="${escapeAttribute(bodyBgColor)}"` : "");

  return {
    srcDoc: shell(`<style>${BASE_STYLE}</style>${headStyles}`, bodyHtml, bodyAttributes),
    hasRemoteImages,
    unsafe: false,
  };
}
