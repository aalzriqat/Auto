/**
 * SCRUM-664: in Arabic the wizard's Next arrow pointed right, which in RTL is
 * backwards. Every left/right directional icon in the wizard must mirror in
 * RTL, using the repo's `rtl:-scale-x-100` / `rtl:rotate-180` convention.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const WIZARD_DIR = __dirname;
const DIRECTIONAL_ICON = /<(ArrowLeft|ArrowRight|ChevronLeft|ChevronRight)\b[^>]*>/g;
// The flip must sit in a static className string, so a conditional class
// (e.g. `isRtl ? "" : "rtl:-scale-x-100"`) cannot satisfy it.
const RTL_FLIP = /\bclassName="[^"]*\brtl:(-scale-x-100|rotate-180)\b[^"]*"/;

function wizardSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return wizardSources(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("SCRUM-664: wizard arrows follow the reading direction", () => {
  const files = [...wizardSources(WIZARD_DIR), join(WIZARD_DIR, "../SalesWizard.tsx")];

  test("the wizard has directional icons to check", () => {
    const count = files.reduce(
      (total, file) => total + (readFileSync(file, "utf8").match(DIRECTIONAL_ICON)?.length ?? 0),
      0
    );
    expect(count).toBeGreaterThanOrEqual(4);
  });

  test.each(files.map((file) => [relative(WIZARD_DIR, file), file]))(
    "%s mirrors every left/right arrow in RTL",
    (_name, file) => {
      const unflipped = (readFileSync(file, "utf8").match(DIRECTIONAL_ICON) ?? []).filter(
        (tag) => !RTL_FLIP.test(tag)
      );
      expect(unflipped).toEqual([]);
    }
  );
});
