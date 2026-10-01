import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { appendSharedLcov, isSharedSourcePath, main } from "./appendSharedLcov.mjs";

// The fail-closed core is exercised by appendMobileLcov.test.ts; this file
// covers only what is shared-specific: the prefix, the labels and the paths.
let dir: string;

const record = (sf: string) => `TN:\nSF:${sf}\nDA:1,1\nend_of_record\n`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "append-shared-lcov-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("isSharedSourcePath", () => {
  test.each([
    ["packages/shared/src/a.ts", true],
    ["packages/shared/src/deep/a.ts", true],
    ["packages/shared/srcx/a.ts", false],
    ["packages/shared/vitest.sonar.config.ts", false],
    ["packages/sharedx/src/a.ts", false],
    ["packages/other/src/a.ts", false],
    ["packages/shared/src/../x.ts", false],
    ["src/a.ts", false],
    ["apps/mobile/src/a.ts", false],
  ])("%s -> %s", (source, expected) => {
    expect(isSharedSourcePath(source)).toBe(expected);
  });
});

describe("appendSharedLcov", () => {
  test("appends shared records and normalises Windows backslashes", () => {
    const shared = path.join(dir, "shared.info");
    const target = path.join(dir, "lcov.info");
    fs.writeFileSync(target, record("convex/a.ts"));
    fs.writeFileSync(shared, "SF:packages\\shared\\src\\a.ts\r\nend_of_record\r\n");
    expect(appendSharedLcov({ sharedLcovPath: shared, targetLcovPath: target })).toBe(1);
    expect(fs.readFileSync(target, "utf8")).toBe(record("convex/a.ts") + "SF:packages/shared/src/a.ts\nend_of_record\n");
  });

  test("refuses a mobile source with the shared message and leaves the target untouched", () => {
    const shared = path.join(dir, "shared.info");
    const target = path.join(dir, "lcov.info");
    fs.writeFileSync(target, "ORIGINAL\n");
    fs.writeFileSync(shared, record("apps/mobile/src/a.ts"));
    expect(() => appendSharedLcov({ sharedLcovPath: shared, targetLcovPath: target })).toThrow(
      'Shared LCOV has a source outside packages/shared/src/: "apps/mobile/src/a.ts"',
    );
    expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL\n");
  });
});

describe("main", () => {
  test("returns 0 and reports the count when the reports are valid", () => {
    fs.mkdirSync(path.join(dir, "packages", "shared", "coverage-sonar"), { recursive: true });
    fs.mkdirSync(path.join(dir, "coverage"));
    fs.writeFileSync(path.join(dir, "packages", "shared", "coverage-sonar", "lcov.info"), record("packages/shared/src/a.ts"));
    fs.writeFileSync(path.join(dir, "coverage", "lcov.info"), "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(dir)).toBe(0);
    expect(log).toHaveBeenCalledWith("Appended 1 shared LCOV records to coverage/lcov.info");
    log.mockRestore();
  });

  test("returns 1 and reports the reason when the shared report is missing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(dir)).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Shared LCOV is missing: "));
    err.mockRestore();
  });
});
