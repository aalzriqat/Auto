/**
 * SCRUM-1025 (B1): a test may be dropped from an impacted run only if it is
 * provably a pure import-graph test. These pin the scan, and pin the set of
 * tests it keeps always-running so a new text-reading test cannot slip in
 * unlisted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { collectTestFiles } from "./testCensus.mjs";
import { createPurityScanner, partitionCensus } from "./testPurity.mjs";

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purity-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return createPurityScanner(root);
}

const PURE = 'import { test } from "vitest";\ntest("x", () => {});\n';

describe("createPurityScanner", () => {
  test("a test that imports only packages and pure local modules is pure", () => {
    const scan = project({
      "lib/a.test.ts": 'import { test } from "vitest";\nimport { a } from "./a";\nimport data from "./data.json";\nimport type { T } from "@/lib/types";\ntest("x", () => { void a; void data; });\n',
      "lib/a.ts": 'export const a = 1;\nimport "./b.js";\n',
      "lib/b.ts": "export const b = 2;\n",
      "lib/data.json": "{}",
      "lib/types.d.ts": "export type T = number;\n",
    });
    expect(scan.classify("lib/a.test.ts")).toMatchObject({ pure: true, kind: "pure" });
  });

  test.each([
    ["node:fs", 'import fs from "node:fs";\n'],
    ["fs", 'import { readFileSync as r } from "fs";\n'],
    ["fs/promises", 'import { readFile as r } from "node:fs/promises";\n'],
    ["child_process", 'import { execFileSync } from "node:child_process";\n'],
    ["typescript", 'import ts from "typescript";\n'],
    ["a glob library", 'import { globSync as g } from "fast-glob";\n'],
    ["node:url", 'import { fileURLToPath } from "node:url";\n'],
    ["import.meta.glob", 'const m = import.meta.glob("./**/*.ts");\n'],
    ["a read call", "const f = (p: string) => readFileSync(p);\n"],
    ["process.cwd()", 'const here = process.cwd();\n'],
    ["__dirname", 'const here = __dirname;\n'],
    ["import.meta.url", "const here = import.meta.url;\n"],
    ["a computed dynamic import", "const m = (n: string) => import(n);\n"],
    ["a ?raw import", 'import src from "./x.ts?raw";\n'],
    ["createRequire", 'const r = createRequire(import.meta.url);\n'],
  ])("%s makes a test always-run", (_label, body) => {
    const scan = project({ "lib/a.test.ts": `${PURE}${body}` });
    expect(scan.classify("lib/a.test.ts")).toMatchObject({ pure: false, kind: "text-reading" });
  });

  test("a hit in a helper the test imports counts, transitively, and names the helper", () => {
    const scan = project({
      "lib/a.test.ts": 'import "./h1";\n',
      "lib/h1.ts": 'import "./h2";\n',
      "lib/h2.ts": 'import fs from "node:fs";\nexport const x = fs;\n',
    });
    const verdict = scan.classify("lib/a.test.ts");
    expect(verdict).toMatchObject({ pure: false, kind: "text-reading" });
    expect(verdict.reason).toBe("imports node:fs via lib/h2.ts");
  });

  test("a hit in a vi.mock'd or dynamically imported local module counts", () => {
    const scan = project({
      "lib/a.test.ts": 'import { vi } from "vitest";\nvi.mock("./m");\nawait import("./d");\n',
      "lib/m.ts": "export const m = 1;\n",
      "lib/d.ts": "export const d = readdirSync('.');\n",
    });
    expect(scan.classify("lib/a.test.ts")).toMatchObject({ pure: false, kind: "text-reading" });
  });

  test("an import the scan cannot resolve is unclassifiable, so always-run", () => {
    const scan = project({ "lib/a.test.ts": 'import "./missing";\n' });
    expect(scan.classify("lib/a.test.ts")).toMatchObject({ pure: false, kind: "unclassifiable", reason: "cannot resolve ./missing" });
  });

  test("an unreadable file is unclassifiable", () => {
    const scan = project({ "lib/a.test.ts": 'import "./dir";\n', "lib/dir/note.txt": "x" });
    expect(scan.classify("lib/a.test.ts").kind).toBe("unclassifiable");
    expect(scan.classify("lib/gone.test.ts")).toMatchObject({ pure: false, kind: "unclassifiable", reason: "unreadable" });
  });

  test("an import cycle terminates and is judged by every file in it", () => {
    const scan = project({
      "lib/a.test.ts": 'import "./x";\n',
      "lib/x.ts": 'import "./y";\n',
      "lib/y.ts": 'import "./x";\nexport const n = process.cwd();\n',
    });
    expect(scan.classify("lib/a.test.ts")).toMatchObject({ pure: false, kind: "text-reading" });
  });

  test("a directory import resolves through its index file", () => {
    const scan = project({ "lib/a.test.ts": 'import "./pkg";\n', "lib/pkg/index.ts": "export const p = 1;\n" });
    expect(scan.classify("lib/a.test.ts").pure).toBe(true);
  });
});

