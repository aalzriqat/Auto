import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import {
  analyzeSourceEntries,
  analyzeCommit,
  analyzeWorkingTree,
  assertBaselineProvenance,
  canonicalBaselineText,
  combineRatchetComparisons,
  compareAnalyses,
  createBaseline,
  formatMaintainabilityIssue,
  inventoryProductionPaths,
  isMigrationOrSeedPath,
  normalizeRepositoryPath,
  validateBaselineDocument,
} from "../maintainability.mjs";

const SOURCE_COMMIT = "a".repeat(40);

function runFixtureGit(root, argumentsList) {
  const result = spawnSync("git", ["-C", root, ...argumentsList], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `git ${argumentsList.join(" ")} failed: ${result.stderr}`,
  );
  return result.stdout.trim();
}

function writeFixture(root, filePath, source) {
  const absolutePath = join(root, ...filePath.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, source, "utf8");
}

function declarations(prefix, count) {
  return Array.from(
    { length: count },
    (_, index) => `  const ${prefix}${index} = ${index};`,
  ).join("\n");
}

function longFunction(name, statementCount, prefix = "entry") {
  return `export function ${name}(input) {\n${declarations(prefix, statementCount)}\n  return input;\n}\n`;
}

function longFile(statementCount, prefix = "entry") {
  return Array.from(
    { length: statementCount },
    (_, index) => `export const ${prefix}${index} = ${index};`,
  ).join("\n");
}

function analyze(path, source) {
  return analyzeSourceEntries([{ path, source }]);
}

function issueKinds(current, baseline) {
  return compareAnalyses(current, baseline).issues.map(({ kind }) => kind);
}

function comparisonAgainstBaselines(current, historical, latestMain) {
  return combineRatchetComparisons(
    compareAnalyses(current, historical),
    compareAnalyses(current, latestMain),
  );
}

