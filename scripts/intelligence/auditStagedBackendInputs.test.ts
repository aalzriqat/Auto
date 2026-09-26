import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * SCRUM-350 F1 (Sol on PR #341): these run the audit exactly as the workflow
 * does — `node auditStagedBackendInputs.mjs` with the stage as the working
 * directory — over a real stage and the real Convex bundler.
 */

const script = path.resolve(process.cwd(), "scripts/intelligence/auditStagedBackendInputs.mjs");
const convexPackage = path.dirname(
  realpathSync(createRequire(path.resolve(process.cwd(), "package.json")).resolve("convex/package.json")),
);
const roots: string[] = [];

function write(root: string, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function link(target: string, at: string) {
  mkdirSync(path.dirname(at), { recursive: true });
  // A junction needs no privilege on Windows; on Linux the type is ignored.
  symlinkSync(target, at, "junction");
}

function stage(extra: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "audit-stage-"));
  roots.push(root);
  const stageRoot = path.join(root, "stage");
  write(stageRoot, {
    "convex/deals.ts":
      'import { money } from "../lib/money";\n' +
      'import { firstPayment } from "@autoflow/shared/financing";\n' +
      "export const total = money + firstPayment;\n",
    "lib/money.ts": "export const money = 2;\n",
    "packages/shared/package.json": JSON.stringify({
      name: "@autoflow/shared",
      type: "module",
      exports: { "./financing": "./src/financing.ts" },
    }),
    "packages/shared/src/financing.ts": "export const firstPayment = 3;\n",
    ...extra,
  });
  // The trusted node_modules: the Convex CLI, and the workspace link that
  // resolves to the staged shared package, as pnpm lays it out on Linux.
  link(convexPackage, path.join(stageRoot, "node_modules/convex"));
  link(path.join(stageRoot, "packages/shared"), path.join(stageRoot, "node_modules/@autoflow/shared"));
  return { root, stageRoot };
}

