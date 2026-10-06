// @vitest-environment node
// esbuild refuses to run under the default DOM environment (its Uint8Array
// realm check fails there).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditRefusal, auditStagedBackendInputs } from "./auditStagedBackendInputs.mjs";

/**
 * SCRUM-350 F1 (Sol on PR #341): these run the audit over a real stage and the
 * real Convex bundler, with the stage as the working directory as the workflow
 * does. In-process, so coverage sees the module; one test still spawns the
 * script to pin the CLI contract the workflow depends on.
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

/** The script as the workflow runs it: a child process with the stage as cwd. */
function auditCli(stageRoot: string) {
  const result = spawnSync(process.execPath, [script], { cwd: stageRoot, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const requireFromHere = createRequire(import.meta.url);

/**
 * esbuild reads process.cwd() once, when it is first loaded, and never again;
 * the audit assumes a fresh process per stage (the workflow gives it one). So
 * an in-process audit has to load esbuild and the Convex bundler anew, with
 * the working directory already set to its stage, or the second stage is
 * resolved against the first (deleted on Linux, kept alive by the helper
 * process on Windows, which hid it).
 */
function freshBundler() {
  for (const key of Object.keys(requireFromHere.cache)) {
    if (!/[\\/]node_modules[\\/](esbuild|convex)[\\/]/.test(key)) continue;
    if (/[\\/]esbuild[\\/]lib[\\/]main\.js$/.test(key)) {
      try {
        (requireFromHere.cache[key]?.exports as { stop?: () => void } | undefined)?.stop?.();
      } catch {
        // Already stopped.
      }
    }
    delete requireFromHere.cache[key];
  }
}

/** The same audit in-process (vitest forks, so chdir is per file), shaped like the CLI result. */
async function audit(stageRoot: string) {
  const original = process.cwd();
  freshBundler();
  process.chdir(stageRoot);
  try {
    const result = await auditStagedBackendInputs({ stageRoot });
    return { status: 0, stdout: "Audited " + result.inputs + " bundled inputs from " + result.entryPoints + " entry points", stderr: "" };
  } catch (error) {
    if (!(error instanceof AuditRefusal)) throw error;
    return { status: 1, stdout: "", stderr: error.message };
  } finally {
    process.chdir(original);
    freshBundler();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // On Windows esbuild's helper process, started inside the stage, holds
      // the directory until the worker exits. It is a temp directory.
    }
  }
});

describe("auditStagedBackendInputs (SCRUM-350 F1)", () => {
  it("passes a backend whose every input is staged, including the shared workspace package", async () => {
    const { stageRoot } = stage();
    const result = await audit(stageRoot);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Audited [3-9] bundled inputs from 1 entry points/);
  });

  it("is the same verdict when run as the workflow runs it: a child process with the stage as cwd", () => {
    const passing = auditCli(stage().stageRoot);
    expect(passing.stderr).toBe("");
    expect(passing.status).toBe(0);
    expect(passing.stdout).toMatch(/^Audited [3-9] bundled inputs from 1 entry points; every one is inside/);

    const { root, stageRoot } = stage();
    write(root, { "outside.ts": "export const leaked = 'outside';\n" });
    write(stageRoot, {
      "convex/leak.ts":
        "import { leaked } from " + JSON.stringify(path.join(root, "outside.ts").replaceAll("\\", "/")) +
        ";\nexport const x = leaked;\n",
    });
    const refused = auditCli(stageRoot);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("A bundled input is outside the staged backend");
  }, 60_000);

  it("refuses an absolute import of a file outside the stage", async () => {
    const { root, stageRoot } = stage();
    write(root, { "outside.ts": "export const leaked = 'outside';\n" });
    write(stageRoot, {
      "convex/leak.ts":
        "import { leaked } from " + JSON.stringify(path.join(root, "outside.ts").replaceAll("\\", "/")) +
        ";\nexport const x = leaked;\n",
    });
    const result = await audit(stageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A bundled input is outside the staged backend");
  });

  it("passes a staged directory whose name merely starts with two dots (CodeRabbit on PR #341)", async () => {
    const { stageRoot } = stage({
      "lib/..foo/helper.ts": "export const dotted = 4;\n",
      "convex/dotted.ts": 'import { dotted } from "../lib/..foo/helper";\nexport const z = dotted;\n',
    });
    const result = await audit(stageRoot);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("refuses a relative import that climbs out of the stage", async () => {
    const { root, stageRoot } = stage();
    write(root, { "outside.ts": "export const leaked = 'outside';\n" });
    write(stageRoot, { "lib/climb.ts": 'export { leaked } from "../../outside";\n' });
    write(stageRoot, { "convex/climb.ts": 'import { leaked } from "../lib/climb";\nexport const y = leaked;\n' });
    const result = await audit(stageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A bundled input is outside the staged backend");
  });

  it("refuses a JSON-attribute import of an environ-shaped file, which fails to parse rather than appearing as an input", async () => {
    // In the deploy container this path would be /proc/self/environ, and
    // esbuild's parse error prints the file's text (Sol F1 on PR #341).
    const { root, stageRoot } = stage();
    write(root, { environ: "HOME=/x\0CONVEX_PREVIEW_ADMIN_KEY=preview:t:p|not-a-real-secret\0" });
    write(stageRoot, {
      "convex/environ.ts":
        "import env from " + JSON.stringify(path.join(root, "environ").replaceAll("\\", "/")) +
        ' with { type: "json" };\nexport const e = env;\n',
    });
    const result = await audit(stageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The trusted bundler refused the staged backend.");

    // Control: a bundler that fails on any input would also "refuse"; a valid
    // stage audited the same way passes, so the refusal is about the environ import.
    expect((await audit(stage().stageRoot)).status).toBe(0);
  });

  it("refuses an absolute outside import that appears only in a use-node action (node-platform pass)", async () => {
    const { root, stageRoot } = stage();
    write(root, { "outside.ts": "export const leaked = 'outside';\n" });
    write(stageRoot, {
      "convex/actions/leak.ts":
        '"use node";\nimport { leaked } from ' + JSON.stringify(path.join(root, "outside.ts").replaceAll("\\", "/")) +
        ";\nexport const x = leaked;\n",
    });
    const result = await audit(stageRoot);
    expect(result.stderr).toContain("A bundled input is outside the staged backend");
    expect(result.status).toBe(1);
  });

  it("refuses a bundler failure that appears only in a use-node action (node-platform pass)", async () => {
    const { root, stageRoot } = stage();
    write(root, { environ: "HOME=/x\0CONVEX_PREVIEW_ADMIN_KEY=preview:t:p|not-a-real-secret\0" });
    write(stageRoot, {
      "convex/actions/environ.ts":
        '"use node";\nimport env from ' + JSON.stringify(path.join(root, "environ").replaceAll("\\", "/")) +
        ' with { type: "json" };\nexport const e = env;\n',
    });
    const result = await audit(stageRoot);
    expect(result.stderr).toContain("The trusted bundler refused the staged backend.");
    expect(result.status).toBe(1);
  });

  it("audits every stage against its own working directory, not the first stage this process audited", async () => {
    // esbuild pins process.cwd() at load. Without a fresh loader the second
    // audit resolves against the first stage, which is gone (Linux) or only
    // coincidentally at the same depth (Windows).
    const first = stage();
    expect((await audit(first.stageRoot)).status).toBe(0);
    rmSync(first.root, { recursive: true, force: true });
    const nested = stage({ "lib/deep/extra.ts": "export const deep = 1;\n", "convex/deep.ts": 'import { deep } from "../lib/deep/extra";\nexport const d = deep;\n' });
    const second = await audit(nested.stageRoot);
    expect(second.stderr).toBe("");
    expect(second.status).toBe(0);
  });

  it("refuses an outside read from convex.config.ts, which the CLI's component pass also bundles (Sonnet C1 on PR #341)", async () => {
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
    const result = await audit(stageRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The trusted bundler refused the staged backend.");

    expect((await audit(stage().stageRoot)).status).toBe(0);

    const outside = stage();
    write(outside.root, { "outside.ts": "export default {};\n" });
    write(outside.stageRoot, {
      "convex/convex.config.ts":
        "import c from " + JSON.stringify(path.join(outside.root, "outside.ts").replaceAll("\\", "/")) +
        ";\nexport default c;\n",
    });
    const read = await audit(outside.stageRoot);
    expect(read.status).toBe(1);
    expect(read.stderr).toContain("A bundled input is outside the staged backend");
  });

  it("audits a file under the platform the CLI deploys it with, not a commented-out directive (Sol R1 on PR #341)", async () => {
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
    const result = await audit(stageRoot);
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
    expect((await audit(real.stageRoot)).status).toBe(0);
  });

  it("refuses the environment shapes the CLI's determineEnvironment crashes on (Sonnet F1 on PR #341)", async () => {
    for (const file of ["convex/http.ts", "convex/crons.ts"]) {
      const { stageRoot } = stage({ [file]: '"use node";\nexport const n = 1;\n' });
      const result = await audit(stageRoot);
      expect(result.status, file).toBe(1);
      expect(result.stderr, file).toContain('"use node" is not allowed in');
    }
    const actions = stage({ "convex/actions/send.ts": "export const s = 1;\n" });
    const refused = await audit(actions.stageRoot);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("is under actions/ without");

    // Controls: the same files in the shape the CLI accepts pass.
    const accepted = stage({
      "convex/http.ts": "export const n = 1;\n",
      "convex/actions/send.ts": '"use node";\nexport const s = 1;\n',
    });
    expect((await audit(accepted.stageRoot)).status).toBe(0);
  });

  it("refuses to run anywhere but the stage, and without the trusted bundler", async () => {
    const { root, stageRoot } = stage();
    rmSync(path.join(stageRoot, "node_modules/convex"), { recursive: true, force: true });
    const missing = await audit(stageRoot);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("The trusted Convex bundler is not mounted in the stage.");
    expect((await audit(root)).status).toBe(1);

    // Run from anywhere but the stage, esbuild would report inputs relative to
    // the wrong directory; the audit refuses rather than mis-resolve them.
    const other = stage();
    await expect(auditStagedBackendInputs({ stageRoot: other.stageRoot })).rejects.toThrow(
      "The audit must run with the stage as its working directory.",
    );
    await expect(auditStagedBackendInputs({ stageRoot: "relative/stage" })).rejects.toThrow(
      "Stage root must be an absolute path.",
    );
    await expect(auditStagedBackendInputs({ stageRoot: "" })).rejects.toThrow(AuditRefusal);
  });

  it("refuses a stage with no entry points", async () => {
    const empty = stage();
    rmSync(path.join(empty.stageRoot, "convex"), { recursive: true, force: true });
    mkdirSync(path.join(empty.stageRoot, "convex"), { recursive: true });
    expect((await audit(empty.stageRoot)).stderr).toBe("The staged backend has no entry points.");
  });
});
