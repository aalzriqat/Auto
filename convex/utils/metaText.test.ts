import { describe, expect, it } from "vitest";
import { collectTextParts } from "./metaText";

// A real Instagram DM carrying a photo. Meta sends no message text at all —
// the only string in the payload is the signed CDN link to the media.
const MEDIA_DM = {
  mid: "m_abc",
  attachments: [
    {
      type: "image",
      payload: {
        url: "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=67089&signature=AbOvityCFeAjJsEdCULgQAWS1qj849HkKTrfv7UKAkREgFI7zCN1hNicf-dlJqIUGVBCzLRsuKxocZi7JdzlOfXTQiihuHtGyaZnuOaf_410UcE4rRDE71VXC4_rfHrAKv0Nk",
      },
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