describe("maintainability ratchet", () => {
  test("a new oversized production file fails", () => {
    const source = Array.from(
      { length: 601 },
      (_, index) => `export const line${index} = ${index};`,
    ).join("\n");
    const comparison = compareAnalyses(analyze("lib/new-file.ts", source), {
      files: [],
    });

    assert.equal(comparison.ok, false);
    assert.ok(
      comparison.issues.some(
        (issue) => issue.entity === "file" && issue.metric === "lines",
      ),
    );
  });

  test("a compliant new production file passes", () => {
    const comparison = compareAnalyses(
      analyze("lib/compliant.ts", "export const answer = 42;\n"),
      { files: [] },
    );

    assert.deepEqual(comparison, { ok: true, issues: [] });
  });

  test("unchanged and improved grandfathered files pass while worsening fails", () => {
    const baseline = analyze("lib/legacy-file.ts", longFile(620));
    const unchanged = analyze("lib/legacy-file.ts", longFile(620));
    const improved = analyze("lib/legacy-file.ts", longFile(610));
    const worsened = analyze("lib/legacy-file.ts", longFile(621));

    assert.deepEqual(issueKinds(unchanged, baseline), []);
    assert.deepEqual(issueKinds(improved, baseline), []);
    assert.ok(issueKinds(worsened, baseline).includes("LEGACY_DEBT_WORSENED"));
  });

  test("unchanged and improved grandfathered functions pass", () => {
    const baseline = analyze("lib/legacy.ts", longFunction("legacy", 130));
    const unchanged = analyze("lib/legacy.ts", longFunction("legacy", 130));
    const improved = analyze("lib/legacy.ts", longFunction("legacy", 124));

    assert.deepEqual(issueKinds(unchanged, baseline), []);
    assert.deepEqual(issueKinds(improved, baseline), []);
  });

  test("latest-main improvement closes the second-order re-worsening bypass", () => {
    const historical = analyze("lib/legacy.ts", longFunction("legacy", 140));
    const latestMain = analyze("lib/legacy.ts", longFunction("legacy", 130));
    const reWorsened = analyze("lib/legacy.ts", longFunction("legacy", 135));

    assert.equal(compareAnalyses(reWorsened, historical).ok, true);
    const comparison = comparisonAgainstBaselines(
      reWorsened,
      historical,
      latestMain,
    );
    assert.equal(comparison.ok, false);
    assert.deepEqual(
      comparison.issues.map(({ kind, baseline, current, delta }) => ({
        kind,
        baseline,
        current,
        delta,
      })),
      [
        {
          kind: "LEGACY_DEBT_WORSENED",
          baseline: 133,
          current: 138,
          delta: 5,
        },
      ],
    );

    const worsenedPastBoth = analyze(
      "lib/legacy.ts",
      longFunction("legacy", 145),
    );
    const deduplicated = comparisonAgainstBaselines(
      worsenedPastBoth,
      historical,
      latestMain,
    );
    assert.equal(deduplicated.issues.length, 1);
    assert.equal(deduplicated.issues[0].baseline, 133);
  });

  test("unchanged and further-improved latest-main debt pass both ceilings", () => {
    const historical = analyze("lib/legacy.ts", longFunction("legacy", 140));
    const latestMain = analyze("lib/legacy.ts", longFunction("legacy", 130));

    for (const statementCount of [130, 125]) {
      const current = analyze(
        "lib/legacy.ts",
        longFunction("legacy", statementCount),
      );
      assert.deepEqual(
        comparisonAgainstBaselines(current, historical, latestMain),
        { ok: true, issues: [] },
      );
    }
  });

  test("a pure move retains its budget across both ceilings", () => {
    const source = longFunction("legacy", 130);
    const historical = analyze("lib/original.ts", source);
    const latestMain = analyze("lib/main-location.ts", source);
    const moved = analyze("lib/current-location.ts", source);

    assert.deepEqual(
      comparisonAgainstBaselines(moved, historical, latestMain),
      { ok: true, issues: [] },
    );
  });

  test("worsened grandfathered debt fails", () => {
    const baseline = analyze("lib/legacy.ts", longFunction("legacy", 130));
    const worsened = analyze("lib/legacy.ts", longFunction("legacy", 140));

    assert.ok(issueKinds(worsened, baseline).includes("LEGACY_DEBT_WORSENED"));
    const [issue] = compareAnalyses(worsened, baseline).issues;
    assert.match(
      formatMaintainabilityIssue(issue),
      /LEGACY DEBT WORSENED[\s\S]*lib\/legacy\.ts[\s\S]*Baseline: 133[\s\S]*Increase: \+10[\s\S]*Limit: 120/u,
    );
  });

  test("a pure function rename and file move retains its grandfathered budget", () => {
    const baseline = analyze("lib/original.ts", longFunction("legacy", 130));
    const moved = analyze("lib/moved.ts", longFunction("renamed", 130));

    assert.deepEqual(issueKinds(moved, baseline), []);
  });

  test("a pure move retains an oversized file budget and a copy cannot duplicate it", () => {
    const source = longFile(620);
    const baseline = analyze("lib/original-file.ts", source);
    const moved = analyze("lib/moved-file.ts", source);
    const copied = analyzeSourceEntries([
      { path: "lib/original-file.ts", source },
      { path: "lib/copied-file.ts", source },
    ]);

    assert.deepEqual(issueKinds(moved, baseline), []);
    assert.ok(
      issueKinds(copied, baseline).includes("NEW_MAINTAINABILITY_VIOLATION"),
    );
  });

  test("a moved legacy file may improve without losing its one budget", () => {
    const baseline = analyze("lib/original-file.ts", longFile(620));
    const movedAndImproved = analyze("lib/moved-file.ts", longFile(619));
    const movedAndWorsened = analyze("lib/moved-file.ts", longFile(621));

    assert.deepEqual(issueKinds(movedAndImproved, baseline), []);
    assert.ok(
      issueKinds(movedAndWorsened, baseline).includes("LEGACY_DEBT_WORSENED"),
    );
  });

  test("a moved and edited function keeps one budget without blessing a copy", () => {
    const baseline = analyze("lib/original.ts", longFunction("legacy", 130));
    const moved = analyze("lib/moved.ts", longFunction("renamed", 129));
    const copied = analyzeSourceEntries([
      { path: "lib/moved.ts", source: longFunction("renamed", 129) },
      { path: "lib/copied.ts", source: longFunction("copy", 129) },
    ]);

    assert.deepEqual(issueKinds(moved, baseline), []);
    assert.ok(
      issueKinds(copied, baseline).includes("NEW_MAINTAINABILITY_VIOLATION"),
    );
  });

  test("copying grandfathered debt creates a new violation", () => {
    const source = longFunction("legacy", 130);
    const baseline = analyze("lib/original.ts", source);
    const current = analyzeSourceEntries([
      { path: "lib/original.ts", source },
      { path: "lib/copied.ts", source },
    ]);

    assert.ok(
      issueKinds(current, baseline).includes("NEW_MAINTAINABILITY_VIOLATION"),
    );
  });

  test("delete and recreate under the same anchor cannot inherit unrelated debt", () => {
    const baseline = analyze(
      "lib/legacy.ts",
      longFunction("legacy", 130, "old"),
    );
    const replacementStatements = Array.from(
      { length: 130 },
      (_, index) => `  if (input === ${index}) input += ${index};`,
    ).join("\n");
    const replacement = `export function legacy(input) {\n${replacementStatements}\n  return input;\n}\n`;
    const current = analyze("lib/legacy.ts", replacement);

    assert.ok(
      issueKinds(current, baseline).includes("NEW_MAINTAINABILITY_VIOLATION"),
    );
  });

  test("separator and case collisions fail deterministically", () => {
    assert.throws(
      () =>
        analyzeSourceEntries([
          { path: "lib/same.ts", source: "export const one = 1;" },
          { path: "lib\\same.ts", source: "export const two = 2;" },
        ]),
      /PATH COLLISION/u,
    );
    assert.throws(
      () =>
        analyzeSourceEntries([
          { path: "lib/Case.ts", source: "export const one = 1;" },
          { path: "lib/case.ts", source: "export const two = 2;" },
        ]),
      /PATH CASE COLLISION/u,
    );
    assert.equal(
      normalizeRepositoryPath("lib\\portable.ts"),
      "lib/portable.ts",
    );
  });

  test("only known generated outputs are excluded", () => {
    assert.deepEqual(
      inventoryProductionPaths([
        "convex/_generated/api.ts",
        "convex/_generated/api.d.ts",
        "convex/_generated/handwritten.ts",
      ]),
      ["convex/_generated/api.ts", "convex/_generated/handwritten.ts"],
    );
    assert.deepEqual(
      inventoryProductionPaths([
        "quality/check.mjs",
        "quality/tests/check.test.mjs",
      ]),
      ["quality/check.mjs"],
    );
  });

  test("migration and seed exclusions are exact and separator-neutral", () => {
    assert.equal(isMigrationOrSeedPath("convex/migrations.ts"), true);
    assert.equal(isMigrationOrSeedPath("convex\\migrations.ts"), true);
    assert.equal(isMigrationOrSeedPath("CONVEX/MIGRATIONS.TS"), true);
    assert.equal(isMigrationOrSeedPath("convex/migrateNewThing.ts"), false);
    assert.deepEqual(
      inventoryProductionPaths([
        "convex/migrations.ts",
        "convex/migrateNewThing.ts",
      ]),
      ["convex/migrateNewThing.ts"],
    );
  });

  test("production root identities cannot be escaped with case or separators", () => {
    for (const [inputPath, expectedPath] of [
      ["Lib/newDebt.ts", "Lib/newDebt.ts"],
      ["CONVEX/newDebt.ts", "CONVEX/newDebt.ts"],
      ["Public\\workers\\sw.js", "Public/workers/sw.js"],
      ["QUALITY/new-rule.mjs", "QUALITY/new-rule.mjs"],
      ["SRC\\INSTRUMENTATION-CLIENT.MJS", "SRC/INSTRUMENTATION-CLIENT.MJS"],
    ]) {
      assert.deepEqual(inventoryProductionPaths([inputPath]), [expectedPath]);
    }
    assert.equal(isMigrationOrSeedPath("CONVEX/ACCOUNTINGMIGRATION.TS"), true);
    assert.deepEqual(
      inventoryProductionPaths(["CONVEX/ACCOUNTINGMIGRATION.TS"]),
      [],
    );
  });

  test("nested public executable sources are audited while static assets are ignored", () => {
    assert.deepEqual(
      inventoryProductionPaths([
        "public/sw.js",
        "public/workers/sync.mjs",
        "public/widgets/checkout.ts",
        "public/logo.svg",
        "public/catalog.json",
      ]),
      ["public/sw.js", "public/widgets/checkout.ts", "public/workers/sync.mjs"],
    );
  });

  test("all installed-framework runtime filename variants are audited exactly", () => {
    const frameworkRuntimeFiles = [
      "instrumentation-client.js",
      "instrumentation-client.jsx",
      "instrumentation-client.mjs",
      "instrumentation-client.ts",
      "instrumentation-client.tsx",
      "instrumentation.js",
      "instrumentation.jsx",
      "instrumentation.ts",
      "instrumentation.tsx",
      "middleware.js",
      "middleware.jsx",
      "middleware.ts",
      "middleware.tsx",
      "proxy.js",
      "proxy.jsx",
      "proxy.ts",
      "proxy.tsx",
      "sentry.client.config.js",
      "sentry.client.config.ts",
      "sentry.edge.config.js",
      "sentry.edge.config.ts",
      "sentry.server.config.js",
      "sentry.server.config.ts",
      "src/instrumentation-client.js",
      "src/instrumentation-client.jsx",
      "src/instrumentation-client.mjs",
      "src/instrumentation-client.ts",
      "src/instrumentation-client.tsx",
      "src/instrumentation.js",
      "src/instrumentation.jsx",
      "src/instrumentation.ts",
      "src/instrumentation.tsx",
      "src/middleware.js",
      "src/middleware.jsx",
      "src/middleware.ts",
      "src/middleware.tsx",
      "src/proxy.js",
      "src/proxy.jsx",
      "src/proxy.ts",
      "src/proxy.tsx",
    ];
    for (const runtimeFile of frameworkRuntimeFiles) {
      assert.deepEqual(inventoryProductionPaths([runtimeFile]), [runtimeFile]);
    }
    for (const ordinaryRootFile of [
      "instrumentation-client.cjs",
      "proxy.mjs",
      "sentry.client.config.mjs",
      "src/ordinary.ts",
    ]) {
      assert.deepEqual(inventoryProductionPaths([ordinaryRootFile]), []);
    }
  });

  test("working-tree and commit analysis use their own Next.js runtime configuration", (t) => {
    const root = mkdtempSync(
      join(tmpdir(), "autoflow-maintainability-config-"),
    );
    t.after(() => rmSync(root, { force: true, recursive: true }));
    runFixtureGit(root, ["init"]);
    runFixtureGit(root, ["config", "user.email", "quality@example.invalid"]);
    runFixtureGit(root, ["config", "user.name", "Quality Guardrails"]);
    writeFixture(
      root,
      "next.config.mjs",
      'export default { pageExtensions: ["mjs"] };\n',
    );
    writeFixture(root, "lib/anchor.ts", "export const anchor = true;\n");
    writeFixture(root, "proxy.mjs", "export const configured = true;\n");
    writeFixture(root, "proxy.ts", "export const defaultProxy = true;\n");
    runFixtureGit(root, ["add", "."]);
    runFixtureGit(root, ["commit", "-m", "configured mjs runtime"]);

    const committed = analyzeCommit(root, "HEAD").files.map(({ path }) => path);
    assert.ok(committed.includes("proxy.mjs"));
    assert.equal(committed.includes("proxy.ts"), false);

    writeFixture(
      root,
      "next.config.mjs",
      'export default { pageExtensions: ["ts"] };\n',
    );
    const working = analyzeWorkingTree(root).files.map(({ path }) => path);
    assert.ok(working.includes("proxy.ts"));
    assert.equal(working.includes("proxy.mjs"), false);
  });

  test("baseline provenance rejects shallow, missing-main, and branch-only sources", () => {
    const valid = {
      isShallow: false,
      originMainExists: true,
      sourceIsAncestorOfHead: true,
      sourceIsAncestorOfOriginMain: true,
    };
    assert.doesNotThrow(() => assertBaselineProvenance(valid));
    assert.throws(
      () => assertBaselineProvenance({ ...valid, isShallow: true }),
      /non-shallow/u,
    );
    assert.throws(
      () => assertBaselineProvenance({ ...valid, originMainExists: false }),
      /origin\/main/u,
    );
    assert.throws(
      () =>
        assertBaselineProvenance({
          ...valid,
          sourceIsAncestorOfOriginMain: false,
        }),
      /ancestor of origin\/main/u,
    );
  });

  test("nested anonymous arrows receive independent metrics", () => {
    const innerStatements = declarations("inner", 125);
    const branches = Array.from(
      { length: 16 },
      (_, index) => `  if (first === ${index}) first += 1;`,
    ).join("\n");
    const source = `export const outer = (first, second, third, fourth, fifth, sixth) => {\n${branches}\n  if (first) {\n    for (const row of [1]) {\n      while (second) {\n        try {\n          if (third) {\n            return [row].map((entry) => {\n${innerStatements}\n              return entry;\n            });\n          }\n        } catch (failure) {\n          return [failure];\n        }\n      }\n    }\n  }\n  return [];\n};\n`;
    const analysis = analyze("lib/nested.ts", source);
    const [outer, inner] = analysis.files[0].functions;

    assert.equal(analysis.files[0].functions.length, 2);
    assert.equal(outer.metrics.params, 6);
    assert.ok(outer.metrics.complexity > 15);
    assert.equal(outer.metrics.nesting, 5);
    assert.ok(inner.anchor.includes("call:"));
    assert.ok(inner.metrics.lines > 120);
  });

  test("nested blocks count as nesting while else-if does not add a level", () => {
    const nested = analyze(
      "lib/nested-if.ts",
      "export function nested(value) { if (value) { if (value > 1) { return value; } } return 0; }",
    ).files[0].functions[0];
    const elseIf = analyze(
      "lib/else-if.ts",
      "export function branch(value) { if (value === 1) return 1; else if (value === 2) return 2; return 0; }",
    ).files[0].functions[0];

    assert.equal(nested.metrics.nesting, 2);
    assert.equal(elseIf.metrics.nesting, 1);
  });

  test("logical, ternary, optional-chain, and assignment branches add complexity", () => {
    const source = `export function variants(input, fallback) {
  const selected = input?.first && input.second ? input.second : fallback;
  let result = selected;
  result ||= fallback;
  result &&= input?.third;
  result ??= fallback;
  return result;
}`;
    const fn = analyze("lib/complexity-variants.ts", source).files[0]
      .functions[0];

    assert.equal(fn.metrics.complexity, 8);
  });

  test("baseline JSON is recomputed and canonical rather than trusted", () => {
    const analysis = analyze("lib/legacy.ts", longFunction("legacy", 130));
    const sourceAnalysis = { sourceCommit: SOURCE_COMMIT, ...analysis };
    const baseline = createBaseline(SOURCE_COMMIT, sourceAnalysis);
    const canonical = canonicalBaselineText(baseline);

    assert.deepEqual(
      validateBaselineDocument(baseline, sourceAnalysis, canonical),
      baseline,
    );
    assert.deepEqual(
      validateBaselineDocument(
        baseline,
        sourceAnalysis,
        canonical.replaceAll("\n", "\r\n"),
      ),
      baseline,
    );
    const raised = structuredClone(baseline);
    raised.files[0].functions[0].metrics.lines += 1;
    assert.throws(
      () => validateBaselineDocument(raised, sourceAnalysis),
      /does not exactly match/u,
    );
    assert.throws(
      () =>
        validateBaselineDocument(
          baseline,
          sourceAnalysis,
          JSON.stringify(baseline),
        ),
      /not canonical/u,
    );
  });
});
