import fs from "node:fs";
import path from "node:path";
import { renderCurrentSpec } from "./currentSpec.mjs";
import { isRunDirectly } from "./runDirectly.mjs";

if (isRunDirectly(import.meta.url)) {
  const output = process.argv[2];
  if (!output) {
    console.error("Usage: node scripts/contractSkew/renderCurrentSpec.mjs <output.json>");
    process.exit(2);
  }
  const temporary = `${output}.tmp`;
  try {
    // Never let a previous run's complete file survive a failed render.
    fs.rmSync(output, { force: true });
    const spec = await renderCurrentSpec(path.resolve("."));
    fs.writeFileSync(temporary, JSON.stringify(spec));
    fs.renameSync(temporary, output);
    console.log(`Current spec rendered: ${spec.functions.length} registered functions (native exportArgs; no handlers invoked).`);
    process.exit(0);
  } catch {
    fs.rmSync(output, { force: true });
    fs.rmSync(temporary, { force: true });
    console.error("Current spec unavailable: native render failed; no current evidence will be used.");
    process.exit(1);
  }
}
