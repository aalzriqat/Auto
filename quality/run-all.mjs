import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";

const qualityDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(qualityDirectory);

const checks = [
  { name: "maintainability", file: "maintainability.mjs" },
  { name: "architecture", file: "architecture.mjs" },
  { name: "autoflow-safety", file: "autoflow-rules.mjs" },
];

function runCheck(check) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(
      process.execPath,
      [path.join(qualityDirectory, check.file)],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      resolve({
        ...check,
        code: 1,
        stdout,
        stderr: `${stderr}${error.stack || error.message}\n`,
        durationMs: performance.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      resolve({
        ...check,
        code: code ?? 1,
        stdout,
        stderr,
        durationMs: performance.now() - startedAt,
      });
    });
  });
}

const results = await Promise.all(checks.map(runCheck));

for (const result of results) {
  const outcome = result.code === 0 ? "PASS" : "FAIL";
  console.log(
    `\n=== ${result.name}: ${outcome} (${(result.durationMs / 1000).toFixed(2)}s) ===`,
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

const failures = results.filter((result) => result.code !== 0);
if (failures.length > 0) {
  console.error(
    `\nQuality guardrails failed: ${failures.map((result) => result.name).join(", ")}.`,
  );
  process.exitCode = 1;
} else {
  console.log(`\nAll ${results.length} quality guardrails passed.`);
}
