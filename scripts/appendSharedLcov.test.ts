import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { appendSharedLcov, isSharedSourcePath, main } from "./appendSharedLcov.mjs";

let dir: string;
let shared: string;
let target: string;

const record = (sf: string) => `TN:\nSF:${sf}\nDA:1,1\nend_of_record\n`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "append-shared-lcov-"));
  shared = path.join(dir, "shared.info");
  target = path.join(dir, "lcov.info");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = () => appendSharedLcov({ sharedLcovPath: shared, targetLcovPath: target });

describe("isSharedSourcePath", () => {
  test.each([
    ["packages/shared/src/a.ts", true],
    ["packages/shared/src/deep/a.ts", true],
    ["packages/shared/srcx/a.ts", false],
    ["packages/shared/src/./a.ts", false],
    ["packages/shared/src//a.ts", false],
    ["packages/shared/src/../x.ts", false],
    ["packages/shared/src/a.ts\rSF:lib/x.ts", false],
    ["packages/shared/src/a\u0000.ts", false],
    ["packages/shared/vitest.sonar.config.ts", false],
    ["packages/sharedx/src/a.ts", false],
    ["src/a.ts", false],
    ["/abs/packages/shared/src/a.ts", false],
    ["apps/mobile/src/a.ts", false],
  ])("%s -> %s", (source, expected) => {
    expect(isSharedSourcePath(source)).toBe(expected);
  });
});

describe("appendSharedLcov", () => {
  test("appends shared records after the existing report", () => {
    fs.writeFileSync(target, record("convex/a.ts"));
    fs.writeFileSync(shared, record("packages/shared/src/a.ts"));
    expect(run()).toBe(1);
    expect(fs.readFileSync(target, "utf8")).toBe(record("convex/a.ts") + record("packages/shared/src/a.ts"));
  });

  test("normalises Windows backslashes and inserts a newline when the target lacks one", () => {
    fs.writeFileSync(target, "end_of_record");
    fs.writeFileSync(shared, "SF:packages\\shared\\src\\a.ts\r\nend_of_record\r\n\r\n");
    run();
    expect(fs.readFileSync(target, "utf8")).toBe("end_of_record\nSF:packages/shared/src/a.ts\nend_of_record\n");
  });

  test("fails when the shared report is missing", () => {
    fs.writeFileSync(target, "");
    expect(run).toThrow(/missing/);
  });

  test("fails when the shared report is empty", () => {
    fs.writeFileSync(target, "");
    fs.writeFileSync(shared, "  \n");
    expect(run).toThrow(/empty/);
  });

  test("fails when the shared report has no SF records", () => {
    fs.writeFileSync(target, "");
    fs.writeFileSync(shared, "TN:\nend_of_record\n");
    expect(run).toThrow(/no SF records/);
  });

  test.each(["src/a.ts", "convex/a.ts", "packages/shared/src/../x.ts", "packages/shared/src//a.ts", "packages/shared/other.ts"])(
    "fails and leaves the target untouched for source %s",
    (sf) => {
      fs.writeFileSync(target, "ORIGINAL\n");
      fs.writeFileSync(shared, record("packages/shared/src/ok.ts") + record(sf));
      expect(run).toThrow(/outside packages\/shared\/src\//);
      expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL\n");
    },
  );

  test("refuses an SF value with an embedded bare CR", () => {
    fs.writeFileSync(target, "ORIGINAL\n");
    fs.writeFileSync(shared, "SF:packages/shared/src/a.ts\rSF:lib/commission.ts\nend_of_record\n");
    expect(run).toThrow(/outside packages\/shared\/src\//);
    expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL\n");
  });

  test("fails when the target report is missing", () => {
    fs.writeFileSync(shared, record("packages/shared/src/a.ts"));
    expect(run).toThrow(/Target LCOV is missing/);
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Appended 1 shared LCOV records"));
    log.mockRestore();
  });

  test("returns 1 and reports the reason when the shared report is missing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(dir)).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Shared LCOV is missing"));
    err.mockRestore();
  });
});
