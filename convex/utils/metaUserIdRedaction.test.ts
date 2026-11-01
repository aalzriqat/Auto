import { describe, expect, test } from "vitest";
import {
  maskMetaErrorForAdmin,
  maskMetaUserIdsForAdmin,
  META_LOG_REDACTION_MAX_BYTES_READ,
  META_LOG_REDACTION_PAGE_SIZE,
  metaOauthLogSource,
  nextRedactionPageSize,
  redactMetaUserIdInText,
  REDACTED_META_USER,
} from "./metaUserIdRedaction";

// SCRUM-842: the one definition of "a Meta user id in a log summary" shared by
// the stored-row redaction and the admin reader. Ids here are synthetic.

const ID = "990000000000842";

describe("redactMetaUserIdInText", () => {
  test("replaces every standalone occurrence of the id and nothing else", () => {
    expect(redactMetaUserIdInText(`Deauthorized by Facebook user ${ID}`, ID)).toBe(
      `Deauthorized by Facebook user ${REDACTED_META_USER}`,
    );
    expect(redactMetaUserIdInText(`${ID} then ${ID}.`, ID)).toBe(`${REDACTED_META_USER} then ${REDACTED_META_USER}.`);
  });

  test("leaves a different id that contains this one, or sits inside a longer token", () => {
    for (const text of [`user ${ID}7`, `user 7${ID}`, `user a${ID}`, `user ${ID}b`]) {
      expect(redactMetaUserIdInText(text, ID)).toBe(text);
    }
  });

  test("an id with regular-expression or replacement characters is matched literally", () => {
    const tricky = "a.b+c$&(d)";
    expect(redactMetaUserIdInText(`user ${tricky}`, tricky)).toBe(`user ${REDACTED_META_USER}`);
    expect(redactMetaUserIdInText("user aXb+c$&(d)", tricky)).toBe("user aXb+c$&(d)");
  });

  test("an empty id changes nothing, and running twice changes nothing more", () => {
    expect(redactMetaUserIdInText("anything", "")).toBe("anything");
    const once = redactMetaUserIdInText(`user ${ID}`, ID);
    expect(redactMetaUserIdInText(once, ID)).toBe(once);
  });
});

describe("maskMetaUserIdsForAdmin", () => {
  test("masks the id after the pre-fix wording in every Meta source", () => {
    for (const source of ["facebook-oauth", "instagram-oauth", "facebook", "instagram"]) {
      expect(maskMetaUserIdsForAdmin(source, `Data deletion requested by Instagram user ${ID}`)).toBe(
        `Data deletion requested by Instagram user ${REDACTED_META_USER}`,
      );
    }
  });

  test("masks a bare nine-digit-or-longer id in the callback sources only", () => {
    expect(maskMetaUserIdsForAdmin("facebook-oauth", `seen ${ID} here`)).toBe(`seen ${REDACTED_META_USER} here`);
    expect(maskMetaUserIdsForAdmin("facebook-oauth", "seen 12345678 here")).toBe("seen 12345678 here");
    expect(maskMetaUserIdsForAdmin("facebook-oauth", "seen 123456789 here")).toBe(`seen ${REDACTED_META_USER} here`);
    expect(maskMetaUserIdsForAdmin("facebook", `Facebook Page ${ID} is connected to more than one org`)).toBe(
      `Facebook Page ${ID} is connected to more than one org`,
    );
  });

  test("never touches a source that is not Meta's, or text that is already redacted or ordinary", () => {
    expect(maskMetaUserIdsForAdmin("clerk", `Instagram user ${ID}`)).toBe(`Instagram user ${ID}`);
    const redacted = `Deauthorized by Facebook user ${REDACTED_META_USER}`;
    expect(maskMetaUserIdsForAdmin("facebook-oauth", redacted)).toBe(redacted);
    expect(maskMetaUserIdsForAdmin("facebook-oauth", "Connected for org jd7abc123def456ghi789jkl012mno3")).toBe(
      "Connected for org jd7abc123def456ghi789jkl012mno3",
    );
  });
});