describe("partitionCensus", () => {
  test("backend and gate suites always run without being scanned; the rest is split by purity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "purity-"));
    for (const [file, text] of Object.entries({
      "convex/sales.test.ts": PURE,
      "components/Pure.test.tsx": PURE,
      "components/Reads.test.tsx": 'import fs from "node:fs";\n',
    })) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    const parts = partitionCensus(root, ["convex/sales.test.ts", "components/Pure.test.tsx", "components/Reads.test.tsx"]);
    expect(parts.alwaysRun).toEqual(["convex/sales.test.ts"]);
    expect(parts.candidates).toEqual(["components/Pure.test.tsx"]);
    expect(parts.textReading.map((entry) => entry.file)).toEqual(["components/Reads.test.tsx"]);
  });
});

describe("the always-run text-reading set of this repository", () => {
  const root = path.resolve(__dirname, "..", "..");
  const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, "textReadingTests.json"), "utf8")) as Record<"text-reading" | "unclassifiable", string[]>;
  const census = (collectTestFiles(root) as string[]).filter((file) => file !== "convex/unifiedDealFeeAuthority.test.ts");
  const { textReading, candidates } = partitionCensus(root, census);
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const kind = (k: string) => textReading.filter((entry) => entry.purity.kind === k).map((entry) => entry.file).toSorted(byCodeUnit);

  test("the named guard tests are always-run, never droppable", () => {
    for (const file of [
      "components/sales/SaleDialogContractSkew.test.ts",
      "lib/errors.test.ts",
      "lib/moneyDisplay.test.ts",
      "lib/pilotCapabilityManifest.test.ts",
      "test-utils/pilotConfigParity.test.ts",
      "scripts/commitmentWriteGuard.test.ts",
      "scripts/receiptAuthorityStructuralRatchet.test.ts",
      "scripts/clientIdentityLifetime.test.ts",
      "scripts/contractSkew/transmissionReachability.test.ts",
      "scripts/contractSkew/census.test.ts",
    ]) {
      expect(candidates, file).not.toContain(file);
    }
  });

  test("every text-reading test is listed in textReadingTests.json (a new one fails here until reviewed and added)", () => {
    expect(kind("text-reading")).toEqual(pinned["text-reading"]);
  });

  test("every test the scan cannot classify is listed too, so none is classified silently", () => {
    expect(kind("unclassifiable")).toEqual(pinned.unclassifiable);
  });

  test("the pinned lists are sorted, duplicate-free and name real census files", () => {
    for (const list of Object.values(pinned)) {
      expect(list).toEqual(list.toSorted(byCodeUnit));
      expect(new Set(list).size).toBe(list.length);
      for (const file of list) expect(census, file).toContain(file);
    }
  });

  test("the droppable set is small, import-graph only, and still contains tests for the threshold files", () => {
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates).toContain("lib/commission.test.ts");
  });
});
