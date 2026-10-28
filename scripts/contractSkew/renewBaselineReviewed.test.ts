import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { resolveGit } from "./gitExecutable.mjs";
import { createImportClosure } from "./importClosure.mjs";
import {
  backendModuleOf,
  gitCompare,
  rationalePaths,
  renewBaseline,
  renewalEvidenceGaps,
} from "./renewBaselineReviewed.mjs";

type Compare = (file: string) => "identical" | "changed" | "missing";

const RENEWED_EXPIRES = "2026-12-01";
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

describe("member loader renewal refuses a changed worker (SCRUM-866 round 6)", () => {
  const git = resolveGit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-member-loader-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (file: string, source: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), source);
  };
  const run = (...args: string[]) =>
    execFileSync(String(git), ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  const forms: Array<[string, string]> = [
    ["call", 'module.exports = module.require.call(module, "./worker.js");'],
    ["apply", 'module.exports = module.require.apply(module, ["./worker.js"]);'],
    ["bind", 'module.exports = module.require.bind(module)("./worker.js");'],
    ["element_call", 'module.exports = module["require"]["call"](module, "./worker.js");'],
    ["extracted", 'const load = module.require; module.exports = load("./worker.js");'],
    ["computed", 'const k = "require"; module.exports = module[k]("./worker.js");'],
    ["destructured_computed_literal", 'const { ["require"]: load } = module; module.exports = load("./worker.js");'],
    ["destructured_computed_key", 'const k = "require"; const { [k]: load } = module; module.exports = load("./worker.js");'],
    ["destructured_string", 'const { "require": load } = module; module.exports = load("./worker.js");'],
    ["reflect", 'module.exports = Reflect.get(module, "require")("./worker.js");'],
    ["constructor", 'module.exports = module.constructor._load("./worker.js");'],
    ["aliased_module", 'const k = "require"; const m = module; module.exports = m[k]("./worker.js");'],
    ["global_key", 'const k = "require"; global[k]("./worker.js");'],
    ["ambient_constructor", 'declare const module: any; module.exports = module.constructor._load("./worker.js");'],
    ["ambient_aliased_module", 'declare var module: any; const m = module; const k = "require"; module.exports = m[k]("./worker.js");'],
    ["ambient_global_key", 'declare let global: any; const k = "require"; global[k]("./worker.js");'],
    ...["module", "global", "globalThis", "Reflect"].flatMap((name): Array<[string, string]> => [
      ...["const", "let", "var"].map((kind): [string, string] => [
        `ambient_${kind}_${name}`,
        `declare ${kind} ${name}: any; const { ["require"]: load } = ${name}; ${name === "module" ? "module.exports = " : ""}load("./worker.js");`,
      ]),
      [`ambient_function_${name}`, `declare function ${name}(): void; const loader = ${name}; loader[k]("./worker.js");`],
      [`ambient_class_${name}`, `declare class ${name} {}; const loader = ${name}; loader[k]("./worker.js");`],
      [`ambient_enum_${name}`, `declare enum ${name} { Value }; const loader = ${name}; loader[k]("./worker.js");`],
      [`ambient_namespace_${name}`, `declare namespace ${name} { const value: unknown; } const loader = ${name}; loader[k]("./worker.js");`],
      [`ambient_module_${name}`, `declare module ${name} { const value: unknown; } const loader = ${name}; loader[k]("./worker.js");`],
      [`ambient_context_${name}`, `declare namespace Ambient { const ${name}: any; const loader = ${name}; loader[k]("./worker.js"); }`],
      [`ambient_global_context_${name}`, `declare global { const ${name}: any; const loader = ${name}; loader[k]("./worker.js"); }`],
      [`type_import_${name}`, `import type ${name} from "pkg"; const loader = ${name}; loader[k]("./worker.js");`],
      [`type_specifier_${name}`, `import { type Value as ${name} } from "pkg"; const loader = ${name}; loader[k]("./worker.js");`],
      [`type_namespace_import_${name}`, `import type * as ${name} from "pkg"; const loader = ${name}; loader[k]("./worker.js");`],
      [`type_import_equals_${name}`, `import type ${name} = require("pkg"); const loader = ${name}; loader[k]("./worker.js");`],
      [`const_enum_${name}`, `const enum ${name} { Value }; const loader = ${name}; loader[k]("./worker.js");`],
    ]),
  ];
  let reviewed = "";
  let compare: Compare;
  let closureOf: Closure;

  test("setup: commit each loader, then change only its worker", () => {
    expect(git, "git must be locatable; cannot-run is a failure, not a skip").toBeTruthy();
    write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", target: "esnext", types: [] } }));
    write("package.json", '{"name":"member-loader-fixture","type":"commonjs"}');
    write("app/page.tsx", "export const page = 1;");
    write("convex/worker.js", "module.exports = { run: 1 };");
    for (const [name, source] of forms) write(`convex/${name}.ts`, source);
    run("init", "-q");
    run("add", "--", "."); // only this isolated temporary repository
    run("commit", "-q", "-m", "reviewed loaders and worker");
    reviewed = run("rev-parse", "HEAD");
    write("convex/worker.js", "module.exports = { run: 2 };");
    run("add", "--", "convex/worker.js");
    run("commit", "-q", "-m", "worker changed after review");
    compare = gitCompare({ git: String(git), cwd: dir, reviewed, head: "HEAD" });
    closureOf = createImportClosure({
      root: dir,
      projects: [{ tsconfig: "tsconfig.json", rootFiles: ["app/page.tsx", ...forms.map(([name]) => `convex/${name}.ts`)] }],
    });
    expect(compare("convex/worker.js")).toBe("changed");
    // Execute the reported reproduction with Node's actual CommonJS loader.
    const loaded = execFileSync(process.execPath, ["-p", 'JSON.stringify(require("./convex/call.ts"))'], { cwd: dir, encoding: "utf8" });
    expect(JSON.parse(loaded)).toEqual({ run: 2 });
    // Extracting module.require loses its module receiver; Node resolves this
    // relative request from cwd. Run beside the worker to exercise the load.
    const loadedAmbient = execFileSync(process.execPath, ["-p", 'JSON.stringify(require("./ambient_const_module.ts"))'], { cwd: path.join(dir, "convex"), encoding: "utf8" });
    expect(JSON.parse(loadedAmbient)).toEqual({ run: 2 });
  });

  test.each([
    ["unrelated object's property", "declare const obj: any; export const load = obj.require;", /member named require/],
    ["passed property", "declare const module: any; declare function take(x: unknown): void; take(module.require);", /member named require/],
    ["wrapped literal element", 'declare const obj: any; export const load = obj[("require" as string)];', /member named require/],
    ["template literal element", 'declare const obj: any; export const load = obj[`require`];', /member named require/],
    ["computed globalThis", "declare const k: string; export const load = (globalThis as any)[k];", /computed member of globalThis/],
    ["computed require", "declare const require: any; declare const k: string; export const load = require[k];", /computed member of require/],
    ["computed wrapped module", "declare const module: any; declare const k: string; export const load = (module as any)[(k)];", /computed member of module/],
  ] as const)("refuses a loader access in any position: %s", (_name, source, reason) => {
    write("convex/access.ts", source);
    const closure = createImportClosure({ root: dir, projects: [{ tsconfig: "tsconfig.json", rootFiles: ["convex/access.ts"] }] });
    expect(closure("convex/access.ts").unresolved).toEqual(expect.arrayContaining([expect.stringMatching(reason)]));
  });

  test("CONTROL: direct require traces the worker, and inert uses and unrelated computed keys stay accepted", () => {
    write("convex/direct.ts", 'const worker = require("./worker.js");');
    write("convex/inert.ts", 'declare const obj: any; declare const k: string; require.resolve("./worker.js"); typeof require; module.exports = {}; globalThis.crypto.randomUUID(); obj[k];');
    const closure = createImportClosure({ root: dir, projects: [{ tsconfig: "tsconfig.json", rootFiles: ["convex/direct.ts", "convex/inert.ts"] }] });
    expect(closure("convex/direct.ts")).toEqual({ files: expect.arrayContaining(["convex/worker.js"]), unresolved: [] });
    expect(closure("convex/inert.ts").unresolved).toEqual([]);
  });

  test("CONTROL: locally bound names and CommonJS module.exports remain accepted", () => {
    write("convex/local.ts", 'const module = { value: 1 }; const global = { value: 2 }; const Reflect = { value: 3 }; const globalThis = { value: 4 }; export const n = module.value + global.value + Reflect.value + globalThis.value;');
    const closure = createImportClosure({ root: dir, projects: [{ tsconfig: "tsconfig.json", rootFiles: ["convex/local.ts"] }] });
    expect(closure("convex/local.ts").unresolved).toEqual([]);
  });

  test.each(forms)("refuses renewal through %s", (name) => {
    const file = `convex/${name}.ts`;
    expect(compare(file)).toBe("identical");
    const text = serialize([entry({ functionId: `${name}:update` })]);
    const result = renewBaseline(text, opts(compare, closureOf));
    expect(result.renewed).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].reason).toMatch(/cannot resolve .*cannot be traced/);
    expect(closureOf(file).unresolved.length).toBeGreaterThan(0);
    expect(result.text).toBe(text);
  });
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
  test("renewal evidence names every changed closure file by full path", () => {
    const e = entry({ renewal: "SCRUM-866 round 7 review against origin/main 549267ae: Reviewed convex/a.ts; a same-basename elsewhere is not evidence." });
    const closure: Closure = (file) => ({ files: [file, "convex/a.ts", "lib/a.ts"], unresolved: [] });
    const stale = renewalEvidenceGaps(serialize([e]), { reviewedText: serialize([entry()]), compare: changedOnly("convex/a.ts", "lib/a.ts"), closureOf: closure, evidenceChanged: () => "identical" });
    expect(stale).toHaveLength(1);
    expect(stale[0].missing).toEqual(["lib/a.ts"]);
    expect(renewalEvidenceGaps(serialize([{ ...e, renewal: "SCRUM-866 round 7 review against origin/main 549267ae: Reviewed convex/a.ts and lib/a.ts." }]), {
      reviewedText: serialize([entry()]), compare: changedOnly("convex/a.ts", "lib/a.ts"), closureOf: closure, evidenceChanged: () => "identical",
    })).toEqual([]);
  });
  test("a file changed again after the named review SHA is stale even when its path is present", () => {
    const e = entry({ renewal: "SCRUM-866 round 7 review against origin/main 549267ae: convex/a.ts was reviewed." });
    const gaps = renewalEvidenceGaps(serialize([e]), {
      reviewedText: serialize([entry()]),
      compare: changedOnly("convex/a.ts"),
      closureOf: (file) => ({ files: [file, "convex/a.ts"], unresolved: [] }),
      evidenceChanged: (_sha, file) => file === "convex/a.ts" ? "changed" : "identical",
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].changedSinceEvidence).toEqual(["convex/a.ts"]);
  });
  test.each([{}, 42, "", "   ", null])("rejects malformed renewal evidence %j even with unchanged expiry", (renewal) => {
    expect(renewalEvidenceGaps(serialize([entry({ renewal })]), {
      reviewedText: serialize([entry()]), compare: allIdentical, closureOf: selfOnly, evidenceChanged: allIdentical,
    })).toHaveLength(1);
  });
  test("an expiry change requires evidence even when the renewal field was deleted", () => {
    expect(renewalEvidenceGaps(serialize([entry({ expires: RENEWED_EXPIRES })]), {
      reviewedText: serialize([entry()]), compare: allIdentical, closureOf: selfOnly, evidenceChanged: allIdentical,
    })).toHaveLength(1);
  });
  test("matches reviewed entries by full identity, independently of array order", () => {
    const other = entry({ contractPath: "price", expires: RENEWED_EXPIRES });
    const current = serialize([other, entry()]);
    expect(renewalEvidenceGaps(current, {
      reviewedText: serialize([entry(), other]), compare: allIdentical, closureOf: selfOnly, evidenceChanged: allIdentical,
    })).toEqual([]);
    const gaps = renewalEvidenceGaps(current, {
      reviewedText: serialize([entry(), { ...other, expires: "2026-11-01" }]),
      compare: allIdentical, closureOf: selfOnly, evidenceChanged: allIdentical,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0].index).toBe(0);
  });
  test("a new identity needs evidence; valid evidence satisfies an extended expiry", () => {
    const options = { reviewedText: serialize([entry()]), compare: allIdentical, closureOf: selfOnly, evidenceChanged: allIdentical };
    expect(renewalEvidenceGaps(serialize([entry({ contractPath: "price" })]), options)).toHaveLength(1);
    expect(renewalEvidenceGaps(serialize([entry({ expires: RENEWED_EXPIRES,
      renewal: "SCRUM-866 round 8 review against origin/main 99b175f7: reviewed source.",
    })]), options)).toEqual([]);
  });
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
    write("app/page.tsx", 'import { h } from "@/lib/helper"; import "./style.css"; import p from "pkg"; import { components } from "../convex/_generated/api"; export const v = [h, p, components];');
    write("app/other.tsx", "export const o = 1;");
    write("app/broken.tsx", 'import "./missing-module"; export const b = 1;');
    write("convex/vehicles.ts", "export const update = 1;");
    write("convex/orgs.ts", "import { components } from './_generated/api'; export const get = components;");
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
      files: ["app/page.tsx", "app/style.css", "lib/deep.ts", "lib/helper.ts", "tsconfig.json"],
      unresolved: [],
    });
    expect(closureOf("convex/orgs.ts").files).toEqual(["convex/orgs.ts", "tsconfig.json"]);
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

