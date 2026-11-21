import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScenarioWorkflow } from "./scenarioWorkflowRunner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.exitCode = runScenarioWorkflow({ root, args: process.argv.slice(2), env: process.env });
