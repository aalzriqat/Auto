import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { dictionaries, type TranslationKey } from "@/lib/i18n/dictionaries";
import { keySaveErrorMessage } from "./keySaveError";

const SECRET = "sk-ant-api03-TEST-ONLY-not-a-real-key-wxyz";

describe("keySaveErrorMessage", () => {
  test.each(["en", "ar"] as const)("translates each coded AI key refusal in %s", (locale) => {
    const t = (key: TranslationKey) => dictionaries[locale][key];
    for (const code of ["AI_KEY_FORMAT_INVALID", "AI_KEY_ENCRYPTION_NOT_CONFIGURED", "AI_KEY_SAVE_FAILED"]) {
      const text = keySaveErrorMessage({
        error: new ConvexError({ code, message: "English fallback" }),
        submittedKey: SECRET,
        t,
      });
      expect(text).toBe(dictionaries[locale][`ServerError_${code}` as TranslationKey]);
      expect(text).not.toBe("English fallback");
    }
  });
});