describe("renewal evidence CLI missing history (SCRUM-866 round 8)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-evidence-history-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missingSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  test.each(["reviewed revision", "recorded evidence revision"])("refuses unavailable %s with a history diagnostic", (role) => {
    const baseline = path.join(dir, "baseline.json");
    const document = JSON.parse(fs.readFileSync("scripts/contractSkew/needs-evidence-baseline.json", "utf8"));
    const recorded = document.entries[480];
    recorded.renewal = `SCRUM-866 round 8 review against origin/main ${missingSha}: source reviewed.`;
    fs.writeFileSync(baseline, serialize([recorded]));
    const result = spawnSync(process.execPath, ["scripts/contractSkew/renewBaselineReviewed.mjs", "--reviewed",
      role === "reviewed revision" ? missingSha : "c82890bd", "--check-evidence", "--baseline", baseline], {
      encoding: "utf8", timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`${role} ${missingSha} is unavailable`);
    expect(result.stderr).toContain("fetch full Git history");
    expect(result.stdout).not.toContain("entries checked");
    expect(fs.readFileSync(baseline, "utf8")).toBe(serialize([recorded]));
  }, 25_000);
});

// SCRUM-866 round 5: what the compiler used to resolve imports, and the Convex function references that reach
// other backend modules only through convex/_generated/api, were outside the closure.
describe("closure also covers resolution inputs and Convex function references", () => {
  const git = resolveGit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-closure2-"));
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
  const tsconfig = (paths: string) =>
    JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", target: "esnext", types: [], baseUrl: ".", paths: { "@/*": [paths] } } });
  const closureFor = (rootFiles: string[], implicitInputs: string[] = []) =>
    createImportClosure({ root: dir, projects: [{ tsconfig: "tsconfig.json", rootFiles }], implicitInputs });
  const renewal = (closureOf: ReturnType<typeof closureFor>, file: string, functionId: string, reviewed: string) =>
    renewBaseline(serialize([entry({ file, callSiteId: `${file}:1:1`, functionId })]), {
      compare: gitCompare({ git: String(git), cwd: dir, reviewed, head: "HEAD" }),
      closureOf,
      expires: RENEWED_EXPIRES,
      renewal: RENEWAL,
    });
  let reviewed = "";

  test("setup: reviewed revision", () => {
    expect(git, "git must be locatable; cannot-run is a failure, not a skip").toBeTruthy();
    write("tsconfig.json", tsconfig("./*"));
    write("package.json", '{"name":"fx"}');
    write("lib/helper.ts", "export const h = 1;");
    write("alt/lib/helper.ts", "export const h = 2;");
    write("app/page.tsx", 'import { h } from "@/lib/helper"; export const v = h;');
    write("convex/_generated/api.ts", "export const api: any = 1; export const internal: any = 2; export const components: any = 3;");
    write("convex/schema.ts", "export default 1;");
    write("convex/worker.ts", "export const run = 1;");
    write("convex/lone.ts", "export const only = 1;");
    write("convex/messages/access.ts", "export const h = 1;");
    write(
      "convex/vehicles.ts",
      'import { internal } from "./_generated/api"; export const update = async (ctx: any) => ctx.runMutation(internal.worker.run, {});'
    );
    write("convex/nested.ts", 'import { api } from "./_generated/api"; export const n = () => api.messages.access.h;');
    write("convex/ghost.ts", 'import { internal } from "./_generated/api"; export const g = () => internal.nowhere.fn;');
    write("convex/bare.ts", 'import { internal } from "./_generated/api"; export const b = internal;');
    write("convex/dyn.ts", 'import { api } from "./_generated/api"; export const d = (k: string) => api[k];');
    write("convex/ns.ts", 'import * as gen from "./_generated/api"; export const n = gen;');
    write("convex/plain.ts", "export const p = 1;");
    run("init", "-q");
    run("add", "--", "."); // an isolated temp repository, so the pathspec stays inside it
    run("commit", "-q", "-m", "reviewed");
    reviewed = run("rev-parse", "HEAD");
  });

  test("the tsconfig, package.json and the declared implicit inputs are part of every closure", () => {
    const files = closureFor(["app/page.tsx"], ["package.json", "pnpm-lock.yaml", "convex/schema.ts"])("app/page.tsx").files;
    expect(files).toEqual(expect.arrayContaining(["tsconfig.json", "package.json", "pnpm-lock.yaml", "convex/schema.ts", "lib/helper.ts"]));
  });

  test("a function reference makes the referenced backend module part of the closure (nested directories too)", () => {
    expect(closureFor(["convex/vehicles.ts"])("convex/vehicles.ts").files).toContain("convex/worker.ts");
    expect(closureFor(["convex/nested.ts"])("convex/nested.ts").files).toContain("convex/messages/access.ts");
  });

  test("a function reference that names no backend module, a bare api/internal, a dynamic key and a namespace import are unresolved", () => {
    expect(closureFor(["convex/ghost.ts"])("convex/ghost.ts").unresolved).toEqual([expect.stringMatching(/internal\.nowhere\.fn/)]);
    expect(closureFor(["convex/bare.ts"])("convex/bare.ts").unresolved).toEqual([expect.stringMatching(/internal/)]);
    expect(closureFor(["convex/dyn.ts"])("convex/dyn.ts").unresolved).toEqual([expect.stringMatching(/api/)]);
    expect(closureFor(["convex/ns.ts"])("convex/ns.ts").unresolved).toEqual([expect.stringMatching(/_generated\/api/)]);
  });

  test("CONTROL: a backend calling internal.worker.run is refused when the worker changed", () => {
    write("convex/worker.ts", "export const run = 2;");
    run("add", "--", "convex/worker.ts");
    run("commit", "-q", "-m", "worker changed");
    const result = renewal(closureFor(["app/page.tsx", "convex/vehicles.ts", "convex/plain.ts"]), "app/page.tsx", "vehicles:update", reviewed);
    expect(result.renewed).toBe(0);
    expect(result.refused[0].reason).toMatch(/backend module convex\/vehicles\.ts imports convex\/worker\.ts, which changed/);
  });

  test("CONTROL: a tsconfig paths change that redirects an import refuses the renewal", () => {
    write("tsconfig.json", tsconfig("./alt/*"));
    run("add", "--", "tsconfig.json");
    run("commit", "-q", "-m", "paths redirect");
    const result = renewal(closureFor(["app/page.tsx"]), "app/page.tsx", "plain:p", reviewed);
    expect(result.renewed).toBe(0);
    expect(result.refused[0].reason).toMatch(/imports tsconfig\.json, which changed/);
  });

  test("an unresolvable function reference refuses mechanical renewal", () => {
    // Compared against the current HEAD, so nothing else is "changed" and only the unresolvable reference can refuse.
    const result = renewal(closureFor(["app/page.tsx", "convex/ghost.ts"]), "app/page.tsx", "ghost:g", run("rev-parse", "HEAD"));
    expect(result.renewed).toBe(0);
    expect(result.refused[0].reason).toMatch(/cannot resolve .*internal\.nowhere\.fn/);
  });

  test("a mobile-style makeFunctionReference string names its backend module", () => {
    write(
      "app/mobile.ts",
      'import { makeFunctionReference } from "convex/server"; export const r = makeFunctionReference<"query">("lone:only"); export const d = makeFunctionReference<"query">("messages/access:h");'
    );
    const files = closureFor(["app/mobile.ts"])("app/mobile.ts").files;
    expect(files).toEqual(expect.arrayContaining(["convex/lone.ts", "convex/messages/access.ts"]));
    write("app/mobile2.ts", 'import { makeFunctionReference } from "convex/server"; declare const n: string; export const r = makeFunctionReference<"query">(n);');
    expect(closureFor(["app/mobile2.ts"])("app/mobile2.ts").unresolved).toEqual([expect.stringMatching(/makeFunctionReference/)]);
  });
});

// SCRUM-866 round 3 (seat findings at 873309fb): implicit inputs were not traversed, `_generated/api` and
// `convex/server` were recognised by specifier text, and a function reference resolved to any existing prefix.
describe("closure ownership is decided by the resolved module, and a function reference names its exact module", () => {
  const git = resolveGit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-closure3-"));
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
  const SERVER_FILE = "node_modules/convex/dist/esm-types/server/index.d.ts";
  const closureFor = (rootFiles: string[], implicitInputs: string[] = []) =>
    createImportClosure({ root: dir, projects: [{ tsconfig: "tsconfig.json", rootFiles }], implicitInputs });
  const closureOfFile = (file: string, implicitInputs: string[] = []) => closureFor([file], implicitInputs)(file);
  const renewal = (closureOf: ReturnType<typeof closureFor>, reviewed: string) =>
    renewBaseline(serialize([entry({ file: "app/page.tsx", callSiteId: "app/page.tsx:1:1", functionId: "vehicles:update" })]), {
      compare: gitCompare({ git: String(git), cwd: dir, reviewed, head: "HEAD" }),
      closureOf,
      expires: RENEWED_EXPIRES,
      renewal: RENEWAL,
    });
  let reviewed = "";

  test("setup: reviewed revision", () => {
    expect(git, "git must be locatable; cannot-run is a failure, not a skip").toBeTruthy();
    write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "esnext",
          moduleResolution: "bundler",
          target: "esnext",
          types: [],
          baseUrl: ".",
          paths: { "@/*": ["./*"], genapi: ["./convex/_generated/api"], srv: [`./${SERVER_FILE}`] },
        },
      })
    );
    write("package.json", '{"name":"fx"}');
    // A stand-in for the installed convex package, so "convex/server" resolves the way it does in the real tree.
    write("node_modules/convex/package.json", JSON.stringify({ name: "convex", exports: { "./server": { types: `./${"dist/esm-types/server/index.d.ts"}` } } }));
    write(SERVER_FILE, "export declare function makeFunctionReference<T extends string>(name: string): { t: T };\nexport declare const anyApi: any;\nexport declare const v: any;");
    write("convex/_generated/api.ts", "export const api: any = 1; export const internal: any = 2; export const components: any = 3;");
    write("convex/validators.ts", 'export const kinds = ["a"];');
    write("convex/schema.ts", 'import { kinds } from "./validators"; export default kinds;');
    write("convex/worker.ts", "export const run = 1;");
    write("convex/lone.ts", "export const only = 1;");
    write("convex/idx/index.ts", "export const fn = 1;");
    write("convex/vehicles.ts", "export const update = 1;");
    write("app/page.tsx", "export const v = 1;");
    write("convex/viaJs.ts", 'import { internal } from "./_generated/api.js"; export const f = () => internal.worker.run;');
    write("convex/viaAlias.ts", 'import { internal } from "genapi"; export const f = () => internal.worker.run;');
    write("convex/nsLiteral.ts", 'import * as cv from "convex/server"; export const r = cv.makeFunctionReference<"query">("lone:only");');
    write("convex/nsAlias.ts", 'import * as cv from "srv"; export const r = cv.makeFunctionReference<"query">("lone:only");');
    write("convex/nsDynamic.ts", 'import * as cv from "convex/server"; declare const n: string; export const r = cv.makeFunctionReference<"query">(n);');
    write("convex/nsBare.ts", 'import * as cv from "convex/server"; export const x = cv;');
    write("convex/nsAny.ts", 'import * as cv from "convex/server"; export const x = cv.anyApi;');
    write("convex/nsDestructure.ts", 'import * as cv from "convex/server"; export const { makeFunctionReference: m } = cv;');
    write("convex/nsInnocent.ts", 'import * as cv from "convex/server"; export const x = cv.v;');
    write("convex/reexpNamed.ts", 'export { internal } from "./_generated/api";');
    write("convex/reexpStar.ts", 'export * from "./_generated/api.js";');
    write("convex/reexpLocal.ts", 'import { api } from "./_generated/api"; export { api };');
    write("convex/reexpMaker.ts", 'export { makeFunctionReference } from "convex/server";');
    write("convex/reexpHarmless.ts", 'export { v } from "convex/server";');
    write("convex/useReexp.ts", 'import { internal } from "./reexpNamed"; export const u = internal.worker.run;');
    write("convex/dynLoad.ts", 'export const l = () => import("convex/server");');
    write("convex/missing.ts", 'import { internal } from "./_generated/api"; export const m = internal.worker.missing.run;');
    write("convex/idxShort.ts", 'import { api } from "./_generated/api"; export const m = api.idx.fn;');
    write("convex/idxExact.ts", 'import { api } from "./_generated/api"; export const m = api.idx.index.fn;');
    write("convex/exact.ts", 'import { internal } from "./_generated/api"; export const m = internal.worker.run;');
    write("convex/moduleObject.ts", 'import { internal } from "./_generated/api"; export const m = internal.worker;');
    run("init", "-q");
    run("add", "--", "."); // an isolated temp repository, so the pathspec stays inside it
    run("commit", "-q", "-m", "reviewed");
    reviewed = run("rev-parse", "HEAD");
  });

  test("CONTROL: nothing changed, so a file whose closure now reaches the schema's imports still renews", () => {
    const result = renewal(closureFor(["app/page.tsx", "convex/vehicles.ts"], ["package.json", "convex/schema.ts"]), reviewed);
    expect(result.refused).toEqual([]);
    expect(result.renewed).toBe(1);
  });

  test("an implicit .ts input's own imports are part of every closure", () => {
    const files = closureOfFile("convex/vehicles.ts", ["package.json", "convex/schema.ts"]).files;
    expect(files).toEqual(expect.arrayContaining(["convex/schema.ts", "convex/validators.ts"]));
  });

  test("a function reference through ./_generated/api.js or a path alias is traced", () => {
    expect(closureOfFile("convex/viaJs.ts").files).toContain("convex/worker.ts");
    expect(closureOfFile("convex/viaAlias.ts").files).toContain("convex/worker.ts");
  });

  test("a namespace import of convex/server (by specifier or by alias) is traced to its literal makeFunctionReference", () => {
    expect(closureOfFile("convex/nsLiteral.ts").files).toContain("convex/lone.ts");
    expect(closureOfFile("convex/nsAlias.ts").files).toContain("convex/lone.ts");
    expect(closureOfFile("convex/nsLiteral.ts").unresolved).toEqual([]);
  });

  test("a namespace use that cannot be read statically refuses", () => {
    expect(closureOfFile("convex/nsDynamic.ts").unresolved).toEqual([expect.stringMatching(/makeFunctionReference with a non-literal name/)]);
    expect(closureOfFile("convex/nsBare.ts").unresolved).toEqual([expect.stringMatching(/namespace used without a static member/)]);
    expect(closureOfFile("convex/nsAny.ts").unresolved).toEqual([expect.stringMatching(/anyApi/)]);
    expect(closureOfFile("convex/nsDestructure.ts").unresolved).toEqual([expect.stringMatching(/namespace used without a static member/)]);
  });

  test("CONTROL: a namespace import used only for something unrelated to function references is not refused", () => {
    expect(closureOfFile("convex/nsInnocent.ts").unresolved).toEqual([]);
    expect(closureOfFile("convex/reexpHarmless.ts").unresolved).toEqual([]);
  });

  test("a re-export of api, internal or makeFunctionReference refuses, also for the file that imports the re-export", () => {
    expect(closureOfFile("convex/reexpNamed.ts").unresolved).toEqual([expect.stringMatching(/re-export from \.\/_generated\/api cannot be traced/)]);
    expect(closureOfFile("convex/reexpStar.ts").unresolved).toEqual([expect.stringMatching(/re-export from \.\/_generated\/api\.js cannot be traced/)]);
    expect(closureOfFile("convex/reexpLocal.ts").unresolved).toEqual([expect.stringMatching(/re-export of api cannot be traced/)]);
    expect(closureOfFile("convex/reexpMaker.ts").unresolved).toEqual([expect.stringMatching(/re-export from convex\/server cannot be traced/)]);
    expect(closureOfFile("convex/useReexp.ts").unresolved).toEqual([expect.stringMatching(/re-export from \.\/_generated\/api cannot be traced/)]);
  });

  test("a dynamic load of convex/server refuses", () => {
    expect(closureOfFile("convex/dynLoad.ts").unresolved).toEqual([expect.stringMatching(/dynamic load of convex\/server cannot be traced/)]);
  });

  test("CONTROL: internal.worker.run names convex/worker.ts exactly", () => {
    expect(closureOfFile("convex/exact.ts")).toEqual({ files: expect.arrayContaining(["convex/worker.ts"]), unresolved: [] });
  });

  test("a function reference resolves its exact module, never a shorter prefix that happens to exist", () => {
    const missing = closureOfFile("convex/missing.ts");
    expect(missing.files).not.toContain("convex/worker.ts");
    expect(missing.unresolved).toEqual([expect.stringMatching(/internal\.worker\.missing\.run \(names no module/)]);
  });

  test("index is not special: api.idx.fn names no module, api.idx.index.fn names convex/idx/index.ts", () => {
    expect(closureOfFile("convex/idxShort.ts").unresolved).toEqual([expect.stringMatching(/api\.idx\.fn \(names no module/)]);
    expect(closureOfFile("convex/idxExact.ts")).toEqual({ files: expect.arrayContaining(["convex/idx/index.ts"]), unresolved: [] });
  });

  test("a module object used without a function name (api.worker, internal.worker) cannot be traced and refuses", () => {
    expect(closureOfFile("convex/moduleObject.ts").unresolved).toEqual([expect.stringMatching(/internal\.worker names no function/)]);
  });

  // SCRUM-866 round 4 (Seat 2, VERIFIED): a transparent wrapper or a computed specifier hid a load of convex/server
  // from the scan, so a changed worker module was not traced and the renewal was granted.
  const wrapped: Array<[string, string, RegExp]> = [
    ["parenthesized await import", 'export const f = async () => { const cv = await import(("convex/server")); return cv.makeFunctionReference("worker:run"); };', /dynamic load of convex\/server/],
    ["import with an as-assertion", 'export const f = async () => import("convex/server" as string);', /dynamic load of convex\/server/],
    ["import with satisfies", 'export const f = async () => import("convex/server" satisfies string);', /dynamic load of convex\/server/],
    ["import with a non-null assertion", 'export const f = async () => import("convex/server"!);', /dynamic load of convex\/server/],
    ["import with a type assertion", 'export const f = async () => import(<string>"convex/server");', /dynamic load of convex\/server/],
    ["parenthesized require", "declare const require: (s: string) => any;\nexport const f = () => require((\"convex/server\"));", /dynamic load of convex\/server/],
    ["concatenated import specifier", 'export const f = async () => import("convex/" + "server");', /computed import\(\) specifier/],
    ["concatenated require specifier", 'declare const require: (s: string) => any;\nexport const f = () => require("convex/" + "server");', /computed require\(\) specifier/],
    ["template with a substitution", "declare const n: string;\nexport const f = async () => import(`convex/${n}`);", /computed import\(\) specifier/],
    ["identifier specifier of an unrelated load", "declare const n: string;\nexport const f = async () => import(n);", /computed import\(\) specifier/],
    ["require aliased to a variable", 'declare const require: (s: string) => any;\nconst r = require;\nexport const f = r("convex/server");', /require used without a call/],
    ["import = require with a computed specifier", 'declare const m: string;\nimport cv = require(m);\nexport const x = cv;', /computed require\(\) specifier/],
    ["require.call", "declare const require: any;\ndeclare const n: string;\nexport const f = () => require.call(null, n);", /require used without a call/],
    ["require.apply", 'declare const require: any;\nexport const f = () => require.apply(null, ["./_generated/api"]);', /require used without a call/],
    ["require.bind then call", 'declare const require: any;\nexport const f = () => require.bind(null)("./_generated/api");', /require used without a call/],
    ["wrapped require.call", "declare const require: any;\nexport const f = () => (require as any).call(null, \"convex/server\");", /require used without a call/],
    ["require.resolve as a value", "declare const require: any;\nexport const f = require.resolve;", /require used without a call/],
    ["element access on require", 'declare const require: any;\nexport const f = () => require["call"](null, "convex/server");', /require used without a call/],
    ["module.require", 'declare const module: any;\nexport const f = () => module.require("convex/server");', /member named require/],
    ["globalThis.require behind as", 'export const f = () => (globalThis as any).require("convex/server");', /member named require/],
    ["element access named require", 'declare const x: any;\nexport const f = () => x["require"]("convex/server");', /member named require/],
    ["makeFunctionReference with a satisfies name", 'import { makeFunctionReference } from "convex/server"; export const r = makeFunctionReference<"query">("worker:run" satisfies string);', /^$/],
    ["makeFunctionReference with a concatenated name", 'import { makeFunctionReference } from "convex/server"; export const r = makeFunctionReference<"query">("wor" + "ker:run");', /makeFunctionReference with a non-literal name/],
    ["makeFunctionReference with a template substitution", 'import { makeFunctionReference } from "convex/server"; declare const n: string; export const r = makeFunctionReference<"query">(`${n}:run`);', /makeFunctionReference with a non-literal name/],
    ["makeFunctionReference called through a wrapped callee", 'import * as cv from "convex/server"; export const r = (cv.makeFunctionReference as any)<"query">("worker:run");', /^$/],
    ["makeFunctionReference through a non-null namespace receiver", 'import * as cv from "convex/server"; export const r = cv!.makeFunctionReference<"query">("worker:run");', /^$/],
    ["namespace receiver behind as", 'import * as cv from "convex/server"; export const r = (cv as any).makeFunctionReference("worker:run");', /^$/],
    ["api chain behind as/satisfies/non-null", 'import { internal } from "./_generated/api"; export const r = ((internal as any).worker satisfies object)!.run;', /^$/],
    ["api element access with a wrapped literal key", 'import { internal } from "./_generated/api"; export const r = internal[("worker" as string)].run;', /^$/],
  ];
  test.each(wrapped.filter(([, , pattern]) => pattern.source !== "^$"))("a wrapped or computed load refuses: %s", (name, source, pattern) => {
    const file = `convex/wrap_${name.replace(/\W+/g, "_")}.ts`;
    write(file, source);
    const closure = closureOfFile(file);
    expect(closure.unresolved).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  });
  test.each(wrapped.filter(([, , pattern]) => pattern.source === "^$"))("a wrapped but literal reference is still traced to convex/worker.ts: %s", (name, source) => {
    const file = `convex/wrapT_${name.replace(/\W+/g, "_")}.ts`;
    write(file, source);
    const closure = closureOfFile(file);
    expect(closure.unresolved).toEqual([]);
    expect(closure.files).toContain("convex/worker.ts");
  });

  test("CONTROL: a called require.resolve and typeof require load nothing and are not refused", () => {
    write("convex/requireInert.ts", 'declare const require: any;\nexport const a = require.resolve("./worker");\nexport const b = typeof require === "function";\nexport const c = (require as any).resolve("./lone");');
    expect(closureOfFile("convex/requireInert.ts").unresolved).toEqual([]);
  });

  test("the whole renewal path refuses when a wrapped load of convex/server hides a changed worker (Seat 2 reproduction)", () => {
    write("convex/wrapRenew.ts", 'export const update = async () => { const cv = await import(("convex/server")); return cv.makeFunctionReference("worker:run"); };');
    run("add", "--", "convex/wrapRenew.ts");
    run("commit", "-q", "-m", "wrapped load");
    const head = run("rev-parse", "HEAD");
    write("convex/worker.ts", "export const run = 3;");
    run("add", "--", "convex/worker.ts");
    run("commit", "-q", "-m", "worker changed after the review");
    const result = renewBaseline(serialize([entry({ file: "app/page.tsx", callSiteId: "app/page.tsx:1:1", functionId: "wrapRenew:update" })]), {
      compare: gitCompare({ git: String(git), cwd: dir, reviewed: head, head: "HEAD" }),
      closureOf: closureFor(["app/page.tsx", "convex/wrapRenew.ts"]),
      expires: RENEWED_EXPIRES,
      renewal: RENEWAL,
    });
    expect(result.renewed).toBe(0);
    expect(result.refused[0].reason).toMatch(/cannot resolve .*dynamic load of convex\/server/);
  });

  test("CONTROL: renewal is refused when a validator imported only by convex/schema.ts changed", () => {
    write("convex/validators.ts", 'export const kinds = ["a", "b"];');
    run("add", "--", "convex/validators.ts");
    run("commit", "-q", "-m", "validator changed");
    const result = renewal(closureFor(["app/page.tsx", "convex/vehicles.ts"], ["package.json", "convex/schema.ts"]), reviewed);
    expect(result.renewed).toBe(0);
    expect(result.refused[0].reason).toMatch(/convex\/validators\.ts, which changed/);
  });
});
