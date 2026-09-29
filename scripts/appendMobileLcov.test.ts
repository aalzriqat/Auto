import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { appendMobileLcov, isMobileSourcePath, main } from "./appendMobileLcov.mjs";

let dir: string;
let mobile: string;
let target: string;

const record = (sf: string) => `TN:\nSF:${sf}\nDA:1,1\nend_of_record\n`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "append-mobile-lcov-"));
  mobile = path.join(dir, "mobile.info");
  target = path.join(dir, "lcov.info");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = () => appendMobileLcov({ mobileLcovPath: mobile, targetLcovPath: target });

describe("isMobileSourcePath", () => {
  test.each([
    ["apps/mobile/src/a.tsx", true],
    ["apps/mobile/app/(app)/x.tsx", true],
    ["apps/mobile/appx/x.ts", false],
    ["apps/mobile/src/./a.ts", false],
    ["apps/mobile/src//a.ts", false],
    ["apps/mobile/src/a.ts\rSF:lib/x.ts", false],
    ["apps/mobile/src/a\u0000.ts", false],
    ["apps/mobile/jest.setup.ts", false],
    ["apps/mobilex/src/a.ts", false],
    ["apps/mobile/src/../../x", false],
    ["/abs/apps/mobile/src/a.ts", false],
    ["convex/a.ts", false],
  ])("%s -> %s", (source, expected) => {
    expect(isMobileSourcePath(source)).toBe(expected);
  });
});

describe("appendMobileLcov", () => {
  test("appends mobile records after the existing report", () => {
    fs.writeFileSync(target, record("convex/a.ts"));
    fs.writeFileSync(mobile, record("apps/mobile/src/a.tsx"));
    expect(run()).toBe(1);
    const out = fs.readFileSync(target, "utf8");
    expect(out).toBe(record("convex/a.ts") + record("apps/mobile/src/a.tsx"));
  });

  test("normalises backslashes and inserts a newline when the target lacks one", () => {
    fs.writeFileSync(target, "end_of_record");
    fs.writeFileSync(mobile, "SF:apps\\mobile\\src\\a.tsx\r\nend_of_record\r\n\r\n");
    run();
    expect(fs.readFileSync(target, "utf8")).toBe("end_of_record\nSF:apps/mobile/src/a.tsx\nend_of_record\n");
  });

  test("appends to an empty target without a separator", () => {
    fs.writeFileSync(target, "");
    fs.writeFileSync(mobile, record("apps/mobile/src/a.tsx"));
    run();
    expect(fs.readFileSync(target, "utf8")).toBe(record("apps/mobile/src/a.tsx"));
  });

  test("fails when the mobile report is missing", () => {
    fs.writeFileSync(target, "");
    expect(run).toThrow(/missing/);
  });

  test("fails when the mobile report is empty", () => {
    fs.writeFileSync(target, "");
    fs.writeFileSync(mobile, "  \n");
    expect(run).toThrow(/empty/);
  });

  test("fails when the mobile report has no SF records", () => {
    fs.writeFileSync(target, "");
    fs.writeFileSync(mobile, "TN:\nend_of_record\n");
    expect(run).toThrow(/no SF records/);
  });

  test.each(["src/a.tsx", "/abs/apps/mobile/src/a.tsx", "apps/mobile/src/../x.ts", "convex/a.ts"])(
    "fails and leaves the target untouched for source %s",
    (sf) => {
      fs.writeFileSync(target, "ORIGINAL\n");
      fs.writeFileSync(mobile, record("apps/mobile/src/ok.tsx") + record(sf));
      expect(run).toThrow(/outside apps\/mobile\/(src|app)\//);
      expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL\n");
    },
  );

  test("accepts records under apps/mobile/app", () => {
    fs.writeFileSync(target, "");
    fs.writeFileSync(mobile, record("apps/mobile/app/(app)/x.tsx"));
    expect(run()).toBe(1);
  });

  test.each(["apps/mobile/appx/x.ts", "apps/mobile/jest.setup.ts", "apps/mobile/src/./a.ts", "apps/mobile/src//a.ts"])(
    "refuses source %s",
    (sf) => {
      fs.writeFileSync(target, "ORIGINAL\n");
      fs.writeFileSync(mobile, record(sf));
      expect(run).toThrow(/outside apps\/mobile\/(src|app)/);
      expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL\n");
    },
  );

  test("refuses an SF value with an embedded bare CR", () => {
    fs.writeFileSync(target, "ORIGINAL\n");
    fs.writeFileSync(mobile, "SF:apps/mobile/src/a.ts\rSF:lib/commission.ts\nend_of_record\n");
    expect(run).toThrow(/outside apps\/mobile\/(src|app)/);
    expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL\n");
  });

  test("fails when the target report is missing", () => {
    fs.writeFileSync(mobile, record("apps/mobile/src/a.tsx"));
    expect(run).toThrow(/Target LCOV is missing/);
  });
});

describe("main", () => {
  test("returns 0 and reports the count when the reports are valid", () => {
    fs.mkdirSync(path.join(dir, "apps", "mobile", "coverage-sonar"), { recursive: true });
    fs.mkdirSync(path.join(dir, "coverage"));
    fs.writeFileSync(path.join(dir, "apps", "mobile", "coverage-sonar", "lcov.info"), record("apps/mobile/src/a.tsx"));
    fs.writeFileSync(path.join(dir, "coverage", "lcov.info"), "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(dir)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Appended 1 mobile LCOV records"));
    log.mockRestore();
  });

  test("returns 1 and reports the reason when the mobile report is missing", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(dir)).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Mobile LCOV is missing"));
    err.mockRestore();
  });
});