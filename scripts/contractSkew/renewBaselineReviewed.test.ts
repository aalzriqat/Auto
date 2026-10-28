import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { resolveGit } from "./gitExecutable.mjs";
import { createImportClosure } from "./importClosure.mjs";
import {
  RENEWED_EXPIRES,
  backendModuleOf,
  gitCompare,
  rationalePaths,
  renewBaseline,
} from "./renewBaselineReviewed.mjs";

type Compare = (file: string) => "identical" | "changed" | "missing";

const RENEWAL = "SCRUM-866: client and backend unchanged since reviewed revision c82890bd; fingerprint and cause matched in production run 40647249580";

const entry = (over: Record<string, unknown> = {}) => ({
  surface: "web",
  file: "app/page.tsx",
  callSiteId: "app/page.tsx:10:5",
  functionId: "vehicles:update",
  contractPath: "orgId",
  kind: "TYPE_UNKNOWN",
  cause: "cause",
  fingerprint: "0123456789abcdef",
  multiplicity: 1,
  rationale: "Reviewed rationale with no file reference.",
  issue: "SCRUM-711",
  expires: "2026-11-01",
  ...over,
});

const serialize = (entries: unknown[], eol = "\n") => JSON.stringify({ version: 1, entries }, null, 2).replace(/\n/g, eol) + eol;
const allIdentical: Compare = () => "identical";
const changedOnly =
  (...changed: string[]): Compare =>
  (file) =>
    changed.includes(file) ? "changed" : "identical";
type Closure = (file: string) => { files: string[]; unresolved: string[] };
// A file whose closure is only itself: isolates the direct-file rules from the import-closure rule.
const selfOnly: Closure = (file) => ({ files: [file], unresolved: [] });
const opts = (compare: Compare, closureOf: Closure = selfOnly) => ({ compare, closureOf, expires: RENEWED_EXPIRES, renewal: RENEWAL });

describe("backendModuleOf / rationalePaths", () => {
  test("the backend module is convex/<module>.ts for module:function", () => {
    expect(backendModuleOf("sourcingPayables:markPaid")).toBe("convex/sourcingPayables.ts");
  });

  test("a functionId that is not module:function has no module (and so is never renewed)", () => {
    expect(backendModuleOf("nonsense")).toBeUndefined();
    expect(backendModuleOf("../etc:passwd")).toBeUndefined();
  });

  test("paths named in a rationale are extracted, prose is not", () => {
    expect(rationalePaths("see convex/utils/money.ts and lib/x.test.tsx (also scripts/a.mjs). Plain words.")).toEqual([
      "convex/utils/money.ts",
      "lib/x.test.tsx",
      "scripts/a.mjs",
    ]);
  });
});

