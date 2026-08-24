/**
 * The gate as the workflow actually calls it: rebase, then verify, in that order.
 *
 * The two halves have their own unit tests. What is tested here is the thing
 * neither of them can see — that the rebase happens BEFORE verification. That
 * ordering was previously expressed only as the order of two workflow steps, so
 * nothing would have caught someone reordering them; the symptom would be all
 * 151 mobile paths reported missing, and the obvious reading of that message is
 * "the mobile directory was deleted", not "the steps are the wrong way round".
 */
import { describe, expect, test } from "vitest";
import { runCoverageGate, parseArgs, DEFAULT_REPORTS } from "./assertCoverageReports.mjs";

const CONVEX = "coverage-sonar/lcov.info";
const MOBILE = "apps/mobile/coverage-sonar/lcov.info";

const healthyConvex = [
  "SF:convex/finance.ts",
  "DA:1,4",
  "LF:12",
  "LH:9",
  "end_of_record",
  "",
].join("\n");

/** Mobile paths as jest writes them — relative to apps/mobile, not the repo root. */
const rawMobile = ["SF:app/_layout.tsx", "DA:1,1", "LF:1", "LH:1", "end_of_record", ""].join("\n");

/** An `io` seam over an in-memory filesystem, so the decisions are what is tested. */
function io(files: Record<string, string>, knownPaths: string[] = []) {
  const written: Record<string, string> = {};
  return {
    written,
    seam: {
      read: (f: string) => files[f] ?? "",
      write: (f: string, text: string) => {
        files[f] = text;
        written[f] = text;
      },
      exists: (p: string) => {
        const normalized = p.replace(/\\/g, "/");
        if (Object.prototype.hasOwnProperty.call(files, normalized)) return true;
        return knownPaths.some((known) => normalized.endsWith(known));
      },
      repoRoot: "/repo",
    },
  };
}

describe("ordering — the property that only exists once both halves are combined", () => {
  test("the mobile report is rebased before it is verified, so its paths resolve", () => {
    const { seam, written } = io(
      { [CONVEX]: healthyConvex, [MOBILE]: rawMobile },
      ["convex/finance.ts", "apps/mobile/app/_layout.tsx"]
    );

    const result = runCoverageGate({ convex: CONVEX, mobile: MOBILE }, seam);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    // The rebase actually happened and was persisted.
    expect(written[MOBILE]).toContain("SF:apps/mobile/app/_layout.tsx");
    expect(result.lines.join(" ")).toMatch(/rebased 1 source paths/);
  });

  test("without the rebase those same paths would NOT resolve", () => {
    // The control for the test above: `app/_layout.tsx` is not a repository path,
    // so if verification ran first every mobile record would be reported missing.
    const { seam } = io({ [CONVEX]: healthyConvex, [MOBILE]: rawMobile }, ["convex/finance.ts"]);

    const result = runCoverageGate({ convex: CONVEX, mobile: MOBILE }, seam);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/do not exist at the repository root/);
  });
});

describe("refusals reach the caller", () => {
  test("a hollow convex report fails the gate", () => {
    const { seam } = io(
      { [CONVEX]: "TN:\nSF:package.json\nend_of_record\n", [MOBILE]: rawMobile },
      ["package.json", "apps/mobile/app/_layout.tsx"]
    );

    const result = runCoverageGate({ convex: CONVEX, mobile: MOBILE }, seam);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/not one carries executable-line data/);
  });

  test("a missing report fails rather than being quietly skipped", () => {
    const { seam } = io({ [CONVEX]: healthyConvex }, ["convex/finance.ts"]);

    const result = runCoverageGate({ convex: CONVEX, mobile: MOBILE }, seam);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/missing or empty/);
  });

  test("a mobile path that escapes the repository is refused, not written", () => {
    const { seam, written } = io(
      { [CONVEX]: healthyConvex, [MOBILE]: "SF:/etc/passwd\nDA:1,1\nLF:1\nLH:1\nend_of_record\n" },
      ["convex/finance.ts"]
    );

    const result = runCoverageGate({ convex: CONVEX, mobile: MOBILE }, seam);

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/absolute path/);
    expect(written[MOBILE]).toBeUndefined();
  });
});

describe("arguments", () => {
  test("defaults are the two reports the sonarcloud job produces", () => {
    expect(parseArgs([])).toEqual(DEFAULT_REPORTS);
  });

  test("both report paths can be overridden", () => {
    expect(parseArgs(["--convex", "a/lcov.info", "--mobile", "b/lcov.info"])).toEqual({
      convex: "a/lcov.info",
      mobile: "b/lcov.info",
    });
  });

  test("a flag with no value is ignored rather than blanking the default", () => {
    expect(parseArgs(["--convex"])).toEqual(DEFAULT_REPORTS);
  });
});
