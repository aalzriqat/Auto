import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

test("CI role reporter keeps synthetic private failures out of caller-owned report paths", () => {
  const parent = path.resolve("..");
  const root = mkdtempSync(path.join(parent, "pilot-role-reporter-"));
  try {
    const require = createRequire(import.meta.url);
    const canary = "QA-PRIVATE-REPORTER-CANARY";
    const sentinels = ["playwright-report", "playwright-json"];
    for (const directory of sentinels) {
      mkdirSync(path.join(root, directory));
      writeFileSync(path.join(root, directory, "caller-owned.txt"), "caller-owned");
    }
    writeFileSync(path.join(root, "synthetic.spec.ts"), `import {test} from ${JSON.stringify(require.resolve("@playwright/test"))};
import {writeFileSync} from "node:fs";
test("synthetic private failure", async ({}, info) => {
  writeFileSync(info.outputPath("private-proof.txt"), ${JSON.stringify(canary)});
  await info.attach("synthetic-private", {body: Buffer.from(${JSON.stringify(canary)}), contentType: "text/plain"});
  throw new Error(${JSON.stringify(canary)});
});`);
    // Use the actual role reporter under CI, disabling application setup and
    // server/browser fixtures for this deliberately failing synthetic test.
    writeFileSync(path.join(root, "synthetic.config.ts"), `import base from ${JSON.stringify(path.resolve("playwright.role-audit.config.ts"))};
export default {...base, webServer: undefined, globalSetup: undefined, globalTeardown: undefined,
  projects: [{name: "synthetic", testDir: ${JSON.stringify(root)}, testMatch: "synthetic.spec.ts", use: {}}]};`);
    const run = spawnSync(process.execPath, [require.resolve("@playwright/test/cli"), "test", "-c", "synthetic.config.ts",
      "--workers=1", `--output=${path.join(root, "private-captures")}`], {
      cwd: root, env: { ...process.env, CI: "true", PLAYWRIGHT_SKIP_WEBSERVER: "1" },
      encoding: "utf8", timeout: 45_000, windowsHide: true,
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stdout + run.stderr).toContain(canary);
    const executed = readdirSync(path.join(root, "private-captures"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    expect(executed).toHaveLength(1);
    expect(readFileSync(path.join(root, "private-captures", executed[0]!.name, "private-proof.txt"), "utf8")).toBe(canary);
    for (const directory of sentinels) {
      expect(readdirSync(path.join(root, directory))).toEqual(["caller-owned.txt"]);
      expect(readFileSync(path.join(root, directory, "caller-owned.txt"), "utf8")).toBe("caller-owned");
    }
  } finally {
    if (!root.startsWith(parent + path.sep)) throw new Error("Synthetic test cleanup escaped its parent.");
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
