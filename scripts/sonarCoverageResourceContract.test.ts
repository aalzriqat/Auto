import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const TEST_WORKFLOW = path.join(ROOT, ".github", "workflows", "test.yml");
const SONAR_MAIN_WORKFLOW = path.join(ROOT, ".github", "workflows", "sonar-main.yml");

function source(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("Sonar coverage resource contract", () => {
  test("main Sonar coverage uses the same bounded heap ceiling as PR coverage", () => {
    const prCoverage = source(TEST_WORKFLOW);
    const mainCoverage = source(SONAR_MAIN_WORKFLOW);

    expect(prCoverage).toMatch(
      /Run unit \+ integration tests with coverage[\s\S]*?NODE_OPTIONS:\s*--max-old-space-size=5632/,
    );
    expect(mainCoverage).toMatch(
      /Generate coverage for Sonar[\s\S]*?NODE_OPTIONS:\s*--max-old-space-size=5632/,
    );
  });
});