function audit(stageRoot: string) {
  const result = spawnSync(process.execPath, [script], { cwd: stageRoot, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("auditStagedBackendInputs (SCRUM-350 F1)", () => {
  it("passes a backend whose every input is staged, including the shared workspace package", () => {
    const { stageRoot } = stage();
    const result = audit(stageRoot);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Audited [3-9] bundled inputs from 1 entry points/);
  });

  it("refuses an absolute import of a file outside the stage", () => {
    const { root, stageRoot } = stage();
    write(root, { "outside.ts": "export const leaked = 'outside';\n" });
    write(stageRoot, {
      "convex/leak.ts":
        "import { leaked } from " + JSON.stringify(path.join(root, "outside.ts").replaceAll("\\", "/")) +
        ";\nexport const x = leaked;\n",
    });
    const result = audit(stageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A bundled input is outside the staged backend");
  });

  it("refuses a relative import that climbs out of the stage", () => {
    const { root, stageRoot } = stage();
    write(root, { "outside.ts": "export const leaked = 'outside';\n" });
    write(stageRoot, { "lib/climb.ts": 'export { leaked } from "../../outside";\n' });
    write(stageRoot, { "convex/climb.ts": 'import { leaked } from "../lib/climb";\nexport const y = leaked;\n' });
    const result = audit(stageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A bundled input is outside the staged backend");
  });

  it("refuses a JSON-attribute import of an environ-shaped file, which fails to parse rather than appearing as an input", () => {
    // In the deploy container this path would be /proc/self/environ, and
    // esbuild's parse error prints the file's text (Sol F1 on PR #341).
    const { root, stageRoot } = stage();
    write(root, { environ: "HOME=/x\0CONVEX_PREVIEW_ADMIN_KEY=preview:t:p|not-a-real-secret\0" });
    write(stageRoot, {
      "convex/environ.ts":
        "import env from " + JSON.stringify(path.join(root, "environ").replaceAll("\\", "/")) +
        ' with { type: "json" };\nexport const e = env;\n',
    });
    const result = audit(stageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The trusted bundler refused the staged backend.");
  });

  it("refuses an outside read from convex.config.ts, which the CLI's component pass also bundles (Sonnet C1 on PR #341)", () => {
    // The deploy's componentGraph/bundleDefinitions pass bundles convex.config.ts
    // with platform "browser" and conditions ["convex", "module"], resolving
    // through esbuild's own resolver; the audit bundles the same file the same way.
    const { root, stageRoot } = stage();
    write(root, { environ: "HOME=/x\0CONVEX_PREVIEW_ADMIN_KEY=preview:t:p|not-a-real-secret\0" });
    write(stageRoot, {
      "convex/convex.config.ts":
        "import env from " + JSON.stringify(path.join(root, "environ").replaceAll("\\", "/")) +
        ' with { type: "json" };\nexport default env;\n',
    });
    const result = audit(stageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The trusted bundler refused the staged backend.");

    const outside = stage();
    write(outside.root, { "outside.ts": "export default {};\n" });
    write(outside.stageRoot, {
      "convex/convex.config.ts":
        "import c from " + JSON.stringify(path.join(outside.root, "outside.ts").replaceAll("\\", "/")) +
        ";\nexport default c;\n",
    });
    const read = audit(outside.stageRoot);
    expect(read.status).toBe(1);
    expect(read.stderr).toContain("A bundled input is outside the staged backend");
  });

  it("audits a file under the platform the CLI deploys it with, not a commented-out directive (Sol R1 on PR #341)", () => {
    // The deploy bundles this for the browser (Convex parses directives), so
    // the audit must resolve the package's browser branch, which reads outside.
    const { root, stageRoot } = stage();
    write(root, { "outside.js": "export const leaked = 1;\n" });
    write(stageRoot, {
      "node_modules/split-pkg/package.json": JSON.stringify({
        name: "split-pkg",
        exports: { ".": { browser: "./browser.js", default: "./node.js" } },
      }),
      "node_modules/split-pkg/node.js": "export const leaked = 0;\n",
      "node_modules/split-pkg/browser.js":
        "export { leaked } from " + JSON.stringify(path.join(root, "outside.js").replaceAll("\\", "/")) + ";\n",
      "convex/split.ts": '/*\n"use node";\n*/\nimport { leaked } from "split-pkg";\nexport const z = leaked;\n',
    });
    const result = audit(stageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A bundled input is outside the staged backend");

    // Control: a real directive is Node in both, and takes the node branch.
    const real = stage();
    write(real.stageRoot, {
      "node_modules/split-pkg/package.json": JSON.stringify({
        name: "split-pkg",
        exports: { ".": { browser: "./missing.js", default: "./node.js" } },
      }),
      "node_modules/split-pkg/node.js": "export const leaked = 0;\n",
      "convex/split.ts": '"use node";\nimport { leaked } from "split-pkg";\nexport const z = leaked;\n',
    });
    expect(audit(real.stageRoot).status).toBe(0);
  });

  it("refuses the environment shapes the CLI's determineEnvironment crashes on (Sonnet F1 on PR #341)", () => {
    for (const file of ["convex/http.ts", "convex/crons.ts"]) {
      const { stageRoot } = stage({ [file]: '"use node";\nexport const n = 1;\n' });
      const result = audit(stageRoot);
      expect(result.status, file).toBe(1);
      expect(result.stderr, file).toContain('"use node" is not allowed in');
    }
    const actions = stage({ "convex/actions/send.ts": "export const s = 1;\n" });
    const refused = audit(actions.stageRoot);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("is under actions/ without");

    // Controls: the same files in the shape the CLI accepts pass.
    const accepted = stage({
      "convex/http.ts": "export const n = 1;\n",
      "convex/actions/send.ts": '"use node";\nexport const s = 1;\n',
    });
    expect(audit(accepted.stageRoot).status).toBe(0);
  });

  it("refuses to run anywhere but the stage, and without the trusted bundler", () => {
    const { root, stageRoot } = stage();
    rmSync(path.join(stageRoot, "node_modules/convex"), { recursive: true, force: true });
    const missing = audit(stageRoot);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("The trusted Convex bundler is not mounted in the stage.");
    expect(audit(root).status).toBe(1);
  });
});