test("the callback log source is named per platform", () => {
  expect(metaOauthLogSource("facebook")).toBe("facebook-oauth");
  expect(metaOauthLogSource("instagram")).toBe("instagram-oauth");
});

describe("the Instagram account id in a subscribed_apps failure row", () => {
  const LINE = "subscribed_apps failed for IG account 17841400000000001";

  test("the summary mask covers the 'IG account <id>' wording on the instagram source", () => {
    expect(maskMetaUserIdsForAdmin("instagram", LINE)).toBe(`subscribed_apps failed for IG account ${REDACTED_META_USER}`);
  });

  test("it does not touch the same wording on a source that is not Meta's, or an id already redacted", () => {
    expect(maskMetaUserIdsForAdmin("clerk", LINE)).toBe(LINE);
    const redacted = `subscribed_apps failed for IG account ${REDACTED_META_USER}`;
    expect(maskMetaUserIdsForAdmin("instagram", redacted)).toBe(redacted);
  });

  test("a Facebook Page id in the facebook source is still left alone", () => {
    expect(maskMetaUserIdsForAdmin("facebook", "subscribed_apps failed for Page 123456789012")).toBe(
      "subscribed_apps failed for Page 123456789012",
    );
  });
});

describe("maskMetaErrorForAdmin", () => {
  test("masks an id-shaped run, the legacy user wording and the IG account wording in the error of every Meta source", () => {
    for (const source of ["facebook-oauth", "instagram-oauth", "facebook", "instagram"]) {
      expect(
        maskMetaErrorForAdmin(source, `Unsupported post request. Object with ID '${ID}' does not exist; IG account ${ID}; Instagram user ${ID}`),
      ).toBe(
        `Unsupported post request. Object with ID '${REDACTED_META_USER}' does not exist; IG account ${REDACTED_META_USER}; Instagram user ${REDACTED_META_USER}`,
      );
    }
  });

  test("passes an absent error, ordinary text and a non-Meta source through unchanged", () => {
    expect(maskMetaErrorForAdmin("instagram", undefined)).toBeUndefined();
    expect(maskMetaErrorForAdmin("instagram", "Webhook subscription failed; provider detail withheld.")).toBe(
      "Webhook subscription failed; provider detail withheld.",
    );
    expect(maskMetaErrorForAdmin("clerk", `error ${ID}`)).toBe(`error ${ID}`);
  });
});

describe("nextRedactionPageSize", () => {
  const MiB = 1024 * 1024;

  test("a page of one-line summaries stays at the full page", () => {
    expect(nextRedactionPageSize(100, 100 * 300)).toBe(META_LOG_REDACTION_PAGE_SIZE);
  });

  test("an empty page, or no information, asks for the full page", () => {
    expect(nextRedactionPageSize(0, 0)).toBe(META_LOG_REDACTION_PAGE_SIZE);
    expect(nextRedactionPageSize(5, 0)).toBe(META_LOG_REDACTION_PAGE_SIZE);
  });

  test("large webhook bodies get a small page that fits half the byte budget", () => {
    const next = nextRedactionPageSize(4, 4 * 700_000);
    expect(next).toBe(Math.floor(META_LOG_REDACTION_MAX_BYTES_READ / 2 / 700_000));
    expect(next * 700_000).toBeLessThanOrEqual(META_LOG_REDACTION_MAX_BYTES_READ / 2);
  });

  test("it never asks for fewer than one row, even if one row is as large as a document can be", () => {
    expect(nextRedactionPageSize(1, 1 * MiB)).toBeGreaterThanOrEqual(1);
    expect(nextRedactionPageSize(1, 100 * MiB)).toBe(1);
  });

  test("the byte budget leaves room for the rewrite: below the 16 MiB read and write limits at 2.3x growth", () => {
    expect(META_LOG_REDACTION_MAX_BYTES_READ * 2.3).toBeLessThan(16 * MiB);
  });
});