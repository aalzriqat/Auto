import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as containment from "./browserEgressContainment.mjs";
import * as launch from "./browserEgressLaunch.mjs";

/**
 * SCRUM-350 G4: Playwright transpiles its configs and specs to CommonJS. A
 * repo `.mjs` they import is transpiled the same way, so `import.meta`, a
 * top-level `await` or a chain of node-only imports in it fails every spec at
 * load time ("No tests found") - in the visual gate on every PR and in the
 * trusted E2E/swarm jobs after merge. The browser-side launch surface therefore
 * lives in a dependency-free module; this pins that.
 */
const ROOT = resolve(__dirname, "..", "..");

function playwrightLoadedFiles(): string[] {
  const files = ["playwright.config.ts", "playwright.visual.config.ts"].map((f) => join(ROOT, f));
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) files.push(path);
    }
  };
  walk(join(ROOT, "playwright"));
  return files;
}

/** Source with block and line comments removed (good enough for these files). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Resolve a relative specifier the way Playwright's loader does for this repo. */
function resolveRelative(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** Every relative module a file loads at runtime (type-only imports are erased). */
function relativeRuntimeImports(file: string): string[] {
  const source = code(readFileSync(file, "utf8"));
  const specs = [
    ...source.matchAll(/^\s*import\s+(?!type\s)[^;]*?\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gm),
    ...source.matchAll(/^\s*export\s+(?!type\s)[^;]*?\bfrom\s+["'](\.{1,2}\/[^"']+)["']/gm),
    ...source.matchAll(/^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm),
  ].map((m) => m[1]);
  return specs.map((spec) => resolveRelative(file, spec)).filter((p): p is string => p !== undefined);
}

/** What CommonJS cannot express: import.meta, or an await at module top level. */
function cjsHazard(source: string): string | undefined {
  // String and template contents are data (e.g. a script handed to a child
  // `node --input-type=module`), not this module's code.
  const body = code(source)
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
  if (/\bimport\.meta\b/.test(body)) return "import.meta";
  if (/^await\s/m.test(body)) return "top-level await";
  return undefined;
}

describe("browserEgressLaunch.mjs is loadable by Playwright's CommonJS transform", () => {
  it("is dependency-free and CommonJS-safe", () => {
    const source = readFileSync(join(__dirname, "browserEgressLaunch.mjs"), "utf8");
    expect(code(source)).not.toMatch(/^\s*import\s/m);
    expect(cjsHazard(source)).toBeUndefined();
  });

  it("no repo module reachable from a Playwright config or spec uses import.meta or top-level await", () => {
    const offenders: string[] = [];
    const visited = new Set<string>();
    const visit = (from: string, target: string) => {
      if (visited.has(target)) return;
      visited.add(target);
      const hazard = cjsHazard(readFileSync(target, "utf8"));
      if (hazard) offenders.push(`${relative(ROOT, from)} -> ${relative(ROOT, target)} (${hazard})`);
      for (const next of relativeRuntimeImports(target)) visit(target, next);
    };
    for (const file of playwrightLoadedFiles()) visit(file, file);
    const reachedScripts = [...visited].filter((p) => relative(ROOT, p).startsWith("scripts"));
    // The graph must actually reach the trusted swarm runtime and the launch module,
    // or the walk is not following the imports that broke the gate.
    expect(reachedScripts.map((p) => relative(ROOT, p).replace(/\\/g, "/"))).toEqual(
      expect.arrayContaining([
        "scripts/intelligence/browserEgressLaunch.mjs",
        "scripts/intelligence/browserAttackSwarmRuntime.ts",
      ]),
    );
    expect(offenders).toEqual([]);
  });

  it("the containment module re-exports the identical launch surface", () => {
    expect(containment.EGRESS_CONTEXT_OPTIONS).toBe(launch.EGRESS_CONTEXT_OPTIONS);
    expect(containment.EGRESS_CHROMIUM_ARGS).toBe(launch.EGRESS_CHROMIUM_ARGS);
    expect(containment.browserEgressLaunchOptions).toBe(launch.browserEgressLaunchOptions);
    expect(containment.BROWSER_EGRESS_PROXY_ENV).toBe(launch.BROWSER_EGRESS_PROXY_ENV);
    expect(containment.BROWSER_EGRESS_REQUIRED_ENV).toBe(launch.BROWSER_EGRESS_REQUIRED_ENV);
  });
});