describe("renewBaseline", () => {
  test("renews an entry whose client file and backend module are unchanged", () => {
    const e = entry();
    const result = renewBaseline(serialize([e]), opts(allIdentical));
    expect(result.renewed).toBe(1);
    expect(result.refused).toEqual([]);
    // Key order is preserved: `renewal` is appended after `expires`.
    expect(JSON.parse(result.text).entries[0]).toEqual({ ...e, expires: RENEWED_EXPIRES, renewal: RENEWAL });
    expect(Object.keys(JSON.parse(result.text).entries[0]).slice(-2)).toEqual(["expires", "renewal"]);
    expect(result.text).toBe(serialize([{ ...e, expires: RENEWED_EXPIRES, renewal: RENEWAL }]));
  });

  test("REFUSES an entry whose client file changed since the reviewed revision", () => {
    const e = entry();
    const text = serialize([e]);
    const result = renewBaseline(text, opts(changedOnly("app/page.tsx")));
    expect(result.renewed).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].reason).toMatch(/client file app\/page\.tsx changed/);
    expect(result.text).toBe(text);
  });

  test("REFUSES an entry whose backend module changed since the reviewed revision", () => {
    const text = serialize([entry()]);
    const result = renewBaseline(text, opts(changedOnly("convex/vehicles.ts")));
    expect(result.renewed).toBe(0);
    expect(result.refused[0].reason).toMatch(/backend module convex\/vehicles\.ts changed/);
    expect(result.text).toBe(text);
  });

  test("REFUSES an entry whose client file or backend module cannot be compared (missing at either revision)", () => {
    const missing: Compare = (file) => (file === "convex/vehicles.ts" ? "missing" : "identical");
    const result = renewBaseline(serialize([entry()]), opts(missing));
    expect(result.renewed).toBe(0);
    expect(result.refused[0].reason).toMatch(/backend module convex\/vehicles\.ts is missing/);
  });

  test("REFUSES an entry whose functionId names no backend module", () => {
    const result = renewBaseline(serialize([entry({ functionId: "weird" })]), opts(allIdentical));
    expect(result.renewed).toBe(0);
    expect(result.refused[0].reason).toMatch(/no backend module/);
  });

  test("a file named in the rationale must be unchanged too", () => {
    const e = entry({ rationale: "Relies on lib/money.ts rounding." });
    const text = serialize([e]);
    expect(renewBaseline(text, opts(allIdentical)).renewed).toBe(1);
    const refused = renewBaseline(text, opts(changedOnly("lib/money.ts")));
    expect(refused.renewed).toBe(0);
    expect(refused.refused[0].reason).toMatch(/rationale file lib\/money\.ts changed/);
  });

  // SCRUM-866 round 3: the review also depended on what the two files IMPORT, not only on the files.
  test("REFUSES an entry whose client file imports a changed helper", () => {
    const closure: Closure = (file) => ({ files: file === "app/page.tsx" ? [file, "lib/helper.ts"] : [file], unresolved: [] });
    const text = serialize([entry()]);
    const result = renewBaseline(text, opts(changedOnly("lib/helper.ts"), closure));
    expect(result.renewed).toBe(0);
    expect(result.refused[0].reason).toMatch(/client file app\/page\.tsx imports lib\/helper\.ts, which changed/);
    expect(result.text).toBe(text);
    expect(renewBaseline(text, opts(allIdentical, closure)).renewed).toBe(1);
  });

  test("REFUSES an entry whose backend module imports a changed helper", () => {
    const closure: Closure = (file) => ({ files: file === "convex/vehicles.ts" ? [file, "convex/utils/money.ts"] : [file], unresolved: [] });
    const result = renewBaseline(serialize([entry()]), opts(changedOnly("convex/utils/money.ts"), closure));
    expect(result.renewed).toBe(0);
    expect(result.refused[0].reason).toMatch(/backend module convex\/vehicles\.ts imports convex\/utils\/money\.ts, which changed/);
  });

  test("REFUSES when an imported file is missing at either revision or an in-repo import cannot be resolved", () => {
    const missing: Compare = (file) => (file === "lib/new.ts" ? "missing" : "identical");
    const added: Closure = (file) => ({ files: [file, "lib/new.ts"], unresolved: [] });
    expect(renewBaseline(serialize([entry()]), opts(missing, added)).refused[0].reason).toMatch(/imports lib\/new\.ts, which is missing/);
    const unresolved: Closure = (file) => ({ files: [file], unresolved: ["./gone"] });
    expect(renewBaseline(serialize([entry()]), opts(allIdentical, unresolved)).refused[0].reason).toMatch(/cannot resolve .*\.\/gone/);
  });

  test("a renewal without an import-closure resolver is refused outright", () => {
    expect(() => renewBaseline(serialize([entry()]), { compare: allIdentical, expires: RENEWED_EXPIRES, renewal: RENEWAL } as never)).toThrow(/closureOf/);
  });

  test("renews some and leaves the rest byte-identical", () => {
    const keep = entry({ callSiteId: "a:1:1", file: "app/a.tsx" });
    const drop = entry({ callSiteId: "b:1:1", file: "app/b.tsx" });
    const result = renewBaseline(serialize([keep, drop]), opts(changedOnly("app/b.tsx")));
    expect(result.renewed).toBe(1);
    expect(result.refused.map((r: { index: number }) => r.index)).toEqual([1]);
    expect(JSON.parse(result.text).entries[1]).toEqual(drop);
    expect(JSON.parse(result.text).entries[0].expires).toBe(RENEWED_EXPIRES);
  });

  test("does not renew twice, and never shortens a later expiry", () => {
    const already = entry({ expires: RENEWED_EXPIRES, renewal: RENEWAL });
    const later = entry({ callSiteId: "x:1:1", expires: "2027-01-01" });
    const text = serialize([already, later]);
    const result = renewBaseline(text, opts(allIdentical));
    expect(result.renewed).toBe(0);
    expect(result.text).toBe(text);
  });

  test("preserves CRLF line endings", () => {
    const e = entry();
    const result = renewBaseline(serialize([e], "\r\n"), opts(allIdentical));
    expect(result.text).toBe(serialize([{ ...e, expires: RENEWED_EXPIRES, renewal: RENEWAL }], "\r\n"));
  });

  test("refuses a file that is not in the canonical 2-space JSON format (a rewrite would reformat it)", () => {
    expect(() => renewBaseline('{"version":1,"entries":[]}', opts(allIdentical))).toThrow(/canonical/);
  });

  test("refuses an invalid target date or an empty reason", () => {
    expect(() => renewBaseline(serialize([entry()]), { ...opts(allIdentical), expires: "soon" })).toThrow(/YYYY-MM-DD/);
    expect(() => renewBaseline(serialize([entry()]), { ...opts(allIdentical), renewal: " " })).toThrow(/renewal/);
  });
});

