/**
 * The coverage-report gate, tested against the reports that defeated it.
 *
 * ⚠️ These exist because the first version of this check shipped without them
 * and was defeated twice in review (SCRUM-185). It asked three questions — is
 * the file non-empty, does it have an `SF:` record, does that path exist — and
 * every one of them can be true of a report that measures nothing. Both
 * defeating reports are pinned below as tests, so the hole cannot reopen
 * quietly.
 *
 * The distinction the middle of this file is about: a report where nothing was
 * COVERED is truthful evidence and must be accepted, because "this code has no
 * tests" is exactly what Sonar should be told. A report where nothing was
 * MEASURED is not evidence at all. Requiring `LH > 0` would conflate the two and
 * make the gate refuse honest bad news.
 */
import type { PathLike } from "node:fs";
import { describe, expect, test } from "vitest";
import { verifyReport, parseLcov, hasExecutableEvidence } from "./verifyCoverageReports.mjs";

/** Every path exists — isolates what is under test from the filesystem. */
const allExist = () => true;
const noneExist = () => false;

const opts = { repoRoot: "/repo", exists: allExist };

describe("reports that must be REFUSED", () => {
  test("a report that names a real file but measures nothing", () => {
    // The exact input that defeated the inline bash check: one record, a path
    // that genuinely exists, and not a single line of coverage data.
    const report = ["TN:", "SF:package.json", "end_of_record", ""].join("\n");

    const result = verifyReport("coverage-sonar/lcov.info", report, opts);

    expect(result.ok).toBe(false);
    expect(result.records).toBe(1);
    expect(result.measured).toBe(0);
    expect(result.problems.join(" ")).toMatch(/not one carries executable-line data/);
  });

  test("a structurally truncated report with no end_of_record", () => {
    // What a coverage run killed mid-write actually leaves on disk. It parses,
    // it lists a source record, and it describes a run that never finished.
    const report = ["SF:convex/foo.ts", "DA:1,1", "DA:2,0"].join("\n");

    const result = verifyReport("coverage-sonar/lcov.info", report, opts);

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/structurally truncated/);
  });

  test("an empty report", () => {
    const result = verifyReport("coverage-sonar/lcov.info", "   \n  \n", opts);

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/missing or empty/);
  });

  test("a report with no SF: records at all", () => {
    const result = verifyReport("coverage-sonar/lcov.info", "TN:\nend_of_record\n", opts);

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/no SF: source records/);
  });

  test("a report whose source paths do not exist at the repository root", () => {
    // The failure the rebase step prevents: Sonar ignores unresolvable paths
    // silently and measures less than the report appears to promise.
    const report = ["SF:app/_layout.tsx", "DA:1,1", "LF:1", "LH:1", "end_of_record"].join("\n");

    const result = verifyReport("apps/mobile/coverage-sonar/lcov.info", report, {
      ...opts,
      exists: noneExist,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/do not exist at the repository root/);
  });
});

describe("reports that must be ACCEPTED", () => {
  test("a fully UNCOVERED report is real evidence, not a failure", () => {
    // Nothing is hit. Everything is measured. This is the shape of an honest
    // report about untested code, and refusing it would make the gate lie in
    // the opposite direction to the one it was built to prevent.
    const report = [
      "SF:convex/auth.config.ts",
      "DA:1,0",
      "DA:2,0",
      "LF:2",
      "LH:0",
      "end_of_record",
    ].join("\n");

    const result = verifyReport("coverage-sonar/lcov.info", report, opts);

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.measured).toBe(1);
  });

  test("a healthy report with a mix of covered and uncovered files", () => {
    const report = [
      "SF:convex/accounting/postingRules.ts",
      "DA:1,4",
      "LF:322",
      "LH:294",
      "end_of_record",
      "SF:convex/convex.config.ts",
      "DA:1,0",
      "LF:10",
      "LH:0",
      "end_of_record",
    ].join("\n");

    const result = verifyReport("coverage-sonar/lcov.info", report, opts);

    expect(result.ok).toBe(true);
    expect(result.records).toBe(2);
    expect(result.measured).toBe(2);
  });

  test("a file with no executable lines does not sink an otherwise real report", () => {
    // A type-only module legitimately reports LF:0. It carries no evidence of
    // its own, and it must not be mistaken for a degraded report as long as the
    // report as a whole measured something.
    const report = [
      "SF:convex/types.ts",
      "LF:0",
      "LH:0",
      "end_of_record",
      "SF:convex/finance.ts",
      "DA:1,1",
      "LF:12",
      "LH:9",
      "end_of_record",
    ].join("\n");

    const result = verifyReport("coverage-sonar/lcov.info", report, opts);

    expect(result.ok).toBe(true);
    expect(result.measured).toBe(1);
  });

  test("Windows-written paths resolve the same as Linux-written ones", () => {
    // Reports are produced on Linux in CI and Windows locally. The separator is
    // a property of the writer, not of the repository.
    const seen: string[] = [];
    const report = ["SF:convex\\finance.ts", "DA:1,1", "LF:1", "LH:1", "end_of_record"].join("\n");

    const result = verifyReport("coverage-sonar/lcov.info", report, {
      repoRoot: "/repo",
      exists: (p: PathLike) => {
        seen.push(String(p));
        return true;
      },
    });

    expect(result.ok).toBe(true);
    expect(seen.join(" ")).toMatch(/convex[/\\]finance\.ts/);
  });
});

describe("parsing", () => {
  test("counts DA records and reads LF per record", () => {
    const records = parseLcov(
      ["SF:a.ts", "DA:1,1", "DA:2,0", "LF:7", "LH:3", "end_of_record"].join("\n")
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ file: "a.ts", daCount: 2, linesFound: 7, terminated: true });
  });

  test("tracks termination per record, not per file", () => {
    // A report can be damaged in the middle and still carry later records. If
    // termination were inferred from how the file ends, the damaged record in
    // the middle would pass unnoticed.
    const records = parseLcov(
      ["SF:a.ts", "DA:1,1", "SF:b.ts", "DA:1,1", "LF:1", "LH:1", "end_of_record"].join("\n")
    );

    expect(records.map((r) => r.terminated)).toEqual([false, true]);
  });

  test("evidence means measured, not hit", () => {
    expect(hasExecutableEvidence({ linesFound: 0, daCount: 0 })).toBe(false);
    expect(hasExecutableEvidence({ linesFound: 5, daCount: 0 })).toBe(true);
    expect(hasExecutableEvidence({ linesFound: 0, daCount: 1 })).toBe(true);
  });
});
