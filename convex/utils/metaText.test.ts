import { describe, expect, it } from "vitest";
import { collectTextParts } from "./metaText";

// A real Instagram DM carrying a photo. Meta sends no message text at all —
// the only string in the payload is the signed CDN link to the media.
// URL-shaped but entirely synthetic. A real capture would put a live media
// signature into source control on a public repo — the exact leak this module
// exists to prevent.
const SYNTHETIC_CDN_URL =
  "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=test-asset&signature=test-signature";

const MEDIA_DM = {
  mid: "m_abc",
  attachments: [
    {
      type: "image",
      payload: {
        url: SYNTHETIC_CDN_URL,
      },
    },
    // Meta also sends `payload` as a bare string for some attachment types.
    // Without this case the suite passes even if `payload` is dropped from
    // ATTACHMENT_URL_KEYS and only `url` is filtered.
    {
      type: "template",
      payload: "https://lookaside.fbsbx.com/scalar?signature=test-scalar-signature",
    },
  ],
};

describe("collectTextParts", () => {
  it("does not treat an attachment's signed CDN url as message text", () => {
    const parts = collectTextParts(MEDIA_DM);

    expect(parts.join(" ")).not.toContain("lookaside.fbsbx.com");
    expect(parts.join(" ")).not.toContain("signature=");
    // "image" (the attachment's `type`) is still harvested — it is a useful
    // hint and carries no credential. What must not survive is the URL.
    expect(parts.some((p) => p.startsWith("http"))).toBe(false);
  });

  it("suppresses a scalar attachment payload, not just payload.url", () => {
    const parts = collectTextParts(MEDIA_DM);
    expect(parts.join(" ")).not.toContain("test-scalar-signature");
  });

  it("still reads text the customer actually typed", () => {
    const parts = collectTextParts({
      text: "Is the 2022 Camry still available?",
    });
    expect(parts).toContain("Is the 2022 Camry still available?");
  });

  it("keeps a link the customer typed themselves", () => {
    // Arrives in `text`, not under `attachments`, so the attachment rule must
    // not swallow it — a customer pasting a listing link is real signal.
    const typed = "look at this https://example.com/car/123";
    const parts = collectTextParts({ text: typed });
    expect(parts).toContain(typed);
  });

  it("keeps a top-level referral url, which is genuine context", () => {
    const parts = collectTextParts({
      referral: {
        ref: "campaign-42",
        url: "https://m.me/dealer?ref=campaign-42",
      },
    });
    expect(parts).toContain("https://m.me/dealer?ref=campaign-42");
    expect(parts).toContain("campaign-42");
  });

  it("suppresses attachment urls at any nesting depth", () => {
    const parts = collectTextParts({
      data: [{ data: [MEDIA_DM] }],
    });
    expect(parts.join(" ")).not.toContain("signature=");
  });
});
