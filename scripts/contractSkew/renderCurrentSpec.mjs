import fs from "node:fs";
import path from "node:path";
import { renderCurrentSpec } from "./currentSpec.mjs";
import { isRunDirectly } from "./runDirectly.mjs";
import { resolveInside } from "./baselineFile.mjs";

/** @param {string | undefined} candidate @param {string} [root] */
export async function runRenderCurrentSpec(candidate, root = process.cwd(), concurrency = 4) {
  if (!candidate) {
    console.error("Usage: node scripts/contractSkew/renderCurrentSpec.mjs <output.json>");
    return 2;
  }
  /** @type {string[]} */
  const cleanup = [];
  try {
    const output = resolveInside(root, candidate, "current spec output");
    // Check the existing parent too: a missing leaf can hide a junction escape.
    resolveInside(root, path.dirname(output), "current spec output directory");
    cleanup.push(output);
    const temporary = resolveInside(root, `${output}.tmp`, "temporary current spec");
    cleanup.push(temporary);
    // Never let a previous run's complete file survive a failed render.
    fs.rmSync(output, { force: true });
    fs.rmSync(temporary, { force: true });
    const spec = await renderCurrentSpec(path.resolve(root), concurrency);
    // Exclusive creation also refuses a dangling symlink introduced after resolution.
    fs.writeFileSync(temporary, JSON.stringify(spec), { flag: "wx" });
    fs.renameSync(temporary, output);
    console.log(`Current spec rendered: ${spec.functions.length} registered functions (native exportArgs; no handlers invoked).`);
    return 0;
  } catch {
    removeFailedOutput(cleanup);
    console.error("Current spec unavailable: native render failed; no current evidence will be used.");
    return 1;
  }
}

/** @param {string[]} files */
function removeFailedOutput(files) {
  for (const file of files) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      console.error("Current spec cleanup failed; discard current evidence.");
    }
  }
}

if (isRunDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  const valid = args.length === 1 || (args.length === 3 && args[1] === "--concurrency" && /^[1-9]\d?$/.test(args[2]));
  if (!valid) process.exit(2);
  process.exit(await runRenderCurrentSpec(args[0], process.cwd(), Number(args[2] ?? 4)));
}
