import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { runArchitectureSnapshotWorker } from "../architecture-source-snapshot.mjs";
import { findNonliteralRuntimeImports } from "../architecture-runtime-imports.mjs";

import {
  ARCHITECTURE_ENGINE_VERSION,
  ARCHITECTURE_ENTRY_POINTS,
  architectureGraph,
  assertArchitectureBaselineIntegrity,
  cruiseArchitecture,
  evaluateArchitecture,
  normalizeArchitecturePath,
  runtimeCycleSnapshot,
} from "../architecture.mjs";

const SOURCE_COMMIT = "4ab1dd3a8d4c745c1b2f02a404234d0f07d96ce7";
const TS_CONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      allowJs: true,
      baseUrl: ".",
      module: "ESNext",
      moduleResolution: "Bundler",
      paths: { "@/*": ["./*"] },
      strict: true,
      target: "ESNext",
    },
  },
  null,
  2,
)}\n`;

function fixtureEntryPoint(filePath) {
  if (filePath.startsWith("packages/shared/src/")) return "packages/shared/src";
  if (filePath.startsWith("apps/mobile/src/")) return "apps/mobile/src";
  if (filePath.startsWith("apps/mobile/app/")) return "apps/mobile/app";
  if (filePath.startsWith("dealer-worker/src/")) return "dealer-worker/src";
  if (filePath === "instrumentation.ts" || filePath === "proxy.ts")
    return filePath;
  return filePath.split("/")[0];
}

function fixtureEntryPoints(files) {
  return [...new Set(Object.keys(files).map(fixtureEntryPoint))].sort();
}

async function writeFixtureFile(rootDir, filePath, contents) {
  const absolutePath = join(rootDir, ...filePath.split("/"));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

async function createFixture(t, files) {
  const rootDir = await mkdtemp(join(tmpdir(), "autoflow-architecture-"));
  t.after(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });
  await writeFixtureFile(rootDir, "tsconfig.json", TS_CONFIG);
  await Promise.all(
    Object.entries(files).map(([filePath, contents]) =>
      writeFixtureFile(rootDir, filePath, contents),
    ),
  );

  const entryPoints = fixtureEntryPoints(files);
  return {
    rootDir,
    write: (filePath, contents) =>
      writeFixtureFile(rootDir, filePath, contents),
    cruise: () => cruiseArchitecture({ rootDir, entryPoints }),
  };
}

async function createFixtureWithoutBaseUrl(t, files) {
  const fixture = await createFixture(t, files);
  await fixture.write(
    "tsconfig.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          paths: { "@/*": ["./*"] },
          strict: true,
          target: "ESNext",
        },
      },
      null,
      2,
    )}\n`,
  );
  return fixture;
}

function baselineFromSnapshot(snapshot) {
  return {
    version: 1,
    sourceCommit: SOURCE_COMMIT,
    engineVersion: ARCHITECTURE_ENGINE_VERSION,
    cyclicModules: snapshot.cyclicModules,
    cyclicEdges: snapshot.cyclicEdges,
  };
}

function emptyBaseline() {
  return baselineFromSnapshot({ cyclicModules: [], cyclicEdges: [] });
}

function baselineFor(cruiseResult) {
  return baselineFromSnapshot(
    runtimeCycleSnapshot(architectureGraph(cruiseResult)),
  );
}

function rules(report, kind = "FORBIDDEN ARCHITECTURE DEPENDENCY") {
  return report.violations
    .filter((violation) => violation.kind === kind)
    .map((violation) => violation.rule)
    .sort();
}

test("standalone framework and browser runtime files are architecture entrypoints", () => {
  for (const entryPoint of [
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
    "public",
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
  ]) {
    assert.ok(ARCHITECTURE_ENTRY_POINTS.includes(entryPoint), entryPoint);
  }
});

test("present framework entrypoints are scanned while absent variants stay optional", async (t) => {
  const fixture = await createFixture(t, {
    "instrumentation-client.js":
      'import { helper } from "./lib/helper";\nexport const hook = helper + 1;\n',
    "lib/helper.ts":
      'import { hook } from "../instrumentation-client";\nexport const helper = hook + 1;\n',
  });

  const cruiseResult = await cruiseArchitecture({
    rootDir: fixture.rootDir,
    entryPoints: ARCHITECTURE_ENTRY_POINTS,
  });
  const report = evaluateArchitecture(cruiseResult, emptyBaseline());
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshot.cyclicModules, [
    "instrumentation-client.js",
    "lib/helper.ts",
  ]);
});

test("configured Next.js page extensions add root and src runtime entrypoints", async (t) => {
  const fixture = await createFixture(t, {
    "next.config.mjs": 'export default { pageExtensions: ["mjs"] };\n',
    "proxy.mjs":
      'import { srcProxy } from "./src/proxy.mjs";\nexport const rootProxy = srcProxy + 1;\n',
    "src/proxy.mjs":
      'import { rootProxy } from "../proxy.mjs";\nexport const srcProxy = rootProxy + 1;\n',
  });

  const cruiseResult = await cruiseArchitecture({ rootDir: fixture.rootDir });
  const report = evaluateArchitecture(cruiseResult, emptyBaseline());
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshot.cyclicModules, [
    "proxy.mjs",
    "src/proxy.mjs",
  ]);
  assert.deepEqual(report.snapshot.cyclicEdges, [
    { from: "proxy.mjs", to: "src/proxy.mjs" },
    { from: "src/proxy.mjs", to: "proxy.mjs" },
  ]);
});

