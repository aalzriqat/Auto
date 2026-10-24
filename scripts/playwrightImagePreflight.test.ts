// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

type StaticWorkflow = {
  permissions: Record<string, string>;
  jobs: { playwright: {
    container: { image: string; options: string };
    defaults: { run: { shell: string } };
    "timeout-minutes": number;
    steps: { name?: string; run?: string; if?: string; with?: { path?: string } }[];
  } };
};

type VisualStep = { run?: string; uses?: string; if?: string | boolean; with?: { path?: string } };
function visualUploadCoverage(steps: readonly VisualStep[], output: string) {
  const coverage: { gate: number; covered: boolean }[] = [];
  for (let gate = 0; gate < steps.length; gate += 1) {
    if (!/pnpm run test:visual:deal-cockpit|playwright test -c playwright\.visual\.config\.ts/.test(steps[gate].run ?? "")) continue;
    const roots = steps.slice(gate + 1)
      .filter(step => step.uses?.startsWith("actions/upload-artifact@") && step.if === "always()")
      .flatMap(step => (step.with?.path ?? "").trim().split(/\r?\n/))
      .map(root => root.trim().replace(/\/$/, ""))
      .filter(Boolean);
    coverage.push({ gate, covered: roots.some(root => output === root || output.startsWith(`${root}/`)) });
  }
  return coverage;
}

describe("credential-free static visual browser environment", () => {
  it("requires an upload after the last visual invocation, not just after its predecessor", () => {
    const output = /outputDir:\s*["']([^"']+)["']/.exec(readFileSync("playwright.visual.config.ts", "utf8"))?.[1];
    if (!output) throw new Error("Visual output directory unavailable");
    const gate = { run: "pnpm run test:visual:deal-cockpit" };
    const upload = { uses: "actions/upload-artifact@pinned", if: "always()", with: { path: output } };
    expect(visualUploadCoverage([gate, upload, gate], output).filter(item => !item.covered).map(item => item.gate)).toEqual([2]);
    expect(visualUploadCoverage([gate, upload, gate, upload], output).every(item => item.covered)).toBe(true);
  });
  it("retains visual diagnostics when any invoking workflow fails before the full suite", () => {
    // Main run 40105113884 lost its capture diagnostic because only full-suite reports were uploaded.
    const config = readFileSync("playwright.visual.config.ts", "utf8");
    const output = /outputDir:\s*["']([^"']+)["']/.exec(config)?.[1];
    if (!output) throw new Error("Visual configuration has no static output directory");
    function object(value: unknown): value is Record<string, unknown> {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }
    const invocations: { workflow: string; job: string; covered: boolean }[] = [];
    for (const file of readdirSync(".github/workflows").filter(name => /\.ya?ml$/.test(name))) {
      const workflow: unknown = parse(readFileSync(path.join(".github/workflows", file), "utf8"));
      if (!object(workflow) || !object(workflow.jobs)) throw new Error(`Workflow jobs unavailable: ${file}`);
      for (const [job, definition] of Object.entries(workflow.jobs)) {
        if (!object(definition)) throw new Error(`Workflow job unavailable: ${file}/${job}`);
        if (definition.steps === undefined) continue; // Reusable-workflow jobs have no steps.
        if (!Array.isArray(definition.steps)) throw new Error(`Workflow steps unavailable: ${file}/${job}`);
        const steps = definition.steps.map((value: unknown) => {
          if (!object(value)) throw new Error(`Workflow step unavailable: ${file}/${job}`);
          const { run, uses, if: condition, with: inputs } = value;
          if ((run !== undefined && typeof run !== "string") ||
              (uses !== undefined && typeof uses !== "string") ||
              (condition !== undefined && typeof condition !== "string" && typeof condition !== "boolean")) {
            throw new Error(`Workflow command unavailable: ${file}/${job}`);
          }
          if (inputs !== undefined && !object(inputs)) throw new Error(`Workflow inputs unavailable: ${file}/${job}`);
          const outputPath = inputs?.path;
          if (outputPath !== undefined && typeof outputPath !== "string") throw new Error(`Workflow output path unavailable: ${file}/${job}`);
          return { run, uses, if: condition, with: { path: outputPath } };
        });
        for (const invocation of visualUploadCoverage(steps, output)) {
          invocations.push({ workflow: file, job, covered: invocation.covered });
        }
      }
    }
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.filter(invocation => !invocation.covered)).toEqual([]);
  });

  it("uses a preinstalled version-matched image without losing the full gate", () => {
    const workflow: StaticWorkflow = parse(readFileSync(".github/workflows/playwright.yml", "utf8"));
    const job = workflow.jobs.playwright;
    expect(job.container.image).toBe("mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48");
    expect(job.container.options).toBe("--user 1001 --init --ipc=host");
    expect(job.defaults.run.shell).toBe("bash");
    expect(job["timeout-minutes"]).toBe(20);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const steps = job.steps;
    expect(steps.some((step) => /playwright install/.test(step.run ?? ""))).toBe(false);
    const preflight = steps.findIndex((step) => step.run?.includes("node scripts/playwrightImagePreflight.mjs"));
    const gate = steps.findIndex((step) => step.run?.includes("pnpm run test:visual:deal-cockpit"));
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeLessThan(gate);
    expect(steps[preflight].run?.trim().split(/\r?\n/).map((line) => line.trim())).toEqual([
      'test "$(id -u)" -eq 1001',
      'test -w "$HOME"',
      'test -w "$GITHUB_WORKSPACE"',
      'test "$(node --version)" = "v22.21.1"',
      'node scripts/playwrightImagePreflight.mjs',
    ]);
    expect(steps[gate].run).toContain("node scripts/assertDealCockpitVisualFrames.mjs test-results/deal-cockpit-visual");
    const upload = steps.find((step) => step.name === "Upload deal cockpit visual screenshots");
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.path).toBe("test-results/deal-cockpit-visual/");
  });
});
const boundary = vi.hoisted(() => ({
  marker: vi.fn(),
  chromium: vi.fn(),
  webkit: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ readFile: boundary.marker }));
