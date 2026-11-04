import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { compareContracts } from "./compare.mjs";
import { CLASSIFICATION, classifyBreaking } from "./classify.mjs";
import { clientNode } from "./contractTree.mjs";
import { specProblems } from "./specIndex.mjs";
import { writeBaselineDirectory } from "./baselineTestSupport.mjs";

// registration_impl.ts exportArgs serializes asObjectValidator(args).json.
// cli/lib/functionSpec.ts wraps the server's _system/cli/modules:apiSpec output.
// This exercises the registered export locally, never a deployment or handler.
test("shared-validator-only change breaks the omitted field, with old-spec and compatible-call controls", () => {
  const cache = path.resolve("node_modules/.cache");
  fs.mkdirSync(cache, { recursive: true });
  const dir = fs.mkdtempSync(path.join(cache, "shared-validator-"));
  try {
    const fixture = path.resolve("scripts/contractSkew/__fixtures__/sharedValidator");
    fs.cpSync(fixture, dir, { recursive: true });
    const functionSource = fs.readFileSync(path.join(dir, "function.mjs"), "utf8");
    const renderSpec = () => ({ functions: [{
      identifier: "shared.js:update", functionType: "Mutation", visibility: { kind: "public" },
      args: JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
        `const { update } = await import(${JSON.stringify(pathToFileURL(path.join(dir, "function.mjs")).href)}); process.stdout.write(update.exportArgs());`,
      ], { encoding: "utf8" })),
    }] });
    const oldSpec = renderSpec();
    const shared = path.join(dir, "args.mjs");
    fs.writeFileSync(shared, fs.readFileSync(shared, "utf8").replace("v.optional(v.string())", "v.string()"));
    const newSpec = renderSpec();
    expect(fs.readFileSync(path.join(dir, "function.mjs"), "utf8")).toBe(functionSource);
    expect(specProblems(oldSpec)).toEqual([]);
    expect(specProblems(newSpec)).toEqual([]);
    expect(newSpec).not.toEqual(oldSpec);

    const call = (fields: Map<string, { node: ReturnType<typeof clientNode.scalar>; provenance: string }>, line: number) => ({
      identifier: "shared:update", via: "useMutation", file: "app/page.tsx", line,
      siteId: `app/page.tsx:${line}:1`, surface: "web", payload: clientNode.object(fields, true),
    });
    const calls = [call(new Map(), 1), call(new Map([["label", { node: clientNode.scalar("string"), provenance: "TYPE" }]]), 2)];
    const oldResult = compareContracts(calls, oldSpec);
    const newResult = compareContracts(calls, newSpec);
    expect(oldResult.verdict).toBe("PASS");
    expect(newResult.breaking).toEqual([expect.objectContaining({ path: "label", siteId: "app/page.tsx:1:1" })]);
    expect(compareContracts([calls[1]], newSpec).verdict).toBe("PASS");
    const classified = classifyBreaking(newResult.breaking, { currentResult: oldResult });
    expect(classified.classified).toEqual([expect.objectContaining({ classification: CLASSIFICATION.REVISION_SKEW })]);

    fs.mkdirSync(path.join(dir, "app"));
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true,
    } }));
    fs.writeFileSync(path.join(dir, "app/client.ts"), `import { useMutation } from "convex/react";
declare const api: { shared: { update: unknown } };
export function run() {
  const update = useMutation(api.shared.update);
  update({});
  update({ label: "fits both" });
}`);
    fs.writeFileSync(path.join(dir, "old.json"), JSON.stringify(oldSpec));
    fs.writeFileSync(path.join(dir, "new.json"), JSON.stringify(newSpec));
    writeBaselineDirectory(path.join(dir, "baseline"), []);
    const cli = path.resolve("scripts/contractSkew/cli.mjs");
    const runCli = (spec: string) => spawnSync(process.execPath, [cli, "--mode", "production", "--spec", spec,
      "--current", "old.json", "--baseline", "baseline", "--json", "report.json"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
    });
    const oldCli = runCli("old.json");
    expect(oldCli.error).toBeUndefined();
    expect(oldCli.status, oldCli.stderr).toBe(0);
    const newCli = runCli("new.json");
    expect(newCli.error).toBeUndefined();
    expect(newCli.status, newCli.stderr).toBe(7);
    const report = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
    expect(report.breaking).toEqual([expect.objectContaining({ path: "label", line: 5, classification: CLASSIFICATION.REVISION_SKEW })]);
    expect(report.coverage.clientCallSitesResolved).toBe(2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