describe("createImportClosure + gitCompare (real TypeScript, real git)", () => {
  const git = resolveGit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-closure-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const run = (...args: string[]) =>
    execFileSync(String(git), ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  const tracked = [
    "tsconfig.json", "app/page.tsx", "app/other.tsx", "app/broken.tsx", "app/style.css", "lib/helper.ts", "lib/deep.ts",
    "convex/vehicles.ts", "convex/orgs.ts", "convex/_generated/api.ts",
  ];
  let reviewed = "";

  test("builds the closure through paths aliases, css, re-exports and cycles; skips node_modules and convex/_generated", () => {
    expect(git, "git must be locatable; cannot-run is a failure, not a skip").toBeTruthy();
    write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", target: "esnext", jsx: "react-jsx", types: [], baseUrl: ".", paths: { "@/*": ["./*"] } } }));
    write("node_modules/pkg/index.d.ts", "declare const p: number; export default p;");
    write("node_modules/pkg/package.json", JSON.stringify({ name: "pkg", types: "index.d.ts" }));
    write("convex/_generated/api.ts", "export const api = 1;");
    write("app/style.css", "a{}");
    write("lib/deep.ts", "import { h } from './helper'; export const deep = 1; export const back = h;");
    write("lib/helper.ts", "import { deep } from './deep'; export const h = deep; export * from '../lib/deep';");
    write("app/page.tsx", 'import { h } from "@/lib/helper"; import "./style.css"; import p from "pkg"; import { api } from "../convex/_generated/api"; export const v = [h, p, api];');
    write("app/other.tsx", "export const o = 1;");
    write("app/broken.tsx", 'import "./missing-module"; export const b = 1;');
    write("convex/vehicles.ts", "export const update = 1;");
    write("convex/orgs.ts", "import { api } from './_generated/api'; export const get = api;");
    run("init", "-q");
    run("add", "--", ...tracked);
    run("commit", "-q", "-m", "reviewed");
    reviewed = run("rev-parse", "HEAD");

    const closureOf = createImportClosure({
      root: dir,
      projects: [
        { tsconfig: "tsconfig.json", rootFiles: ["app/page.tsx", "app/other.tsx", "app/broken.tsx"] },
        { tsconfig: "tsconfig.json", rootFiles: ["convex/vehicles.ts", "convex/orgs.ts"] },
      ],
    });
    expect(closureOf("app/page.tsx")).toEqual({
      files: ["app/page.tsx", "app/style.css", "lib/deep.ts", "lib/helper.ts"],
      unresolved: [],
    });
    expect(closureOf("convex/orgs.ts").files).toEqual(["convex/orgs.ts"]);
    expect(closureOf("app/broken.tsx").unresolved).toEqual(["./missing-module"]);
    expect(() => closureOf("app/not-a-root.tsx")).toThrow(/not a root/);
  });

  test("an entry whose client imports a changed helper is refused end to end; an unaffected one renews", () => {
    write("lib/deep.ts", "import { h } from './helper'; export const deep = 2; export const back = h;");
    run("add", "--", "lib/deep.ts");
    run("commit", "-q", "-m", "helper changed");
    const closureOf = createImportClosure({
      root: dir,
      projects: [
        { tsconfig: "tsconfig.json", rootFiles: ["app/page.tsx", "app/other.tsx"] },
        { tsconfig: "tsconfig.json", rootFiles: ["convex/vehicles.ts"] },
      ],
    });
    const compare = gitCompare({ git: String(git), cwd: dir, reviewed, head: "HEAD" });
    const affected = entry({ file: "app/page.tsx", callSiteId: "app/page.tsx:1:1" });
    const unaffected = entry({ file: "app/other.tsx", callSiteId: "app/other.tsx:1:1" });
    const result = renewBaseline(serialize([affected, unaffected]), { compare, closureOf, expires: RENEWED_EXPIRES, renewal: RENEWAL });
    expect(result.renewed).toBe(1);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].index).toBe(0);
    expect(result.refused[0].reason).toMatch(/client file app\/page\.tsx imports lib\/deep\.ts, which changed/);
  });
});

describe("gitCompare (real git)", () => {
  const git = resolveGit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-renew-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    execFileSync(String(git), ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

  test("classifies identical, changed and missing files between two revisions", () => {
    expect(git, "git must be locatable; cannot-run is a failure, not a skip").toBeTruthy();
    run("init", "-q");
    fs.mkdirSync(path.join(dir, "app", "(d)", "[orgId]"), { recursive: true });
    fs.writeFileSync(path.join(dir, "app", "(d)", "[orgId]", "same.tsx"), "same");
    fs.writeFileSync(path.join(dir, "app", "(d)", "[orgId]", "edited.tsx"), "v1");
    fs.writeFileSync(path.join(dir, "gone.ts"), "x");
    run("add", ".");
    run("commit", "-q", "-m", "reviewed");
    const reviewed = run("rev-parse", "HEAD");
    fs.writeFileSync(path.join(dir, "app", "(d)", "[orgId]", "edited.tsx"), "v2");
    fs.writeFileSync(path.join(dir, "added.ts"), "y");
    fs.rmSync(path.join(dir, "gone.ts"));
    run("add", "-A");
    run("commit", "-q", "-m", "later");
    const compare = gitCompare({ git: String(git), cwd: dir, reviewed, head: "HEAD" });
    expect(compare("app/(d)/[orgId]/same.tsx")).toBe("identical");
    expect(compare("app/(d)/[orgId]/edited.tsx")).toBe("changed");
    expect(compare("gone.ts")).toBe("missing");
    expect(compare("added.ts")).toBe("missing");
    expect(compare("never/existed.ts")).toBe("missing");
  });
});
