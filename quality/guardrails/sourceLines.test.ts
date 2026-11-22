import { describe, expect, test } from "vitest";
import { physicalLines } from "./sourceLines.mjs";
import { baseConfig, check, fixtureRepo, registerFixtureCleanup, write, writeConfig } from "./testkit";

registerFixtureCleanup();

function declaration(lines: number): string {
  return "// retained source line\n".repeat(lines - 1) + "export const available = true;\n";
}

describe("repository source size", () => {
  test.each([
    ["", 0],
    ["one\n\nthree\n", 3],
    ["one\r\n\r\nthree", 3],
    ["one\rtwo\r", 2],
  ])("counts physical lines in %j", (text, expected) => {
    expect(physicalLines(text)).toBe(expected);
  });

  test("enforces the default outside production directories and honors reviewed cohesion up to 800", async () => {
    const root = fixtureRepo();
    const file = "convex/cohesive.ts";
    write(root, "scripts/sizeBoundary.test.ts", declaration(600));
    write(root, "scripts/oversized.test.ts", declaration(601));
    write(root, file, declaration(800));
    const config = baseConfig();
    config.sourceLineExceptions = [{ path: file, reason: "One ordered integration fixture for the file-size policy." }];
    writeConfig(root, config);
    const result = await check(root);
    expect(result.errors).toEqual([expect.stringMatching(/^SOURCE-LINES-DEFAULT scripts\/oversized.test.ts:/)]);
    expect(result.notices).toContainEqual(expect.stringMatching(/^SOURCE-LINES-EXCEPTION convex\/cohesive.ts: 800 physical lines/));
  });

  test("blocks any new or growing source above 800 even if the file has an exemption", async () => {
    const legacy = "scripts/old.ts";
    const fresh = "convex/new.ts";
    const root = fixtureRepo({ [legacy]: declaration(801) });
    write(root, legacy, declaration(802));
    write(root, fresh, declaration(801));
    const config = baseConfig();
    config.sourceLineExceptions = [{ path: fresh, reason: "This rationale cannot override the physical maximum." }];
    writeConfig(root, config);
    const result = await check(root);
    expect(result.errors).toContainEqual(expect.stringMatching(/^SOURCE-LINES-MAX convex\/new.ts:/));
    expect(result.errors).toContainEqual(expect.stringMatching(/^SOURCE-LINES-MAX scripts\/old.ts:/));
  });

  test("allows a legacy file to shrink and reports the remaining debt", async () => {
    const legacy = "scripts/old.ts";
    const root = fixtureRepo({ [legacy]: declaration(802) });
    write(root, legacy, declaration(801));
    const result = await check(root);
    expect(result.errors).toEqual([]);
    expect(result.notices).toContainEqual(expect.stringMatching(/^SOURCE-LINES-LEGACY scripts\/old.ts: 802 → 801/));
  });
});
