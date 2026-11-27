/**
 * SCRUM-1025: which unit tests a pull request must run. These pin the fail-closed
 * contract: anything that is not provably safe to narrow runs the FULL suite.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  DOCS_ONLY_PREFIXES,
  buildSelection,
  classifyChange,
  isDocsOnlyPath,
  parseNameStatus,
  parseTrackedCoverageFiles,
} from "./unitTestSelection.mjs";

const pr = (changed: { path: string; status?: string }[], baseCoverage = true) =>
  classifyChange({
    event: "pull_request",
    changed: changed.map((c) => ({ status: "M", ...c })),
    baseCoverageAvailable: baseCoverage,
  });
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

  test("a deleted or renamed document is still only documentation", () => {
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
    expect(pr(mod(p, "lib/a.ts")).mode).toBe("full");
  });

  test("a deleted non-test source file cannot be traced by the import graph", () => {
    expect(pr([{ path: "lib/old.ts", status: "D" }]).mode).toBe("full");
    expect(pr([{ path: "lib/old.test.ts", status: "D" }, { path: "lib/a.ts", status: "M" }]).mode).toBe("impacted");
  });
});

describe("classifyChange: impacted", () => {
  test("application, library and backend source changes are eligible", () => {
    expect(pr(mod("lib/a.ts", "components/x/Y.tsx", "app/p/page.tsx", "hooks/useA.ts", "convex/sales.ts")).mode).toBe("impacted");
  });

  test("documentation next to eligible code does not force full", () => {
    expect(pr(mod("docs/payroll-module-plan.md", "lib/a.ts")).mode).toBe("impacted");
  });
});

describe("parseNameStatus", () => {
  test("reads git --name-status --no-renames output", () => {
    expect(parseNameStatus("M\tlib/a.ts\nD\tlib/b.ts\nA\tdocs/c.md\n")).toEqual([
      { status: "M", path: "lib/a.ts" },
      { status: "D", path: "lib/b.ts" },
      { status: "A", path: "docs/c.md" },
    ]);
  });

  test("refuses output it cannot parse", () => {
    expect(() => parseNameStatus("garbage line")).toThrow(/name-status/);
    expect(() => parseNameStatus("R100\told.ts\tnew.ts")).toThrow(/name-status/);
  });
});

describe("parseTrackedCoverageFiles", () => {
  test("reads the coverage.include list of the repository config", () => {
    const text = fs.readFileSync(path.resolve(__dirname, "..", "..", "vitest.config.ts"), "utf8");
    const files = parseTrackedCoverageFiles(text);
    expect(files).toContain("lib/commission.ts");
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  test("throws when the list cannot be found, so the caller falls back to the full suite", () => {
    expect(() => parseTrackedCoverageFiles("export default {}")).toThrow(/coverage\.include/);
  });
});

describe("buildSelection", () => {
  const census = [
    "convex/sales.test.ts",
    "convex/accounting/posting.test.ts",
    "scripts/intelligence/reviewEvidence.test.ts",
    "scripts/skillEnforcement/skillEnforcement.test.ts",
    "scripts/misc.test.ts",
    "lib/a.test.ts",
    "lib/commission.test.ts",
    "components/x/Y.test.tsx",
    "components/z/Z.test.tsx",
  ];
  const base = {
    census,
    trackedCoverageFiles: ["lib/commission.ts"],
    changed: mod("components/x/Y.tsx"),
  };

  test("money and permission suites (every convex test, per the skill-enforcement policy) run whatever changed", async () => {
    const result = await buildSelection({ ...base, listRelated: () => ["components/x/Y.test.tsx"] });
    expect(result.mode).toBe("impacted");
    expect(result.files).toContain("convex/sales.test.ts");
    expect(result.files).toContain("convex/accounting/posting.test.ts");
  });

  test("gate suites run whatever changed", async () => {
    const { files } = await buildSelection({ ...base, listRelated: () => ["components/x/Y.test.tsx"] });
    expect(files).toContain("scripts/intelligence/reviewEvidence.test.ts");
    expect(files).toContain("scripts/skillEnforcement/skillEnforcement.test.ts");
  });

  test("tests of the coverage-threshold files always run, so the unchanged thresholds still hold", async () => {
    let asked: string[] = [];
    const { files } = await buildSelection({
      ...base,
      listRelated: (paths: string[]) => {
        asked = paths;
        return ["lib/commission.test.ts", "components/x/Y.test.tsx"];
      },
    });
    expect(asked).toEqual(expect.arrayContaining(["lib/commission.ts", "components/x/Y.tsx"]));
    expect(files).toContain("lib/commission.test.ts");
  });

  test("unrelated suites are left out and the list is sorted and unique", async () => {
    const { files } = await buildSelection({ ...base, listRelated: () => ["components/x/Y.test.tsx", "components/x/Y.test.tsx"] });
    expect(files).not.toContain("lib/a.test.ts");
    expect(files).not.toContain("components/z/Z.test.tsx");
    expect(files).not.toContain("scripts/misc.test.ts");
    expect(files).toEqual([...new Set(files)].sort());
  });

  test("a changed test file runs itself", async () => {
    const { files } = await buildSelection({ ...base, changed: mod("lib/a.test.ts"), listRelated: () => ["lib/commission.test.ts"] });
    expect(files).toContain("lib/a.test.ts");
  });

  test("a selection error runs the full suite", async () => {
    const result = await buildSelection({
      ...base,
      listRelated: () => {
        throw new Error("vitest exploded");
      },
    });
    expect(result.mode).toBe("full");
    expect(result.reason).toMatch(/selection failed/i);
  });

  test("an empty answer (a broken probe: the threshold files always have tests) runs the full suite", async () => {
    const result = await buildSelection({ ...base, listRelated: () => [] });
    expect(result.mode).toBe("full");
    expect(result.reason).toMatch(/probe returned nothing/);
  });

  test("a reported test that is not in the census runs the full suite", async () => {
    const result = await buildSelection({ ...base, listRelated: () => ["lib/ghost.test.ts"] });
    expect(result.mode).toBe("full");
  });
});

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
    const needles = [...DOCS_ONLY_PREFIXES.map((p) => p.replace(/\/$/, "")), ...allowed.flatMap((f) => [f, f.split("/").pop() as string]).filter((n) => n.toLowerCase() !== "readme.md")];
    const offenders: string[] = [];
    for (const file of tracked) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      for (const needle of needles) if (text.includes(needle)) offenders.push(`${file} -> ${needle}`);
    }
    expect(offenders).toEqual([]);
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

  test("parseNameStatus carries a type change through instead of throwing, so it classifies as full", () => {
    expect(parseNameStatus("T\tcomponents/Y.tsx")).toEqual([{ status: "T", path: "components/Y.tsx" }]);
  });
});