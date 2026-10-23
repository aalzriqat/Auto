// @vitest-environment node
import { readFileSync } from "node:fs";
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

describe("credential-free static visual browser environment", () => {
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

it.each(['{"driverVersion":"1.61.0"}', '{'])("actual CLI refuses invalid image metadata without raw error disclosure", (marker) => {
  const script = path.resolve("scripts/playwrightImagePreflight.mjs");
  // Child-process FS boundary only: production CLI retains its fixed native marker path.
  const program = `import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
const original=fs.readFile;
fs.readFile=async (...args)=>{if(args[0]==='/ms-playwright/.docker-info'){process.stderr.write('CONTROL_MARKER_READ\\n');return ${JSON.stringify(marker)};}return original(...args);};
syncBuiltinESMExports();process.argv[1]=${JSON.stringify(script)};
await import(${JSON.stringify(pathToFileURL(script).href)});`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toBe("CONTROL_MARKER_READ\nPLAYWRIGHT_IMAGE_PREFLIGHT_REFUSED\n");
});
