import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// The deal cockpit visual gate's frame census, shared by the PR workflow
// (playwright.yml) and the main workflow (trusted-main-e2e.yml). It used to be
// an inline shell block copied into both, and the copies drifted: SCRUM-417 UX3
// added '*-expanded-top.png' frames, only the PR copy learned to subtract them,
// and main's copy counted 24 base frames instead of 16 — failing the required
// 'playwright' release check on every main commit and skipping main E2E
// (SCRUM-489). One census, two callers.
//
// Each class of frame is counted exactly, so a matrix that silently shrank
// cannot hide behind another class that grew.
export const EXPECTED_FRAMES = [
  { key: "base", count: 16, what: "base screenshots (2 locales x 2 themes x 2 viewports x top/bottom)" },
  { key: "expanded", count: 8, what: "expanded Deal details screenshots (2 locales x 2 themes x 2 viewports, SCRUM-417 UX3)" },
  { key: "nextStep", count: 16, what: "withheld-close next-step screenshots (2 variants x 8, SCRUM-414)" },
  { key: "panel", count: 8, what: "panel screenshots (SCRUM-414)" },
  { key: "forward", count: 16, what: "forward-step screenshots (2 variants x 2 locales x 2 themes x 2 viewports, SCRUM-435)" },
  // 9 frames x 8 (2 locales x 2 themes x 2 viewports): the 3 SCRUM-417 UX4
  // variants, plus SCRUM-446's na-rail (+rail frame), na-view (+rail frame)
  // and na-finished (+summary frame).
  { key: "ux4", count: 72, what: "UX4 checklist / step-view screenshots (9 frames x 2 locales x 2 themes x 2 viewports, SCRUM-417 UX4 + SCRUM-446)" },
];

/** Frame names sit exactly one directory below the results root (one per test). */
export function listFrames(resultsDir) {
  const frames = [];
  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(path.join(resultsDir, entry.name), { withFileTypes: true })) {
      if (file.isFile()) frames.push(file.name);
    }
  }
  return frames;
}

export function censusFrames(names) {
  // The part after 'deal-cockpit-', matching the old find globs
  // 'deal-cockpit-*<suffix>' exactly (the '*' must sit before the suffix's dash).
  const frames = names
    .filter((name) => name.startsWith("deal-cockpit-") && name.endsWith(".png"))
    .map((name) => name.slice("deal-cockpit-".length));
  const count = (suffix) => frames.filter((name) => name.endsWith(suffix)).length;
  // '-top.png' also matches '-expanded-top.png', so expanded frames are their
  // own class and subtracted from the base count.
  const expanded = count("-expanded-top.png");
  return {
    base: count("-top.png") - expanded + count("-bottom.png"),
    expanded,
    nextStep: count("-next-step.png"),
    panel: count("-panel.png"),
    // UX4 and forward frames end in their variant name, so no other class's
    // suffix can match them.
    ux4: frames.filter((name) => name.includes("-ux4-")).length,
    forward: frames.filter((name) => name.includes("-forward-")).length,
  };
}

export function frameCensusErrors(census) {
  return EXPECTED_FRAMES.filter(({ key, count }) => census[key] !== count).map(
    ({ key, count, what }) => `expected ${count} ${what}, found ${census[key]}`,
  );
}

/**
 * The CLI body, in-process so its branches are measured: writes the census
 * line and one line per short class, and returns the exit code.
 *
 * @param {string} resultsDir
 * @param {{ write(chunk: string): unknown }} [out]
 * @param {{ write(chunk: string): unknown }} [err]
 * @returns {0 | 1}
 */
export function runCensusCli(resultsDir, out = process.stdout, err = process.stderr) {
  const census = censusFrames(listFrames(resultsDir));
  out.write(
    `visual gate screenshots: base ${census.base}, expanded record ${census.expanded}, ` +
      `withheld-close next-step ${census.nextStep}, panel ${census.panel}, ux4 ${census.ux4}, forward ${census.forward}\n`,
  );
  const errors = frameCensusErrors(census);
  for (const error of errors) err.write(`${error}\n`);
  return errors.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runCensusCli(path.resolve(process.argv[2] ?? "test-results/deal-cockpit-visual"));
}
