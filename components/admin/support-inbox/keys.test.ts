import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { dictionaries } from "@/lib/i18n/dictionaries";

/**
 * The inbox resolves several labels through lookup tables (`t(MAP[key])`), which
 * lib/i18n/keyCoverage.test.ts cannot see. Scan every SupportInbox* identifier
 * in the component sources instead, so a typo cannot ship as raw key text.
 */
const DIR = __dirname;
const sources = fs
  .readdirSync(DIR)
  .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => fs.readFileSync(path.join(DIR, file), "utf8"));
const used = new Set(sources.flatMap((source) => source.match(/\bSupportInbox[A-Za-z]+\b/g) ?? []));
// The component itself is called SupportInbox and its props are not keys.
used.delete("SupportInbox");

describe("support inbox translations", () => {
  test("the scan finds the keys", () => {
    expect(used.size).toBeGreaterThan(40);
  });
  test.each(["en", "ar"] as const)("every key used by the components exists in %s", (locale) => {
    const dictionary = dictionaries[locale] as Record<string, string>;
    expect([...used].filter((key) => !dictionary[key])).toEqual([]);
  });
  test("every SupportInbox key is translated, not copied", () => {
    const en = dictionaries.en as Record<string, string>;
    const ar = dictionaries.ar as Record<string, string>;
    const keys = Object.keys(en).filter((key) => key.startsWith("SupportInbox"));
    expect(keys.length).toBeGreaterThan(40);
    // Arabic entries must contain Arabic script, except pure-shortcut hints.
    const untranslated = keys.filter((key) => !/[؀-ۿ]/.test(ar[key] ?? "") && key !== "SupportInboxPosition");
    expect(untranslated).toEqual([]);
  });
});
