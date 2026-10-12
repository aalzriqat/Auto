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
 *      (by default) a remote image.
 *   3. This DOMParser pass, which drops the dangerous elements and attributes.
 *      It is defence in depth, not the primary control.
 *
 * Client-only (needs DOMParser). The result is a string for `srcDoc`; it is
 * never injected into the main document.
 */

/** Elements removed outright, together with their children. */
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
  "audio",
  "video",
  "source",
  "track",
].join(",");

const URL_ATTRIBUTES = ["href", "src", "xlink:href", "action", "formaction", "background", "poster", "data", "cite"];

const IMAGE_CSP_REMOTE = "img-src data: https:";
const IMAGE_CSP_BLOCKED = "img-src data:";

export interface SanitizedEmail {
  /** Complete HTML document for `<iframe srcDoc>`. */
  srcDoc: string;
  /** True when the original message references at least one remote image. */
  hasRemoteImages: boolean;
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

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function sanitizeEmailHtml(html: string, options: { allowRemoteImages: boolean }): SanitizedEmail {
  const csp = `default-src 'none'; style-src 'unsafe-inline'; ${
    options.allowRemoteImages ? IMAGE_CSP_REMOTE : IMAGE_CSP_BLOCKED
  }; font-src 'none'; form-action 'none'`;
  const shell = (head: string, body: string, bodyAttributes = "") =>
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(
      csp
    )}"><base target="_blank">${head}</head><body${bodyAttributes}>${body}</body></html>`;

  if (typeof DOMParser === "undefined") {
    // Server render / non-DOM environment: render nothing rather than raw markup.
    return { srcDoc: shell(`<style>${BASE_STYLE}</style>`, ""), hasRemoteImages: false };
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  let hasRemoteImages = false;

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
        hasRemoteImages = hasRemoteImages || /(?:^|[\s,])(?:https?:)?\/\//i.test(value);
        if (!options.allowRemoteImages) element.removeAttribute(attribute.name);
        continue;
      }
      if (URL_ATTRIBUTES.includes(name)) {
        if (!isSafeUrl(name, value)) {
          element.removeAttribute(attribute.name);
          continue;
        }
        const isImageSource = name === "src" || name === "background" || name === "poster";
        if (isImageSource && isRemoteUrl(value)) {
          hasRemoteImages = true;
          // With images blocked the CSP already refuses the load; dropping the
          // attribute as well avoids a broken-image icon and a needless request attempt.
          if (!options.allowRemoteImages) element.removeAttribute(attribute.name);
        }
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
  const bodyStyle = doc.body.getAttribute("style");
  const bodyBgColor = doc.body.getAttribute("bgcolor");
  const bodyAttributes =
    (bodyStyle && !DANGEROUS_STYLE.test(bodyStyle) ? ` style="${escapeAttribute(bodyStyle)}"` : "") +
    (bodyBgColor ? ` bgcolor="${escapeAttribute(bodyBgColor)}"` : "");

  return {
    srcDoc: shell(`<style>${BASE_STYLE}</style>${headStyles}`, doc.body.innerHTML, bodyAttributes),
    hasRemoteImages,
  };
}
