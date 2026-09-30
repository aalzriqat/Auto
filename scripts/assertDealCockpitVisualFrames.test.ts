import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { censusFrames, frameCensusErrors } from "./assertDealCockpitVisualFrames.mjs";

const combos = ["en-light", "en-dark", "ar-light", "ar-dark"].flatMap((lt) =>
  ["390", "1280"].map((vp) => `${lt}-${vp}`),
);

/** One complete, correct frame set: the census the gate must accept. */
function completeFrameSet(): string[] {
  return combos.flatMap((c) => [
    `deal-cockpit-${c}-top.png`,
    `deal-cockpit-${c}-bottom.png`,
    `deal-cockpit-${c}-expanded-top.png`,
    `deal-cockpit-${c}-unreadable-next-step.png`,
    `deal-cockpit-${c}-no-access-next-step.png`,
    `deal-cockpit-${c}-panel.png`,
    `deal-cockpit-${c}-forward-ask.png`,
    `deal-cockpit-${c}-forward-done.png`,
    ...Array.from({ length: 9 }, (_, i) => `deal-cockpit-${c}-ux4-v${i}.png`),
  ]);
}

describe("deal cockpit visual frame census (SCRUM-489)", () => {
  test("a complete frame set passes — expanded-top frames do not inflate the base count", () => {
    const census = censusFrames(completeFrameSet());
    expect(census).toEqual({ base: 16, expanded: 8, nextStep: 16, panel: 8, ux4: 72, forward: 16 });
    expect(frameCensusErrors(census)).toEqual([]);
  });

  const classCases: Array<[string, keyof ReturnType<typeof censusFrames>]> = [
    ["-top.png", "base"],
    ["-expanded-top.png", "expanded"],
    ["-next-step.png", "nextStep"],
    ["-panel.png", "panel"],
    ["-forward-ask.png", "forward"],
    ["-ux4-v0.png", "ux4"],
  ];
  test.each(classCases)("a missing %s frame fails the %s class and no other", (suffix, key) => {
    const frames = completeFrameSet();
    const dropped = frames.findIndex((name) => name.endsWith(suffix));
    frames.splice(dropped, 1);
    const errors: string[] = frameCensusErrors(censusFrames(frames));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/found \d+$/);
    expect(censusFrames(frames)[key]).toBeLessThan(censusFrames(completeFrameSet())[key]);
  });

  test("names outside the deal-cockpit-*<suffix> globs are not counted", () => {
    const census = censusFrames([
      ...completeFrameSet(),
      "deal-cockpit-top.png", // no '*' segment before '-top'
      "other-en-light-390-top.png",
      "deal-cockpit-en-light-390-top.jpg",
    ]);
    expect(frameCensusErrors(census)).toEqual([]);
  });

  describe("CLI", () => {
    let dir = "";
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    function runCli(frames: string[]) {
      dir = mkdtempSync(path.join(os.tmpdir(), "dcv-census-"));
      frames.forEach((name, index) => {
        // One directory per test, frames one level down, as Playwright writes them.
        const testDir = path.join(dir, `test-${index % 5}`);
        mkdirSync(testDir, { recursive: true });
        writeFileSync(path.join(testDir, name), "");
      });
      return spawnSync(process.execPath, ["scripts/assertDealCockpitVisualFrames.mjs", dir], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
    }

    test("exits 0 on a complete set", () => {
      const result = runCli(completeFrameSet());
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("base 16, expanded record 8");
    });

    test("exits 1 and names the short class", () => {
      const result = runCli(completeFrameSet().filter((name) => !name.endsWith("-panel.png")));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("expected 8 panel screenshots (SCRUM-414), found 0");
    });
  });
});
