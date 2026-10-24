import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const bindingSchema = z.object({
  baseSha: z.string().regex(/^[a-f0-9]{40}$/), headSha: z.string().regex(/^[a-f0-9]{40}$/),
  testedSha: z.string().regex(/^[a-f0-9]{40}$/), controllerSha: z.string().regex(/^[a-f0-9]{40}$/),
  runId: z.string().regex(/^gh-\d+-[1-9]\d*$/),
}).strict();
const testSchema = z.object({ projectName: z.literal("chromium"), expectedStatus: z.literal("passed"),
  status: z.literal("expected"), results: z.array(z.object({ status: z.literal("passed"), retry: z.literal(0),
    errors: z.array(z.unknown()).length(0) }).passthrough()).length(1) }).passthrough();
const suiteSchema = z.object({ suites: z.array(z.unknown()).optional(),
  specs: z.array(z.object({ file: z.string(), title: z.string(), ok: z.literal(true),
    tests: z.array(testSchema).length(1) }).passthrough()).optional() }).passthrough();
const reportSchema = z.object({ errors: z.array(z.unknown()).length(0), suites: z.array(z.unknown()),
  config: z.object({ rootDir: z.string(), configFile: z.string(),
    metadata: z.object({ openingProof: bindingSchema }).passthrough() }).passthrough(),
  stats: z.object({ expected: z.literal(2), skipped: z.literal(0), unexpected: z.literal(0), flaky: z.literal(0) }).passthrough(),
}).passthrough();
const CASES = new Map([
  ["owner opening form posts exact native allocations once", "opening-owner-native"],
  ["finance opening form drafts for a different reviewer and posts once", "opening-review-native"],
]);

/** Verify only actual reporter results, never annotations or source-text mentions.
 * @param {unknown} value @param {unknown} expected */
export function verifyOpeningBrowserProof(value, expected) {
  const report = reportSchema.parse(value), binding = bindingSchema.parse(expected);
  if (JSON.stringify(report.config.metadata.openingProof) !== JSON.stringify(binding)) throw new Error("OPENING_PROOF_BINDING_UNAVAILABLE");
  const expectedRoot = path.resolve("playwright/opening-proof");
  const expectedConfig = path.resolve("playwright.opening-proof.config.ts");
  if (!path.isAbsolute(report.config.rootDir) || path.resolve(report.config.rootDir) !== expectedRoot ||
      !path.isAbsolute(report.config.configFile) || path.resolve(report.config.configFile) !== expectedConfig) {
    throw new Error("OPENING_PROOF_CONFIG_UNAVAILABLE");
  }
  const pending = [...report.suites];
  /** @type {string[]} */
  const observed = [];
  for (let visited = 0; pending.length && visited < 10000; visited += 1) {
    const suite = suiteSchema.parse(pending.pop()); pending.push(...(suite.suites ?? []));
    for (const spec of suite.specs ?? []) {
      const caseId = CASES.get(spec.title);
      if (spec.file !== "opening-onboarding.spec.ts" ||
          path.resolve(report.config.rootDir, spec.file) !== path.join(expectedRoot, "opening-onboarding.spec.ts") || !caseId) {
        throw new Error("OPENING_PROOF_SELECTION_UNAVAILABLE");
      }
      observed.push(caseId);
    }
  }
  if (pending.length || observed.length !== 2 || new Set(observed).size !== 2) throw new Error("OPENING_PROOF_CASES_UNAVAILABLE");
  return { schemaVersion: 1, binding, expected: 2, passed: 2, skipped: 0, flaky: 0, unexpected: 0, errors: 0,
    cases: [...observed].sort(), checked: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("scripts/verifyOpeningBrowserProof.mjs")) {
  try {
    const file = "opening-proof-json/results.json";
    if (fs.statSync(file).size > 8388608) throw new Error("OPENING_PROOF_REPORT_UNAVAILABLE");
    const proof = verifyOpeningBrowserProof(JSON.parse(fs.readFileSync(file, "utf8")), {
      baseSha: process.env.BASE_SHA, headSha: process.env.HEAD_SHA, testedSha: process.env.TESTED_SHA,
      controllerSha: process.env.CONTROLLER_SHA, runId: process.env.OPENING_PROOF_RUN_ID,
    });
    fs.mkdirSync("opening-proof-public", { recursive: true });
    fs.writeFileSync("opening-proof-public/proof.json", JSON.stringify(proof), { flag: "wx" });
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "checked=true\n");
  } catch { console.error("OPENING_PROOF_UNAVAILABLE"); process.exitCode = 1; }
}
