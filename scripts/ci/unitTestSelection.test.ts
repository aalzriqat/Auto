/**
 * SCRUM-1025: whether a pull request may skip the unit tests. These pin the
 * fail-closed contract: only provably unread documentation skips them; anything
 * else runs the FULL suite.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  DOCS_ONLY_PREFIXES,
  classifyChange,
  isDocsOnlyPath,
  parseRawDiff,
} from "./unitTestSelection.mjs";

// The modes git reports for a plain regular file, by status. A case that wants a
// different mode names it, so the mode is the ONLY difference from its control.
const REGULAR: Record<string, { oldMode: string; newMode: string }> = {
  A: { oldMode: "000000", newMode: "100644" },
  M: { oldMode: "100644", newMode: "100644" },
  D: { oldMode: "100644", newMode: "000000" },
};
type Entry = { path: string; status?: string; oldMode?: string; newMode?: string };
const withModes = (c: Entry) => {
  const status = c.status ?? "M";
  return { status, ...(REGULAR[status] ?? { oldMode: "100644", newMode: "100644" }), ...c };
};
const pr = (changed: Entry[], baseCoverage = true) =>
  classifyChange({ event: "pull_request", changed: changed.map(withModes), baseCoverageAvailable: baseCoverage });
const mod = (...paths: string[]) => paths.map((p) => ({ path: p }));

describe("classifyChange: docs-only", () => {
  test("only proven-unread documentation is docs-only", () => {
    expect(pr(mod("docs/payroll-module-plan.md", "docs/audit-tasks/a.md", "phase-01-performance-and-indexing.md")).mode).toBe("docs-only");
  });

  test("docs that tests read are code: ADRs, architecture, pilot inventory, regression records, CLAUDE.md, .claude", () => {
    for (const p of [
      "docs/adr/2026-11-03-pr-time-scenario-runner.md",
      "docs/architecture/scrum486-certification-oracle.md",
      "docs/pilot/blocked-server-side-doors.inventory.json",
      "regression/README.md",
      "CLAUDE.md",
      "AGENTS.md",
      ".claude/skills/README.md",
      "convex/README.md",
    ]) {
      expect(pr(mod(p)).mode, p).toBe("full");
    }
  });

  test("a docs-only change without reusable base coverage runs the full suite", () => {
    const result = pr(mod("docs/payroll-module-plan.md"), false);
    expect(result.mode).toBe("full");
    expect(result.reason).toMatch(/base coverage/i);
  });

  test("a deleted document is still only documentation", () => {
    expect(pr([{ path: "docs/payroll-module-plan.md", status: "D" }]).mode).toBe("docs-only");
  });
});

describe("classifyChange: full-suite fallbacks", () => {
  test("any event other than pull_request runs everything", () => {
    for (const event of ["push", "schedule", "workflow_dispatch", "", undefined]) {
      expect(classifyChange({ event, changed: [{ status: "M", path: "lib/a.ts" }], baseCoverageAvailable: true }).mode).toBe("full");
    }
  });

  test("a missing or empty change list is never narrowed", () => {
    for (const changed of [null, undefined, [], "lib/a.ts"]) {
      expect(classifyChange({ event: "pull_request", changed: changed as never, baseCoverageAvailable: true }).mode).toBe("full");
    }
  });

  test.each([
    "convex/schema.ts",
    "convex/schema/accounting.schema.ts",
    "convex/_generated/api.d.ts",
    "test-utils/convexTestHarness.ts",
    "vitest.config.ts",
    "vitest.setup.ts",
    "tsconfig.json",
    "convex/tsconfig.json",
    "package.json",
    "packages/shared/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".github/workflows/test.yml",
    "scripts/runVitestCoverageShards.mjs",
    "scripts/coverageWorkload.json",
    "quality/guardrails/check.mjs",
    "sonar-project.properties",
    "eslint.config.mjs",
    "apps/mobile/src/a.ts",
    "something/unknown/new.ts",
  ])("shared infrastructure or an unknown path runs the full suite: %s", (p) => {
    // Alone: a second non-documentation path would make this pass for the wrong reason.
    expect(isDocsOnlyPath(p)).toBe(false);
    expect(pr(mod(p)).mode).toBe("full");
  });

  test("there is no narrowing: source changes, with or without documentation beside them, run everything", () => {
    expect(pr(mod("lib/a.ts", "components/x/Y.tsx", "convex/sales.ts")).mode).toBe("full");
    expect(pr(mod("docs/payroll-module-plan.md", "lib/a.ts")).mode).toBe("full");
    expect(pr([{ path: "lib/old.test.ts", status: "D" }]).mode).toBe("full");
  });

  test("an unknown path is named in the reason", () => {
    expect(pr(mod("docs/payroll-module-plan.md", "lib/a.ts")).reason).toMatch(/lib\/a\.ts is not documentation/);
  });
});

const SHA = "a".repeat(40);
const ZERO = "0".repeat(40);
const record = (oldMode: string, newMode: string, status: string, file: string) =>
  `:${oldMode} ${newMode} ${oldMode === "000000" ? ZERO : SHA} ${newMode === "000000" ? ZERO : SHA} ${status}\0${file}\0`;

describe("parseRawDiff (git diff --raw -z --no-renames --no-abbrev)", () => {
  // Format: https://git-scm.com/docs/git-diff#_raw_output_format -- fields 2 and 4
  // are the modes, 10 the status, then a NUL, the path, and a NUL terminating the record.
  test("reads modes, status and the unquoted path of every record", () => {
    const text = record("100644", "100644", "M", "lib/a.ts") + record("100644", "000000", "D", "lib/b.ts") + record("000000", "120000", "A", "docs/agents/c.md");
    expect(parseRawDiff(text)).toEqual([
      { status: "M", path: "lib/a.ts", oldMode: "100644", newMode: "100644" },
      { status: "D", path: "lib/b.ts", oldMode: "100644", newMode: "000000" },
      { status: "A", path: "docs/agents/c.md", oldMode: "000000", newMode: "120000" },
    ]);
  });

  test("an empty diff is an empty list, not an error", () => {
    expect(parseRawDiff("")).toEqual([]);
  });

  test("a path with spaces or non-ASCII characters comes through verbatim (-z does not quote)", () => {
    expect(parseRawDiff(record("000000", "100644", "A", "docs/agents/caf\u00e9 notes.md"))[0].path).toBe("docs/agents/caf\u00e9 notes.md");
  });

  test.each([
    ["a record cut before its path terminator", record("100644", "100644", "M", "lib/a.ts").slice(0, -1)],
    ["a record with no path", `:100644 100644 ${SHA} ${SHA} M\0`],
    ["text that is not a raw record", "M\tlib/a.ts\n"],
    ["a short sha", `:100644 100644 abc ${SHA} M\0lib/a.ts\0`],
    ["a rename record (two paths)", `:100644 100644 ${SHA} ${SHA} R100\0old.ts\0new.ts\0`],
    ["a record with a non-octal mode", `:10x644 100644 ${SHA} ${SHA} M\0lib/a.ts\0`],
  ])("refuses %s", (_label, text) => {
    expect(() => parseRawDiff(text)).toThrow(/raw diff/);
  });
});

describe("docs-only needs regular-file modes (B1)", () => {
  const DOC = "docs/agents/notes.md";

  test("control: a regular documentation file added, modified or deleted is docs-only", () => {
    for (const status of ["A", "M", "D"]) expect(pr([{ path: DOC, status }]).mode, status).toBe("docs-only");
  });

  test.each([
    ["a symlink added", { status: "A", oldMode: "000000", newMode: "120000" }],
    ["a gitlink (submodule) added", { status: "A", oldMode: "000000", newMode: "160000" }],
    ["an executable added", { status: "A", oldMode: "000000", newMode: "100755" }],
    ["a mode-only change 100644 -> 100755", { status: "M", oldMode: "100644", newMode: "100755" }],
    ["a type change symlink -> file", { status: "M", oldMode: "120000", newMode: "100644" }],
    ["a type change file -> symlink", { status: "M", oldMode: "100644", newMode: "120000" }],
    ["a symlink deleted", { status: "D", oldMode: "120000", newMode: "000000" }],
    ["an unknown mode", { status: "A", oldMode: "000000", newMode: "100664" }],
    ["an add that claims an existing old side", { status: "A", oldMode: "100644", newMode: "100644" }],
    ["a delete that claims a surviving new side", { status: "D", oldMode: "100644", newMode: "100644" }],
    ["a modify with an absent side", { status: "M", oldMode: "000000", newMode: "100644" }],
  ])("%s is full", (_label, modes) => {
    const result = pr([{ path: DOC, ...modes }]);
    expect(result.mode).toBe("full");
    expect(result.reason).toMatch(/mode/);
  });

  test("an entry without modes is malformed, so full", () => {
    const result = classifyChange({ event: "pull_request", changed: [{ status: "M", path: DOC }], baseCoverageAvailable: true });
    expect(result.mode).toBe("full");
  });

  test("one irregular entry among regular documentation makes the whole change full", () => {
    expect(pr([{ path: "docs/agents/a.md" }, { path: DOC, status: "A", oldMode: "000000", newMode: "120000" }]).mode).toBe("full");
  });
});

describe("paths with characters other than printable ASCII are never docs-only (deliberate: full)", () => {
  test.each(["docs/agents/caf\u00e9.md", "docs/agents/a\tb.md", "docs/agents/a\nb.md", "docs/agents/\u0001.md", "docs/agents/\u202e.md"])("%j is full", (file) => {
    expect(isDocsOnlyPath(file)).toBe(false);
    expect(pr([{ path: file, status: "A" }]).mode).toBe("full");
  });

  test("a plain space is ordinary and stays documentation", () => {
    expect(isDocsOnlyPath("docs/agents/my notes.md")).toBe(true);
  });
});

// Names the allow-listed documents a test source mentions. Full paths and
// directory prefixes only: a bare basename ("notes.md") matches unrelated
// synthetic paths such as "docs/notes.md" and would turn main red for a
// documentation-only pull request that the PR run skipped this test for.
export function pathsNamedBy(sources: Record<string, string>, allowed: string[], prefixes: string[]): string[] {
  const needles = [...prefixes.map((p) => p.replace(/\/$/, "")), ...allowed.filter((f) => f.toLowerCase() !== "readme.md")];
  const hits: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const needle of needles) if (text.includes(needle)) hits.push(`${file} -> ${needle}`);
  }
  return hits;
}

describe("docs-only allow-list stays provably unread", () => {
  // Tests read documentation through fs (pilotDoorInventory, scrum486Certification,
  // verifyHostedBrowserReplays, reviewEvidence, CLAUDE.md). The docs-only skip is
  // only safe for paths no test source names; this fails the day one does.
  test("no test or test-utility source names an allow-listed path", () => {
    const root = path.resolve(__dirname, "..", "..");
    const tracked = execFileSync("git", ["ls-files", "--", "*.test.ts", "*.test.tsx", "*.test.mjs", "test-utils"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.startsWith("apps/") && !f.startsWith("packages/") && f !== "scripts/ci/unitTestSelection.test.ts");
    const allowed = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f && isDocsOnlyPath(f));
    expect(allowed.length).toBeGreaterThan(5);
    const sources = Object.fromEntries(tracked.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
    expect(pathsNamedBy(sources, allowed, DOCS_ONLY_PREFIXES)).toEqual([]);
  });

  test("a synthetic path that only shares a basename with an allow-listed document does not trip it", () => {
    const sources = { "scripts/a.test.ts": 'const p = "docs/notes.md"; const q = "docs/gate.md";' };
    expect(pathsNamedBy(sources, ["docs/testing/notes.md", "docs/agents/gate.md"], [])).toEqual([]);
  });

  test("a real reference to an allow-listed path, or to an allow-listed directory, does", () => {
    const sources = { "scripts/a.test.ts": 'readFileSync("docs/testing/notes.md")', "scripts/b.test.ts": 'walk("docs/agents")' };
    expect(pathsNamedBy(sources, ["docs/testing/notes.md"], DOCS_ONLY_PREFIXES)).toEqual([
      "scripts/a.test.ts -> docs/testing",
      "scripts/a.test.ts -> docs/testing/notes.md",
      "scripts/b.test.ts -> docs/agents",
    ]);
  });
});
describe("docs-only needs an allowed location AND a non-code extension (B2)", () => {
  test.each(["docs/testing/x.test.ts", "docs/agents/helper.ts", "docs/audit-tasks/run.mjs", "docs/agents/fixture.json", "docs/testing/script.sh", "docs/x.tsx", "docs/agents/noext"])(
    "%s is code or unknown: full",
    (file) => {
      expect(isDocsOnlyPath(file)).toBe(false);
      expect(pr(mod(file)).mode).toBe("full");
    },
  );

  test.each(["docs/agents/guide.md", "docs/testing/notes.MD", "docs/audit-tasks/shot.png", "docs/payroll-module-plan.md", "docs/agents/diagram.svg"])(
    "%s is documentation: docs-only",
    (file) => {
      expect(pr(mod(file)).mode).toBe("docs-only");
    },
  );

  test("one code file among documentation makes the whole change full", () => {
    expect(pr(mod("docs/agents/guide.md", "docs/testing/x.test.ts")).mode).toBe("full");
  });
});

describe("only added, modified and deleted files are understood (B3)", () => {
  test.each(["T", "U", "X", "B"])("status %s is full", (status) => {
    const result = pr([{ path: "components/Y.tsx", status }]);
    expect(result.mode).toBe("full");
    expect(result.reason).toMatch(/status/);
  });

  test("a type change next to documentation is still full", () => {
    expect(pr([{ path: "docs/agents/guide.md", status: "T" }]).mode).toBe("full");
  });

  test("parseRawDiff carries a type change through instead of throwing, so it classifies as full", () => {
    expect(parseRawDiff(record("100644", "120000", "T", "components/Y.tsx"))).toEqual([{ status: "T", path: "components/Y.tsx", oldMode: "100644", newMode: "120000" }]);
  });
});