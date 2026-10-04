import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validateLcovSources, main } = require("./validateLcovSources.cjs") as {
  validateLcovSources: (text: string, opts: { candidateRoot: string }) => number;
  main: (argv: string[]) => number;
};

let root: string;

const rec = (sf: string) => `TN:\nSF:${sf}\nDA:1,1\nend_of_record\n`;
const touch = (rel: string) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "x");
};
const writeLcov = (text: string): string => {
  const lcov = path.join(root, "lcov.info");
  fs.writeFileSync(lcov, text);
  return lcov;
};
const validate = (text: string) => validateLcovSources(text, { candidateRoot: root });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-lcov-"));
  for (const f of [
    "convex/a.ts",
    "apps/mobile/src/a.tsx",
    "apps/mobile/app/(app)/x.tsx",
    "apps/mobile/appx/a.ts",
    "apps/mobile/jest.setup.ts",
    "packages/shared/src/x.ts",
    "packages/shared/srcx/x.ts",
    "packages/shared/package.json",
    "packages/other/src/x.ts",
    "convex/x.ts",
    "components/a.tsx",
    "lib/commission.ts",
    "Convex/a.ts",
    "scripts/v.cjs",
    ".github/scripts/v.cjs",
    ".github/workflows/w.yml",
    ".github/scriptsx/v.cjs",
  ]) {
    touch(f);
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("validateLcovSources", () => {
  test.each(["convex/a.ts", "apps/mobile/src/a.tsx", "apps/mobile/app/(app)/x.tsx", "scripts/v.cjs", "packages/shared/src/x.ts"])("accepts %s", (sf) => {
    expect(validate(rec(sf))).toBe(1);
  });

  test("normalises backslashes as before", () => {
    expect(validate(rec("apps\\mobile\\src\\a.tsx"))).toBe(1);
  });

  test.each([
    "apps/mobile/appx/a.ts",
    "apps/mobile/jest.setup.ts",
    "packages/shared/srcx/x.ts",
    "packages/shared/package.json",
    "packages/other/src/x.ts",
    ".github/workflows/w.yml",
    ".github/scripts/v.cjs",
    ".github/scriptsx/v.cjs",
    "components/a.tsx",
    "/abs/convex/a.ts",
    "apps/mobile/src/../../x",
    "Convex/a.ts",
    "convex/./a.ts",
    "convex//a.ts",
    "convex/a.ts ",
  ])("refuses out-of-scope or malformed source %s", (sf) => {
    expect(() => validate(rec(sf))).toThrow(/refuses/);
  });

  test("refuses a packages/shared/src traversal that resolves to an existing in-scope file for the dot-segment reason", () => {
    // Resolves to convex/x.ts, which the fixture creates, so only the segment check can refuse it.
    expect(fs.existsSync(path.join(root, "packages/shared/src/../../../convex/x.ts"))).toBe(true);
    expect(() => validate(rec("packages/shared/src/../../../convex/x.ts"))).toThrow(/empty, '\.' or '\.\.' segment/);
  });

  test("refuses an artifact with a bare CR smuggling a second SF", () => {
    expect(() => validate("SF:convex/a.ts\rSF:lib/commission.ts\nend_of_record\n")).toThrow(/control character/);
  });

  test("refuses NUL and other control characters but allows CRLF and tab", () => {
    expect(() => validate("SF:convex/a.ts\u0000\nend_of_record\n")).toThrow(/control character/);
    expect(() => validate("SF:convex/a.ts\u001b\nend_of_record\n")).toThrow(/control character/);
    expect(validate("TN:\r\nSF:convex/a.ts\r\nFN:1,\tf\r\nend_of_record\r\n")).toBe(1);
  });

  test("refuses an SF that is missing from the candidate checkout", () => {
    expect(() => validate(rec("convex/missing.ts"))).toThrow(/not an existing regular file/);
  });

  test("refuses a missing packages/shared/src file", () => {
    expect(() => validate(rec("packages/shared/src/missing.ts"))).toThrow(/not an existing regular file/);
  });

  test("refuses an SF that is a directory", () => {
    fs.mkdirSync(path.join(root, "convex", "dir.ts"));
    expect(() => validate(rec("convex/dir.ts"))).toThrow(/not an existing regular file/);
  });

  test("refuses a packages/shared/src symlink", () => {
    try {
      fs.symlinkSync(path.join(root, "lib/commission.ts"), path.join(root, "packages/shared/src/link.ts"));
    } catch {
      return; // symlink creation not permitted on this host; CI (linux) exercises it
    }
    expect(() => validate(rec("packages/shared/src/link.ts"))).toThrow(/not an existing regular file/);
  });

  test("refuses an SF that is a symlink", () => {
    try {
      fs.symlinkSync(path.join(root, "lib/commission.ts"), path.join(root, "convex/link.ts"));
    } catch {
      return; // symlink creation not permitted on this host; CI (linux) exercises it
    }
    expect(() => validate(rec("convex/link.ts"))).toThrow(/not an existing regular file/);
  });
});

describe("main", () => {
  test("returns 0 for a valid artifact and 1 for an invalid one", () => {
    const lcov = writeLcov(rec("convex/a.ts"));
    expect(main([lcov, root])).toBe(0);
    writeLcov(rec("components/a.tsx"));
    expect(main([lcov, root])).toBe(1);
    expect(main([])).toBe(1);
  });
});

describe("CLI entry point", () => {
  const script = path.resolve(process.cwd(), "scripts/validateLcovSources.cjs");
  const run = (lcovText: string) => {
    const lcov = writeLcov(lcovText);
    return spawnSync(process.execPath, [script, lcov, root], { encoding: "utf8" });
  };

  test("running the script directly executes main: exit 0 and reports the record count", () => {
    const ok = run(rec("convex/a.ts"));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("Validated 1 LCOV source records.");
  });

  test("running the script directly exits non-zero for an out-of-scope source", () => {
    const bad = run(rec("components/a.tsx"));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/refuses/);
  });
});

describe("sonar-pr-report.yml wiring", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), ".github/workflows/sonar-pr-report.yml"), "utf8");

  test("runs the validator from the trusted checkout, never the candidate", () => {
    expect(source).toContain("node trusted/scripts/validateLcovSources.cjs");
    expect(source).not.toMatch(/candidate\/scripts/);
  });

  test("validates before the candidate lcov is placed and the scan runs", () => {
    expect(source.indexOf("validateLcovSources.cjs")).toBeLessThan(source.indexOf("cp \"$RUNNER_TEMP/sonar-coverage/lcov.info\""));
    expect(source.indexOf("Checkout exact tested PR merge as data only")).toBeLessThan(source.indexOf("validateLcovSources.cjs"));
  });
});