test("shared code cannot depend on any supported standalone runtime variant", async (t) => {
  const fixture = await createFixture(t, {
    "instrumentation-client.js": "export const hook = true;\n",
    "packages/shared/src/domain.ts":
      'import { hook } from "../../../instrumentation-client";\nexport const domain = hook;\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, false);
  assert.ok(rules(report).includes("shared-package-independent"));
});

test("nested public executable sources participate in architecture checks", async (t) => {
  const fixture = await createFixture(t, {
    "public/workers/a.js":
      'import { b } from "./b.js";\nexport const a = b + 1;\n',
    "public/workers/b.js":
      'import { a } from "./a.js";\nexport const b = a + 1;\n',
    "public/logo.svg": "<svg></svg>\n",
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshot.cyclicModules, [
    "public/workers/a.js",
    "public/workers/b.js",
  ]);
});

test("deep dependency graphs do not overflow the cycle scanner", () => {
  const moduleCount = 5_000;
  const modules = Array.from(
    { length: moduleCount },
    (_, index) => `lib/module-${String(index).padStart(6, "0")}.ts`,
  );
  const edges = modules.slice(0, -1).map((from, index) => ({
    from,
    to: modules[index + 1],
    runtime: true,
  }));

  assert.deepEqual(runtimeCycleSnapshot({ modules, edges }), {
    cyclicModules: [],
    cyclicEdges: [],
  });

  const closingEdge = {
    from: modules.at(-1),
    to: modules[0],
    runtime: true,
  };
  assert.deepEqual(
    runtimeCycleSnapshot({ modules, edges: [...edges, closingEdge] }),
    {
      cyclicModules: modules,
      cyclicEdges: [...edges, closingEdge].map(({ from, to }) => ({
        from,
        to,
      })),
    },
  );
});

test("a new runtime cycle fails while the exact grandfathered cycle passes", async (t) => {
  const fixture = await createFixture(t, {
    "lib/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
    "lib/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
  });
  const cruiseResult = await fixture.cruise();

  const newCycleReport = evaluateArchitecture(cruiseResult, emptyBaseline());
  assert.equal(newCycleReport.ok, false);
  assert.deepEqual(newCycleReport.snapshot.cyclicModules, [
    "lib/a.ts",
    "lib/b.ts",
  ]);
  assert.deepEqual(newCycleReport.snapshot.cyclicEdges, [
    { from: "lib/a.ts", to: "lib/b.ts" },
    { from: "lib/b.ts", to: "lib/a.ts" },
  ]);
  assert.ok(
    newCycleReport.violations.some(
      (violation) => violation.kind === "NEW CYCLIC MODULE",
    ),
  );
  assert.ok(
    newCycleReport.violations.some(
      (violation) => violation.kind === "NEW CIRCULAR DEPENDENCY EDGE",
    ),
  );

  const grandfatheredReport = evaluateArchitecture(
    cruiseResult,
    baselineFor(cruiseResult),
  );
  assert.equal(grandfatheredReport.ok, true);
  assert.deepEqual(grandfatheredReport.violations, []);
});

test("branch-created cycles cannot be disguised as source-commit baseline debt", async (t) => {
  const sourceFixture = await createFixture(t, {
    "lib/a.ts": "export const a = 1;\n",
    "lib/b.ts": "export const b = 1;\n",
  });
  const branchFixture = await createFixture(t, {
    "lib/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
    "lib/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
  });
  const sourceCruise = await sourceFixture.cruise();
  const branchCruise = await branchFixture.cruise();
  const inflatedBaseline = baselineFor(branchCruise);

  assert.equal(
    evaluateArchitecture(branchCruise, inflatedBaseline).ok,
    true,
    "the comparison alone demonstrates the former baseline-inflation bypass",
  );
  assert.throws(
    () =>
      assertArchitectureBaselineIntegrity({
        baseline: inflatedBaseline,
        originMainCommit: SOURCE_COMMIT,
        sourceSnapshot: runtimeCycleSnapshot(architectureGraph(sourceCruise)),
        engineVersion: ARCHITECTURE_ENGINE_VERSION,
      }),
    /ARCHITECTURE BASELINE INTEGRITY ERROR.*Unexpected cyclic modules.*lib\/a\.ts.*Unexpected cyclic edges/s,
  );
});

test("baseline integrity permits ratcheting down but rejects debt absent at the source commit", async (t) => {
  const sourceFixture = await createFixture(t, {
    "lib/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
    "lib/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
  });
  const improvedFixture = await createFixture(t, {
    "lib/a.ts": "export const a = 1;\n",
    "lib/b.ts": "export const b = 1;\n",
  });
  const sourceSnapshot = runtimeCycleSnapshot(
    architectureGraph(await sourceFixture.cruise()),
  );
  const exactBaseline = baselineFromSnapshot(sourceSnapshot);
  const prunedBaseline = emptyBaseline();

  assert.equal(
    assertArchitectureBaselineIntegrity({
      baseline: exactBaseline,
      originMainCommit: SOURCE_COMMIT,
      sourceSnapshot,
      engineVersion: ARCHITECTURE_ENGINE_VERSION,
    }),
    true,
  );
  assert.equal(
    assertArchitectureBaselineIntegrity({
      baseline: prunedBaseline,
      originBaseline: exactBaseline,
      originMainCommit: SOURCE_COMMIT,
      sourceSnapshot,
      engineVersion: ARCHITECTURE_ENGINE_VERSION,
    }),
    true,
  );
  assert.equal(
    evaluateArchitecture(await improvedFixture.cruise(), prunedBaseline).ok,
    true,
  );

  assert.throws(
    () =>
      assertArchitectureBaselineIntegrity({
        baseline: exactBaseline,
        originBaseline: prunedBaseline,
        originMainCommit: SOURCE_COMMIT,
        sourceSnapshot,
        engineVersion: ARCHITECTURE_ENGINE_VERSION,
      }),
    /already pruned from the origin\/main baseline/,
  );
});

test("bootstrap baseline must use the exact resolved origin/main commit", () => {
  const sourceSnapshot = { cyclicModules: [], cyclicEdges: [] };
  const oldBaseline = {
    ...emptyBaseline(),
    sourceCommit: "3".repeat(40),
  };

  assert.throws(
    () =>
      assertArchitectureBaselineIntegrity({
        baseline: oldBaseline,
        originMainCommit: SOURCE_COMMIT,
        sourceSnapshot,
        engineVersion: ARCHITECTURE_ENGINE_VERSION,
      }),
    /Bootstrap source mismatch: baseline 333+; origin\/main 4ab1dd3a.*exact current origin\/main commit/s,
  );
});
test("an improved graph requires a pruned baseline and then passes", async (t) => {
  const fixture = await createFixture(t, {
    "lib/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
    "lib/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
  });
  const originalCruise = await fixture.cruise();
  const legacyBaseline = baselineFor(originalCruise);

  await fixture.write("lib/b.ts", "export const b = 1;\n");
  const improvedCruise = await fixture.cruise();
  const staleReport = evaluateArchitecture(improvedCruise, legacyBaseline);
  assert.equal(staleReport.ok, false);
  assert.ok(
    staleReport.violations.some(
      (violation) => violation.kind === "STALE ARCHITECTURE BASELINE",
    ),
  );

  const prunedReport = evaluateArchitecture(improvedCruise, emptyBaseline());
  assert.equal(prunedReport.ok, true);
  assert.deepEqual(prunedReport.snapshot, {
    cyclicModules: [],
    cyclicEdges: [],
  });
});

test("higher layers may depend on lower layers", async (t) => {
  const fixture = await createFixture(t, {
    "app/page.ts":
      'import { widget } from "../components/widget";\nexport const page = widget;\n',
    "components/widget.ts": 'export const widget = "ok";\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
});

test("production modules cannot import excluded test modules", async (t) => {
  const fixture = await createFixture(t, {
    "lib/runtime.ts":
      'import { helper } from "./helper";\nimport { testOnly } from "./helper.test";\nimport { fixtureOnly } from "./__tests__/fixture";\nexport const runtime = helper + testOnly + fixtureOnly;\n',
    "lib/helper.ts": "export const helper = 1;\n",
    "lib/helper.test.ts":
      'import { helper } from "./helper";\nexport const testOnly = helper;\n',
    "lib/__tests__/fixture.ts": "export const fixtureOnly = 1;\n",
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  const violations = report.violations.filter(
    (violation) => violation.rule === "runtime-no-test-modules",
  );
  assert.equal(report.ok, false);
  assert.deepEqual(violations.map((violation) => violation.to).sort(), [
    "lib/__tests__/fixture.ts",
    "lib/helper.test.ts",
  ]);
  assert.equal(
    violations.some((violation) => violation.from === "lib/helper.test.ts"),
    false,
    "test modules may still exercise production modules",
  );
});

test("ordinary runtime modules cannot use excluded migrations as helper modules", async (t) => {
  const fixture = await createFixture(t, {
    "convex/helper.ts": "export const helper = 1;\n",
    "convex/migrations.ts":
      'import { helper } from "./helper";\nexport const migration = helper;\n',
    "convex/migrateNewThing.ts": "export const ordinaryModule = 1;\n",
    "convex/runtime.ts":
      'import { migration } from "./migrations";\nimport { ordinaryModule } from "./migrateNewThing";\nexport const runtime = migration + ordinaryModule;\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  const violations = report.violations.filter(
    (violation) => violation.rule === "runtime-no-migration-modules",
  );
  assert.equal(report.ok, false);
  assert.deepEqual(
    violations.map(({ from, to }) => ({ from, to })),
    [{ from: "convex/runtime.ts", to: "convex/migrations.ts" }],
  );
});

test("migrations and tests may still depend in the safe direction", async (t) => {
  const fixture = await createFixture(t, {
    "convex/helper.ts": "export const helper = 1;\n",
    "convex/migrations.ts":
      'import { helper } from "./helper";\nexport const migration = helper;\n',
    "convex/runtime.test.ts":
      'import { migration } from "./migrations";\nexport const result = migration;\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
});

test("all seven production layer boundaries reject forbidden dependencies", async (t) => {
  const fixture = await createFixture(t, {
    "app/page.ts":
      'import { mobile } from "../apps/mobile/src/mobile";\nexport const page = mobile;\n',
    "components/widget.ts": "export const widget = 1;\n",
    "components/routeConsumer.ts":
      'import { page } from "../app/page";\nexport const routeConsumer = page;\n',
    "convex/backend.ts":
      'import { widget } from "../components/widget";\nexport const backend = widget;\n',
    "hooks/useThing.ts": "export const useThing = 1;\n",
    "lib/lower.ts":
      'import { widget } from "../components/widget";\nexport const lower = widget;\n',
    "lib/value.ts": "export const value = 1;\n",
    "packages/shared/src/domain.ts":
      'import { value } from "../../../lib/value";\nexport const domain = value;\n',
    "apps/mobile/src/screen.ts":
      'import { useThing } from "../../../hooks/useThing";\nexport const screen = useThing;\n',
    "apps/mobile/src/mobile.ts": "export const mobile = 1;\n",
    "quality/guard.mjs":
      'import { value } from "../lib/value";\nexport const guard = value;\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, false);
  assert.deepEqual(rules(report), [
    "backend-no-presentation",
    "lower-layers-no-presentation",
    "mobile-no-web-or-backend",
    "quality-tooling-independent",
    "routes-are-entrypoints",
    "shared-package-independent",
    "web-no-mobile",
  ]);
});

test("root aliases participate in runtime cycle detection", async (t) => {
  const fixture = await createFixture(t, {
    "lib/a.ts": 'import { b } from "@/lib/b";\nexport const a = b + 1;\n',
    "lib/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshot.cyclicEdges, [
    { from: "lib/a.ts", to: "lib/b.ts" },
    { from: "lib/b.ts", to: "lib/a.ts" },
  ]);
  assert.equal(rules(report, "UNRESOLVED INTERNAL IMPORT").length, 0);
});

test("isolated source snapshots resolve aliases inside their checkout", async (t) => {
  const fixture = await createFixtureWithoutBaseUrl(t, {
    "lib/a.ts": 'import { b } from "@/lib/b";\nexport const a = b + 1;\n',
    "lib/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
  });

  const snapshot = await runArchitectureSnapshotWorker({
    checkoutDir: fixture.rootDir,
    entryPoints: ["lib"],
  });
  assert.deepEqual(snapshot.cyclicEdges, [
    { from: "lib/a.ts", to: "lib/b.ts" },
    { from: "lib/b.ts", to: "lib/a.ts" },
  ]);
});

test("barrel re-exports cannot hide a runtime cycle", async (t) => {
  const fixture = await createFixture(t, {
    "lib/a.ts": 'import { b } from "./index";\nexport const a = b + 1;\n',
    "lib/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
    "lib/index.ts": 'export { b } from "./b";\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshot.cyclicModules, [
    "lib/a.ts",
    "lib/b.ts",
    "lib/index.ts",
  ]);
  assert.deepEqual(report.snapshot.cyclicEdges, [
    { from: "lib/a.ts", to: "lib/index.ts" },
    { from: "lib/b.ts", to: "lib/a.ts" },
    { from: "lib/index.ts", to: "lib/b.ts" },
  ]);
});

test("dynamic imports cannot hide a runtime cycle", async (t) => {
  const fixture = await createFixture(t, {
    "lib/a.ts": 'export const loadB = () => import("./b");\n',
    "lib/b.ts": 'import { loadB } from "./a";\nexport const b = loadB;\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshot.cyclicEdges, [
    { from: "lib/a.ts", to: "lib/b.ts" },
    { from: "lib/b.ts", to: "lib/a.ts" },
  ]);
});

test("production cannot bridge through repository source outside the audited roots", async (t) => {
  const fixture = await createFixture(t, {
    "lib/a.ts":
      'import { bridge } from "../scripts/bridge";\nexport const a = bridge;\n',
    "scripts/bridge.ts":
      'import { a } from "../lib/a";\nexport const bridge = a;\n',
  });

  const cruiseResult = await cruiseArchitecture({
    rootDir: fixture.rootDir,
    entryPoints: ["lib"],
  });
  const report = evaluateArchitecture(cruiseResult, emptyBaseline());
  assert.equal(report.ok, false);
  assert.ok(rules(report).includes("runtime-no-unscoped-modules"));
  assert.deepEqual(report.snapshot, { cyclicModules: [], cyclicEdges: [] });
});

test("nonliteral runtime imports fail closed while literal imports remain resolved", async (t) => {
  const fixture = await createFixture(t, {
    "lib/a.ts":
      'const target = "./b";\nexport const loadB = () => import(target);\n',
    "lib/b.ts": 'import { loadB } from "./a";\nexport const b = loadB;\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  const violations = report.violations.filter(
    (violation) => violation.kind === "NONLITERAL RUNTIME IMPORT",
  );
  assert.equal(report.ok, false);
  assert.equal(violations.length, 1);
  assert.deepEqual(
    {
      column: violations[0].column,
      from: violations[0].from,
      line: violations[0].line,
      rule: violations[0].rule,
    },
    {
      column: 28,
      from: "lib/a.ts",
      line: 2,
      rule: "runtime-imports-resolve",
    },
  );
  assert.deepEqual(report.snapshot, { cyclicModules: [], cyclicEdges: [] });
});

test("literal dynamic imports accept only static import attributes", () => {
  const allowed = [
    'export const data = import("./data.json", { with: { type: "json" } });',
    'export const data = import(`./data.json`, { "with": { "type": "json" } });',
  ];
  for (const [index, source] of allowed.entries()) {
    assert.deepEqual(
      findNonliteralRuntimeImports(source, `lib/attributes-${index}.ts`),
      [],
    );
  }

  const blocked = [
    'const target = "./data.json"; export const data = import(target, { with: { type: "json" } });',
    'const options = { with: { type: "json" } }; export const data = import("./data.json", options);',
    'const attributes = { type: "json" }; export const data = import("./data.json", { with: attributes });',
    'const type = "json"; export const data = import("./data.json", { with: { type } });',
    'export const data = import("./data.json", { with: { ...{ type: "json" } } });',
    'export const data = import("./data.json", { with: { type: "json" }, extra: true });',
    'export const data = import(("./data.json" as string), { with: { type: "json" } });',
    'export const data = import("./data.json", { with: { type: "json" } }, "extra");',
    'export const data = require("./data.json", { with: { type: "json" } });',
  ];
  for (const [index, source] of blocked.entries()) {
    assert.ok(
      findNonliteralRuntimeImports(source, `lib/invalid-attributes-${index}.ts`)
        .length > 0,
      `expected invalid import attributes case ${index} to fail`,
    );
  }

  const nodeLoader = findNonliteralRuntimeImports(
    'export const moduleApi = import("node:module", { with: {} });',
    "lib/node-loader-attributes.ts",
  );
  assert.ok(
    nodeLoader.some(
      (violation) => violation.kind === "UNTRACEABLE NODE MODULE LOADER",
    ),
  );
});

test("CommonJS runtime loaders cannot hide repository dependencies", async (t) => {
  const blocked = {
    nonliteralRequire:
      'const target = "./b";\nexport const load = () => require(target);\n',
    aliasedRequire:
      'const target = "./b";\nconst load = require;\nexport const run = () => load(target);\n',
    moduleRequire: 'export const load = () => module.require("./b");\n',
    createRequire:
      'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const run = () => load("./b");\n',
    directCreateRequire:
      'import * as moduleApi from "node:module";\nexport const run = () => moduleApi.createRequire(import.meta.url)("./b");\n',
    externalCreateRequire:
      'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const parser = load("external-package/parser");\n',
    requireMainDirect:
      'const target = "./b";\nexport const load = () => require.main?.require(target);\n',
    requireMainAlias:
      'const target = "./b";\nconst main = require.main;\nexport const load = () => main?.require(target);\n',
    requireCacheAlias:
      'const target = "./b";\nconst current = require.cache[__filename];\nexport const load = () => current?.require(target);\n',
    moduleParentDirect:
      'const target = "./b";\nexport const load = () => module.parent?.require(target);\n',
    moduleParentAlias:
      'const target = "./b";\nconst parent = module.parent;\nexport const load = () => parent?.require(target);\n',
    moduleAlias:
      'const target = "./b";\nconst current = module;\nexport const load = () => current.require(target);\n',
    processMainAlias:
      'const target = "./b";\nconst main = process.mainModule;\nexport const load = () => main?.require(target);\n',
    processBuiltinModule:
      'const target = "./b";\nexport const load = () => process.getBuiltinModule("node:module").createRequire(import.meta.url)(target);\n',
    globalThisProcessDirect:
      'const target = "./b";\nexport const load = () => globalThis.process.getBuiltinModule("node:module").createRequire(import.meta.url)(target);\n',
    globalProcessComputed:
      'const target = "./b";\nexport const load = () => global["process"]["getBuiltinModule"]("node:module").createRequire(import.meta.url)(target);\n',
    globalThisProcessAlias:
      'const target = "./b";\nconst runtime = globalThis.process;\nexport const load = () => runtime.getBuiltinModule("node:module").createRequire(import.meta.url)(target);\n',
    globalObjectAlias:
      'const target = "./b";\nconst runtime = globalThis;\nexport const load = () => runtime.process.getBuiltinModule("node:module").createRequire(import.meta.url)(target);\n',
    globalThisProcessDestructure:
      'const target = "./b";\nconst { process: runtime } = globalThis;\nexport const load = () => runtime.getBuiltinModule("node:module").createRequire(import.meta.url)(target);\n',
    globalThisModuleComputed:
      'const target = "./b";\nexport const load = () => globalThis["module"]["require"](target);\n',
    globalRequireDirect:
      'const target = "./b";\nexport const load = () => global.require(target);\n',
    namedProcessBuiltinModule:
      'import { getBuiltinModule } from "node:process";\nconst target = "./b";\nexport const load = () => getBuiltinModule("node:module").createRequire(import.meta.url)(target);\n',
    namespaceProcessBuiltinModule:
      'import * as processApi from "node:process";\nconst target = "./b";\nexport const load = () => processApi.getBuiltinModule("node:module").createRequire(import.meta.url)(target);\n',
    defaultProcessBuiltinModule:
      'import processApi from "process";\nconst target = "./b";\nexport const load = () => processApi.getBuiltinModule("node:module").createRequire(import.meta.url)(target);\n',
    commonJsProcessBuiltinModule:
      'const processApi = require("node:process");\nconst target = "./b";\nexport const load = () => processApi.getBuiltinModule("node:module").createRequire(import.meta.url)(target);\n',
    moduleRequireProcessBuiltinModule:
      'const processApi = module.require("node:process");\nconst target = "./b";\nexport const load = () => processApi.getBuiltinModule("node:module").createRequire(import.meta.url)(target);\n',
    reexportProcessBuiltinModule:
      'export { getBuiltinModule as loaderFactory } from "node:process";\n',
    namedModuleClass:
      'import { Module } from "node:module";\nconst target = "./b";\nexport const load = () => Module.createRequire(import.meta.url)(target);\n',
    namedDefaultModuleClass:
      'import { default as Module } from "node:module";\nconst target = "./b";\nexport const load = () => Module.createRequire(import.meta.url)(target);\n',
    importEqualsNodeModule:
      'import Module = require("node:module");\nconst target = "./b";\nexport const load = () => Module.createRequire(import.meta.url)(target);\n',
    directEval:
      'const target = "./b";\nconst load = eval("require");\nexport const value = load(target);\n',
    aliasedEval:
      'const target = "./b";\nconst evaluate = eval;\nconst load = evaluate("require");\nexport const value = load(target);\n',
    computedGlobalEval:
      'const target = "./b";\nconst load = globalThis["eval"]("require");\nexport const value = load(target);\n',
    directFunction:
      'const target = "./b";\nconst load = Function("return require")();\nexport const value = load(target);\n',
    newFunction:
      'const target = "./b";\nconst load = new Function("return require")();\nexport const value = load(target);\n',
    aliasedFunction:
      'const target = "./b";\nconst Generator = Function;\nconst load = Generator("return require")();\nexport const value = load(target);\n',
    computedGlobalFunction:
      'const target = "./b";\nconst load = global["Function"]("return require")();\nexport const value = load(target);\n',
    functionExpressionConstructor:
      'const target = "./b";\nconst load = (function () {}).constructor("return require")();\nexport const value = load(target);\n',
    asyncFunctionConstructor:
      'const target = "./b";\nconst load = (async () => {}).constructor("return require")();\nexport const value = load(target);\n',
    chainedConstructor:
      'const target = "./b";\nconst load = ({}).constructor.constructor("return require")();\nexport const value = load(target);\n',
    globalObjectConstructor:
      'const target = "./b";\nconst load = Object.constructor("return require")();\nexport const value = load(target);\n',
    functionDeclarationConstructor:
      'function helper() {}\nconst target = "./b";\nconst load = helper.constructor("return require")();\nexport const value = load(target);\n',
    functionAliasConstructor:
      'const helper = () => {};\nconst target = "./b";\nconst load = helper.constructor("return require")();\nexport const value = load(target);\n',
    methodConstructor:
      'const helper = { run() {} };\nconst target = "./b";\nconst load = helper.run.constructor("return require")();\nexport const value = load(target);\n',
    arrayMethodConstructor:
      'const target = "./b";\nconst load = [].filter.constructor("return require")();\nexport const value = load(target);\n',
    aliasedMethodConstructor:
      'const target = "./b";\nconst Generator = [].filter["constructor"];\nconst load = Generator("return require")();\nexport const value = load(target);\n',
    concatenatedConstructor:
      'const target = "./b";\nconst load = [].filter["con" + "structor"]("return require")();\nexport const value = load(target);\n',
    reflectedConstructor:
      'const target = "./b";\nconst Generator = Reflect.get(() => {}, "constructor");\nconst load = Generator("return require")();\nexport const value = load(target);\n',
    importedUnknownFunctionConstructor:
      'import path from "node:path";\nconst target = "./b";\nconst load = path.join.constructor("return require")();\nexport const value = load(target);\n',
    computedUnknownFunctionConstructor:
      'import path from "node:path";\nconst member = "constructor";\nconst target = "./b";\nconst load = path.join[member]("return require")();\nexport const value = load(target);\n',
    namedVmRunner:
      'import { runInThisContext } from "node:vm";\nexport const load = runInThisContext("process.getBuiltinModule(\\"node:module\\")");\n',
    namedVmCompileFunction:
      'import { compileFunction } from "node:vm";\nexport const load = compileFunction("return require");\n',
    namedVmScript:
      'import { Script } from "node:vm";\nexport const load = new Script("process.getBuiltinModule(\\"node:module\\")");\n',
    namedVmSourceTextModule:
      'import { SourceTextModule } from "node:vm";\nexport const load = new SourceTextModule("import(\\"./b\\")");\n',
    namespaceVm:
      'import * as vm from "node:vm";\nexport const load = vm.runInThisContext("process");\n',
    commonJsVm:
      'const vm = require("node:vm");\nexport const load = vm.runInThisContext("process");\n',
    reexportVmRunner: 'export { runInNewContext as execute } from "node:vm";\n',
    workerImportScripts:
      'importScripts("./hidden.js");\nexport const loaded = true;\n',
    workerImportScriptsNonliteral:
      'const target = "./hidden.js";\nimportScripts(target);\nexport const loaded = true;\n',
    workerImportScriptsAlias:
      'const load = importScripts;\nload("./hidden.js");\nexport const loaded = true;\n',
    workerSelfImportScripts:
      'self["importScripts"]("./hidden.js");\nexport const loaded = true;\n',
    workerGlobalImportScripts:
      'globalThis.importScripts("./hidden.js");\nexport const loaded = true;\n',
    workerGlobalAlias:
      'const worker = self;\nworker.importScripts("./hidden.js");\nexport const loaded = true;\n',
    workerTopLevelThis:
      'this.importScripts("./hidden.js");\nexport const loaded = true;\n',
    workerArrowThis:
      'const load = () => this["importScripts"]("./hidden.js");\nload();\n',
  };
  for (const [name, source] of Object.entries(blocked)) {
    await t.test(name, () => {
      assert.ok(
        findNonliteralRuntimeImports(source, `lib/${name}.ts`).length > 0,
      );
    });
  }

  const allowed = {
    literalRequire: 'export const load = () => require("./external");\n',
    namedNodeModuleImport:
      'import { builtinModules } from "node:module";\nexport const modules = builtinModules;\n',
    shadowedRequire:
      'const target = "./b";\nexport const load = (require: (value: string) => unknown) => require(target);\n',
    shadowedModule:
      'const target = "./b";\nexport const load = (module: { require(value: string): unknown }) => module.require(target);\n',
    customRequireObject:
      'const target = "./b";\nconst loader = { require: (value: string) => value };\nexport const load = () => loader.require(target);\n',
    customRequireMethod:
      'const target = "./b";\nexport const loader = { require(value: string) { return value; }, load() { return this.require(target); } };\n',
    importEqualsRequire:
      'import require = require("./custom");\nconst target = "./b";\nexport const load = () => require(target);\n',
    importEqualsModule:
      'import module = require("./custom-module");\nconst target = "./b";\nexport const load = () => module.require(target);\n',
    safeNodeMetadata:
      'module.exports = { ok: true };\nexport const path = module.filename;\nexport const env = process.env.NODE_ENV;\nexport const resolved = require.resolve("./external");\n',
    safeNamedProcessImport:
      'import { env } from "node:process";\nexport const mode = env.NODE_ENV;\n',
    safeNamedVmImport:
      'import { createContext, isContext } from "node:vm";\nconst context = createContext({});\nexport const valid = isContext(context);\n',
    safeGlobalObjectMembers:
      'export const uuid = globalThis.crypto.randomUUID();\nexport const mode = globalThis.process.env.NODE_ENV;\nexport const path = global.module.filename;\nexport const resolved = globalThis.require.resolve("./external");\n',
    shadowedGlobalThis:
      'const runtime = { process: { getBuiltinModule: () => "custom" } };\nexport const load = (globalThis: typeof runtime) => globalThis.process.getBuiltinModule();\n',
    shadowedGlobal:
      'const runtime = { Function: (value: string) => value };\nexport const load = (global: typeof runtime) => global.Function("custom");\n',
    customProcessObject:
      'const runtime = { process: { getBuiltinModule: () => "custom" } };\nexport const load = () => runtime.process.getBuiltinModule();\n',
    shadowedEval:
      'export const load = (eval: (value: string) => string) => eval("custom");\n',
    customEval:
      'const runtime = { eval: (value: string) => value };\nexport const load = () => runtime.eval("custom");\n',
    shadowedFunction:
      'export const load = (Function: (value: string) => string) => Function("custom");\n',
    customFunction:
      'const runtime = { Function: (value: string) => value };\nexport const load = () => runtime.Function("custom");\n',
    customConstructor:
      'const runtime = { constructor: (value: string) => value };\nexport const load = () => runtime.constructor("custom");\n',
    objectConstructorMetadata:
      "const value = {};\nexport const name = value.constructor.name;\n",
    classConstructorMetadata:
      "class Vehicle {}\nexport const name = Vehicle.prototype.constructor.name;\n",
    functionConstructorMetadata:
      "const helper = () => {};\nexport const name = helper.constructor.name;\n",
    benignConstructorReflection:
      'const value = {};\nexport const constructor = Reflect.get(value, "constructor");\n',
    benignFunctionConstructorReflectionMetadata:
      'const helper = () => {};\nexport const name = Reflect.get(helper, "constructor").name;\n',
    benignUnknownConstructorCall:
      'declare const value: { constructor(input: string): unknown };\nexport const result = value.constructor("plain value");\n',
    externalWorkerImportScripts:
      'importScripts("https://cdn.example.com/worker.js");\nexport const loaded = true;\n',
    workerFeatureDetection:
      'export const available = typeof importScripts === "function";\n',
    safeWorkerGlobal:
      'self.addEventListener("message", () => {});\nexport const scope = self.registration.scope;\n',
    shadowedWorkerLoader:
      'export const load = (importScripts: (url: string) => string) => importScripts("./custom");\n',
    customWorkerLoader:
      'const worker = { importScripts: (url: string) => url };\nexport const load = () => worker.importScripts("./custom");\n',
    customThisWorkerLoader:
      'const worker = { importScripts(url: string) { return url; }, load() { return this.importScripts("./custom"); } };\nexport const loaded = worker.load();\n',
  };
  for (const [name, source] of Object.entries(allowed)) {
    await t.test(name, () => {
      assert.deepEqual(
        findNonliteralRuntimeImports(source, `lib/${name}.ts`),
        [],
      );
    });
  }
});

test("dynamic code generation cannot manufacture a hidden CommonJS loader", async (t) => {
  const fixture = await createFixture(t, {
    "lib/a.cjs":
      'const load = eval("require");\nmodule.exports = load("./b.cjs");\n',
    "lib/b.cjs": 'module.exports = require("./a.cjs");\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  const violations = report.violations.filter(
    (violation) => violation.kind === "DYNAMIC CODE GENERATION",
  );
  assert.equal(report.ok, false);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].from, "lib/a.cjs");
  assert.equal(violations[0].rule, "runtime-imports-resolve");
  assert.deepEqual(report.snapshot, { cyclicModules: [], cyclicEdges: [] });
});

test("worker script loaders cannot hide public runtime dependencies", async (t) => {
  const fixture = await createFixture(t, {
    "public/sw.js": 'importScripts("./helper.js");\nself.answer = 1;\n',
    "public/helper.js": 'import "./sw.js";\nexport const helper = true;\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  const violations = report.violations.filter(
    (violation) => violation.kind === "UNTRACEABLE WORKER LOADER",
  );
  assert.equal(report.ok, false);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].from, "public/sw.js");
  assert.equal(violations[0].rule, "runtime-imports-resolve");
  assert.deepEqual(report.snapshot, { cyclicModules: [], cyclicEdges: [] });
});

test("a direct literal require participates in runtime cycle detection", async (t) => {
  const fixture = await createFixture(t, {
    "lib/a.ts": 'export const loadB = () => require("./b");\n',
    "lib/b.ts": 'import { loadB } from "./a";\nexport const b = loadB;\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshot.cyclicEdges, [
    { from: "lib/a.ts", to: "lib/b.ts" },
    { from: "lib/b.ts", to: "lib/a.ts" },
  ]);
});

test("nonliteral runtime imports in test modules are excluded from production policy", async (t) => {
  const fixture = await createFixture(t, {
    "lib/runtime.ts": "export const runtime = true;\n",
    "lib/runtime.test.ts":
      'const target = "./runtime";\nexport const loadRuntime = () => import(target);\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
});

test("test-origin modules are not production boundaries or runtime-cycle debt", async (t) => {
  const fixture = await createFixture(t, {
    "components/View.ts": "export const view = true;\n",
    "convex/view.test.ts":
      'import { view } from "../components/View";\nimport { peer } from "./peer.test";\nexport const result = view && peer;\n',
    "convex/peer.test.ts":
      'import { result } from "./view.test";\nexport const peer = result;\n',
  });

  const cruiseResult = await fixture.cruise();
  const graph = architectureGraph(cruiseResult);
  const report = evaluateArchitecture(cruiseResult, emptyBaseline());
  assert.ok(graph.modules.includes("convex/view.test.ts"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.snapshot, { cyclicModules: [], cyclicEdges: [] });
});

test("test-only helpers outside production roots remain outside production policy", async (t) => {
  const fixture = await createFixture(t, {
    "lib/feature.test.ts":
      'import { a } from "../test-utils/a";\nexport const feature = a;\n',
    "test-utils/a.ts":
      'const target = "./b";\nimport { b } from "./b";\nexport const a = () => import(target) || b;\n',
    "test-utils/b.ts": 'import { a } from "./a";\nexport const b = a;\n',
  });

  const cruiseResult = await cruiseArchitecture({
    rootDir: fixture.rootDir,
    entryPoints: ["lib"],
  });
  const report = evaluateArchitecture(cruiseResult, emptyBaseline());
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.snapshot, { cyclicModules: [], cyclicEdges: [] });
});

test("type-only cycles are allowed but type-only boundary violations are forbidden", async (t) => {
  const fixture = await createFixture(t, {
    "components/widget.ts": "export interface WidgetProps { label: string }\n",
    "convex/viewModel.ts":
      'import type { WidgetProps } from "../components/widget";\nexport type ViewModel = WidgetProps;\n',
    "lib/a.ts": 'import type { B } from "./b";\nexport interface A { b?: B }\n',
    "lib/b.ts": 'import type { A } from "./a";\nexport interface B { a?: A }\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, false);
  assert.deepEqual(report.snapshot, { cyclicModules: [], cyclicEdges: [] });
  assert.deepEqual(rules(report), ["backend-no-presentation"]);
  assert.equal(
    report.violations.some((violation) => violation.kind.includes("CYCL")),
    false,
  );
});

test("path separators and case are canonical across the graph and baseline", async (t) => {
  const fixture = await createFixture(t, {
    "lib/a.ts": 'import { b } from "./b";\nexport const a = b + 1;\n',
    "lib/b.ts": 'import { a } from "./a";\nexport const b = a + 1;\n',
  });
  const cruiseResult = await fixture.cruise();
  const canonicalBaseline = baselineFor(cruiseResult);
  const portableBaseline = {
    ...canonicalBaseline,
    cyclicModules: canonicalBaseline.cyclicModules.map((modulePath) =>
      modulePath.toUpperCase().replaceAll("/", "\\"),
    ),
    cyclicEdges: canonicalBaseline.cyclicEdges.map((edge) => ({
      from: edge.from.toUpperCase().replaceAll("/", "\\"),
      to: edge.to.toUpperCase().replaceAll("/", "\\"),
    })),
  };

  assert.equal(normalizeArchitecturePath("LIB\\A.ts"), "lib/a.ts");
  assert.equal(evaluateArchitecture(cruiseResult, portableBaseline).ok, true);
});

test("case-colliding module identities fail closed", () => {
  assert.throws(
    () =>
      architectureGraph({
        modules: [
          { source: "lib/Feature.ts", dependencies: [] },
          { source: "LIB/feature.ts", dependencies: [] },
        ],
      }),
    /AMBIGUOUS MODULE IDENTITY/,
  );
});

test("dependency-cruiser records outside the repository scope are ignored safely", () => {
  const graph = architectureGraph({
    modules: [
      {
        source: "lib/runtime.ts",
        dependencies: [
          {
            module: "external-package",
            resolved: "../node_modules/external-package/index.js",
          },
        ],
      },
      {
        source: "../node_modules/external-package/index.js",
        dependencies: [],
      },
    ],
  });

  assert.deepEqual(graph.modules, ["lib/runtime.ts"]);
  assert.deepEqual(graph.edges, []);
});

test("unresolved internal imports fail closed", async (t) => {
  const fixture = await createFixture(t, {
    "lib/a.ts":
      'import { missing } from "@/lib/missing";\nimport type { Missing } from "@/lib/missing";\nexport const a: Missing = missing;\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  assert.equal(report.ok, false);
  assert.deepEqual(rules(report, "UNRESOLVED INTERNAL IMPORT"), [
    "internal-imports-resolve",
  ]);
});

test("workspace package export subpaths resolve to their source modules", async (t) => {
  const fixture = await createFixture(t, {
    "app/page.ts":
      'import { feature } from "@autoflow/shared/feature";\nexport const page = feature;\n',
    "packages/shared/src/feature.ts": 'export const feature = "shared";\n',
  });
  await fixture.write(
    "packages/shared/package.json",
    `${JSON.stringify(
      {
        name: "@autoflow/shared",
        type: "module",
        exports: {
          "./feature": {
            types: "./src/feature.ts",
            default: "./src/feature.ts",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const packageScope = join(fixture.rootDir, "node_modules", "@autoflow");
  await mkdir(packageScope, { recursive: true });
  await symlink(
    join(fixture.rootDir, "packages", "shared"),
    join(packageScope, "shared"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const cruiseResult = await fixture.cruise();
  const graph = architectureGraph(cruiseResult);
  const report = evaluateArchitecture(cruiseResult, emptyBaseline());
  assert.equal(report.ok, true);
  assert.deepEqual(graph.unresolved, []);
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.from === "app/page.ts" &&
        edge.to === "packages/shared/src/feature.ts",
    ),
  );
});

test("only the known Convex generated outputs are excluded", async (t) => {
  const fixture = await createFixture(t, {
    "components/widget.ts": "export const widget = 1;\n",
    "convex/main.ts":
      'import { generated } from "./_generated/api";\nimport { handwritten } from "./_generated/handwritten";\nexport const main = generated + handwritten;\n',
    "convex/_generated/api.js":
      'import { widget } from "../../components/widget";\nexport const generated = widget;\n',
    "convex/_generated/handwritten.ts":
      'import { widget } from "../../components/widget";\nexport const handwritten = widget;\n',
  });

  const report = evaluateArchitecture(await fixture.cruise(), emptyBaseline());
  const boundaryViolations = report.violations.filter(
    (violation) => violation.kind === "FORBIDDEN ARCHITECTURE DEPENDENCY",
  );
  assert.equal(report.ok, false);
  assert.equal(boundaryViolations.length, 1);
  assert.equal(boundaryViolations[0].from, "convex/_generated/handwritten.ts");
  assert.equal(boundaryViolations[0].rule, "backend-no-presentation");
});
