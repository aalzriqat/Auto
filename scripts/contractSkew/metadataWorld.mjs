/** One disposable runtime world. Only JSON reaches the parent process. */
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { functionMetadata } from "./currentSpec.mjs";
import { installConstructorGuards, installGlobals } from "./metadataGlobals.mjs";
import { installObservationGuards } from "./metadataObservation.mjs";

// Only the parent's exclusive cwd selects input; argv cannot name another file.
const input = JSON.parse(fs.readFileSync(path.join(process.cwd(), "world.json"), "utf8"));
const write = process.stdout.write.bind(process.stdout);
const finish = process.exit.bind(process);
const state = { reason: "" };
const NativeError = Error;
const ModuleURL = URL;
const runtimeGlobal = globalThis;
const reads = { keys: new Set(), enumerations: 0, capabilityProbes: new Set() };
const deny = (reason) => {
  state.reason ||= reason;
  throw new NativeError("Deployment-dependent module evaluation");
};
const allowed = new Set(input.modules.paths.map((file) => pathToFileURL(file).href));
const forbidden = new Map(Object.entries(input.modules.forbidden).map(([file, reason]) => [pathToFileURL(file).href, reason]));
// The native loader may only resolve files emitted by the reviewed bundler.
// In particular, Node builtins and host node_modules are never evidence.
registerHooks({ resolve(specifier, context, nextResolve) {
  const url = new ModuleURL(specifier, context.parentURL).href;
  if (!allowed.has(url)) return deny("external module");
  if (forbidden.has(url)) return deny(forbidden.get(url));
  return nextResolve(specifier, context);
} });
installConstructorGuards(deny, reads.capabilityProbes);
installGlobals({ target: globalThis, deny, world: input.world, reads });
const verifyErrorShape = installObservationGuards(runtimeGlobal, deny);

/** Exactly one entry and its actual imports run in this fresh realm. */
async function readEntry(entry) {
  if (entry.reason) return { functions: [], reason: entry.reason, keys: [], enumerations: 0, capabilityProbes: [] };
  try {
    const url = pathToFileURL(path.join(input.modules.root, entry.file.replace(/\.[^.]+$/, ".js"))).href;
    const exports = await import(url);
    verifyErrorShape();
    const functions = functionMetadata({ file: entry.file, exports });
    verifyErrorShape();
    return report(state.reason ? [] : functions);
  } catch (error) {
    const message = error instanceof NativeError ? error.message : undefined;
    if (message === "") state.reason ||= "Module evaluation failed";
    const result = report([]);
    if (!state.reason) result.error = typeof message === "string" ? message : "Module evaluation failed";
    return result;
  }
}

function report(functions) {
  return { functions, reason: state.reason, keys: [...reads.keys], enumerations: reads.enumerations,
    capabilityProbes: [...reads.capabilityProbes], error: "" };
}

write(JSON.stringify(await readEntry(input.entry)), () => finish(0));
