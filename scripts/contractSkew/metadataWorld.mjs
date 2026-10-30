/** One disposable runtime world. Only JSON reaches the parent process. */
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { functionMetadata } from "./currentSpec.mjs";
import { installGlobals } from "./metadataGlobals.mjs";

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const write = process.stdout.write.bind(process.stdout);
const finish = process.exit.bind(process);
const state = { reason: "" };
const reads = { keys: new Set(), enumerations: 0, capabilityProbes: new Set() };
const deny = (reason) => {
  state.reason ||= reason;
  throw Object.assign(new Error("Deployment-dependent module evaluation"), { metadataReason: reason });
};
const allowed = new Set(input.modules.paths.map((file) => pathToFileURL(file).href));
const forbidden = new Map(Object.entries(input.modules.forbidden).map(([file, reason]) => [pathToFileURL(file).href, reason]));
// The native loader may only resolve files emitted by the reviewed bundler.
// In particular, Node builtins and host node_modules are never evidence.
registerHooks({ resolve(specifier, context, nextResolve) {
  const url = new URL(specifier, context.parentURL).href;
  if (!allowed.has(url)) return deny("external module");
  if (forbidden.has(url)) return deny(forbidden.get(url));
  return nextResolve(specifier, context);
} });
installGlobals({ target: globalThis, deny, world: input.world, reads });

/** Imports must be sequential: the denial latch and probe records belong to
 * the active entry, and each world deliberately shares its native ESM cache. */
async function readEntry(entry) {
  state.reason = "";
  reads.keys.clear();
  reads.enumerations = 0;
  reads.capabilityProbes.clear();
  if (entry.reason) return { functions: [], reason: entry.reason, keys: [], enumerations: 0, capabilityProbes: [] };
  try {
    const url = pathToFileURL(path.join(input.modules.root, entry.file.replace(/\.[^.]+$/, ".js"))).href;
    const exports = await import(url);
    const functions = functionMetadata({ file: entry.file, exports });
    if (reads.keys.size > 32) state.reason ||= "environment key budget exceeded";
    return report(state.reason ? [] : functions);
  } catch (error) {
    if (error instanceof Error && "metadataReason" in error && typeof error.metadataReason === "string") {
      state.reason ||= error.metadataReason;
    }
    const result = report([]);
    if (!state.reason) result.error = error instanceof Error ? error.message : "Module evaluation failed";
    return result;
  }
}

function report(functions) {
  return { functions, reason: state.reason, keys: [...reads.keys], enumerations: reads.enumerations,
    capabilityProbes: [...reads.capabilityProbes], error: "" };
}

const results = await input.entries.reduce(async (previous, entry) => {
  const completed = await previous;
  completed.push(await readEntry(entry));
  return completed;
}, Promise.resolve([]));
write(JSON.stringify(results), () => finish(0));
