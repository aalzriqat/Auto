/**
 * Whole-repo baseline: what can this detector actually prove today?
 *
 * ⚠️ READ-ONLY IN EVERY SENSE. It reads client source and a saved copy of the
 * live function spec. It changes no client code, and it does not "fix" an
 * inconvenient number by relaxing a rule — a detector tuned until it reports
 * PASS is worth less than no detector, because it also reports PASS on the day
 * something is actually broken.
 *
 * Output is grouped by CAUSE on purpose. A bare "N unresolved" is not
 * actionable; "N unresolved, of which most are one wrapper hook" points at a
 * single fix. The causes also differ in kind: a destructured binding is a limit
 * of this extractor, while a dynamically chosen function identity may not be
 * statically analysable at all.
 *
 *   node scripts/contractSkew/baseline.mjs <spec.json> [--json out.json]
 */
import fs from "node:fs";
import { extractClientCalls } from "./clientPaths.mjs";
import { compareContracts } from "./compare.mjs";
import { CLIENT_SURFACES, listSurfaceFiles } from "./clientFiles.mjs";
import { fetchDeployedSpec } from "./fetchSpec.mjs";

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: baseline.mjs <function-spec.json> [--json out.json]");
  process.exit(2);
}

const root = process.cwd();

// One program per surface: the web app and the mobile app are typed by
// different tsconfigs, and typing either under the other's config resolves
// against the wrong lib and answers confidently from the wrong types.
const calls = [];
const unresolvedBinders = [];
let diagnosticsCount = 0;
let files = [];
for (const surface of CLIENT_SURFACES) {
  const surfaceFiles = listSurfaceFiles(root, surface);
  if (surfaceFiles.length === 0) continue;
  console.error(`scanning ${surfaceFiles.length} ${surface.name} files…`);
  const extracted = extractClientCalls(surfaceFiles, surface.tsconfig);
  calls.push(...extracted.calls);
  unresolvedBinders.push(...extracted.unresolvedBinders);
  diagnosticsCount += extracted.diagnosticsCount;
  files = files.concat(surfaceFiles);
}
// Routed through the same bounded loader the CLI uses, rather than reading an
// arbitrary argv path straight off the filesystem. One way to obtain a spec
// means one place where "which deployment is this actually from?" is answered.
const loaded = fetchDeployedSpec({ specFile: specPath });
if (!loaded.ok) {
  console.error(`could not load ${specPath}: ${loaded.reason}`);
  process.exit(3);
}
const spec = loaded.spec;
const result = compareContracts(calls, spec, unresolvedBinders);

// ── Classify every RESOLVED call site by how it was resolved, so the
//    "resolved" number is not a black box either.
const resolvedByCause = { DIRECT: [], AS_ANY_STRIPPED: [] };
for (const call of calls) {
  (call.casts?.length ? resolvedByCause.AS_ANY_STRIPPED : resolvedByCause.DIRECT).push(call);
}

const unresolvedByCause = {};
for (const binder of unresolvedBinders) {
  (unresolvedByCause[binder.cause] ??= []).push(binder);
}

const opaqueKeys = result.needsEvidence.filter((f) => f.severity === "SHAPE_UNKNOWN");
const opaqueValues = result.needsEvidence.filter((f) => f.severity === "TYPE_UNKNOWN");

const report = {
  verdict: result.verdict,
  alert: result.alert,
  coverage: result.coverage,
  scope: result.scope,
  semanticDiagnostics: diagnosticsCount,
  breakdown: {
    directUseMutationResolved: resolvedByCause.DIRECT.length,
    asAnyStrippedAndResolved: resolvedByCause.AS_ANY_STRIPPED.length,
    customHookWrapperUnresolved: (unresolvedByCause.WRAPPER_RETURN ?? []).length,
    destructuredOrReexportedUnresolved: (unresolvedByCause.DESTRUCTURED_BINDING ?? []).length,
    dynamicIdentityUnresolved: (unresolvedByCause.DYNAMIC_IDENTITY ?? []).length,
    inlineUseUnresolved: (unresolvedByCause.INLINE_USE ?? []).length,
    otherUnresolved: (unresolvedByCause.OTHER_UNRESOLVED ?? []).length,
    opaqueObjectKeyShape: opaqueKeys.length,
    opaqueScalarValueType: opaqueValues.length,
  },
  breaking: result.breaking,
  locations: {
    unresolved: unresolvedBinders.map((b) => ({
      cause: b.cause,
      identifier: b.identifier,
      at: `${b.file}:${b.line}`,
    })),
    opaqueObjectKeyShape: opaqueKeys.map((f) => ({
      identifier: f.identifier,
      path: f.path,
      at: `${f.file}:${f.line}`,
    })),
    opaqueScalarValueType: opaqueValues.map((f) => ({
      identifier: f.identifier,
      path: f.path,
      at: `${f.file}:${f.line}`,
    })),
    asAnyStripped: resolvedByCause.AS_ANY_STRIPPED.flatMap((c) =>
      c.casts.map((cast) => ({ identifier: c.identifier, cast, at: `${c.file}:${c.line}` }))
    ),
  },
};

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
  fs.writeFileSync(process.argv[jsonFlag + 1], JSON.stringify(report, null, 2));
}

console.log(JSON.stringify({ ...report, locations: undefined }, null, 2));
console.error(
  `\nverdict=${report.verdict}  productionSkewAlert=${report.alert.productionSkew}  coverageWarning=${report.alert.coverageWarning}`
);
