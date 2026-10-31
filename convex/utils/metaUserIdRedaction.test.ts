import { describe, expect, test } from "vitest";
import { maskMetaUserIdsForAdmin, metaOauthLogSource, redactMetaUserIdInText, REDACTED_META_USER } from "./metaUserIdRedaction";

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