vi.mock("@playwright/test", () => ({
  chromium: { name: () => "chromium", launch: boundary.chromium },
  webkit: { name: () => "webkit", launch: boundary.webkit },
}));
import { runPlaywrightImagePreflight } from "./playwrightImagePreflight.mjs";

beforeEach(() => { vi.clearAllMocks(); });

it.each([
  ["mismatched", '{"driverVersion":"1.61.0"}'],
  ["missing", '{}'],
  ["malformed", '{'],
])("refuses %s image metadata before launching either browser", async (_name, marker) => {
  boundary.marker.mockResolvedValue(marker);
  await expect(runPlaywrightImagePreflight()).rejects.toThrow();
  expect(boundary.chromium).not.toHaveBeenCalled();
  expect(boundary.webkit).not.toHaveBeenCalled();
});

it("requires both actual browser APIs serially and closes each before the next probe", async () => {
  boundary.marker.mockResolvedValue('{"driverVersion":"1.61.1"}');
  const events: string[] = [];
  boundary.chromium.mockImplementation(async () => {
    events.push("chromium launch");
    return { version: () => "149.0.7827.55", close: async () => { events.push("chromium close"); } };
  });
  boundary.webkit.mockImplementation(async () => {
    events.push("webkit launch");
    return { version: () => "26.5", close: async () => { events.push("webkit close"); } };
  });
  await runPlaywrightImagePreflight();
  expect(events).toEqual(["chromium launch", "chromium close", "webkit launch", "webkit close"]);
  boundary.webkit.mockRejectedValueOnce(new Error("Missing system library"));
  await expect(runPlaywrightImagePreflight()).rejects.toThrow("Missing system library");
});

it.each([
  { reason: "wrong image version", marker: '{"driverVersion":"1.61.0"}', installedVersion: null },
  { reason: "malformed image metadata", marker: '{', installedVersion: null },
  { reason: "wrong installed package version", marker: '{"driverVersion":"1.61.1"}', installedVersion: "1.61.0" },
])("actual CLI refuses $reason before SDK import without raw error disclosure", ({ marker, installedVersion }) => {
  const script = path.resolve("scripts/playwrightImagePreflight.mjs");
  // Child-process filesystem/module boundaries: retain the real CLI and refusal behavior.
  const program = `import fs from 'node:fs/promises';
import {createRequire,registerHooks,syncBuiltinESMExports} from 'node:module';
const installedVersion=${JSON.stringify(installedVersion)};
if(installedVersion!==null){
  const require=createRequire(${JSON.stringify(script)});
  const packagePath=require.resolve('@playwright/test/package.json');
  require.cache[packagePath]={exports:{get version(){process.stderr.write('CONTROL_INSTALLED_PACKAGE_READ\\n');return installedVersion;}}};
}
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier==='@playwright/test'){process.stderr.write('CONTROL_BROWSER_IMPORT\\n');throw new Error('Unexpected browser SDK import');}
  return nextResolve(specifier,context);
}});
const original=fs.readFile;
fs.readFile=async (...args)=>{if(args[0]==='/ms-playwright/.docker-info'){process.stderr.write('CONTROL_MARKER_READ\\n');return ${JSON.stringify(marker)};}return original(...args);};
syncBuiltinESMExports();process.argv[1]=${JSON.stringify(script)};
await import(${JSON.stringify(pathToFileURL(script).href)});`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toBe(`CONTROL_MARKER_READ\n${installedVersion === null ? "" : "CONTROL_INSTALLED_PACKAGE_READ\n"}PLAYWRIGHT_IMAGE_PREFLIGHT_REFUSED\n`);
});
