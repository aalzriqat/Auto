/**
 * Which contract paths does a candidate release actually change?
 *
 * The release blocker in `compare.mjs` is path-sensitive: an UNKNOWN blocks a
 * release only when it intersects a path that release touches. That is only
 * worth anything if the changed paths are DERIVED. Hand-typing them makes the
 * gate depend on somebody remembering to list the field they just added, which
 * is the same "a person has to remember" failure this whole control exists to
 * remove.
 *
 * So: diff two rendered function specs and report every path whose declaration
 * differs. Rendered specs rather than source, because the spec is Convex's own
 * rendering of the validator — parsing `v.object({...})` out of TypeScript
 * would be a second implementation of someone else's semantics, free to drift
 * from the one that actually runs.
 */
import { declaredPaths, indexSpec, normalizeIdentifier } from "./declaredPaths.mjs";

/**
 * Explicit ordering. Every value sorted here is a string, so the default sort
 * was already deterministic — but a signature is only comparable if its
 * ordering is stated rather than inferred from the call sites, and a literal
 * union can carry numbers as well as strings.
 */
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Stable, comparable description of one declared path. */
function signature(entry) {
  if (!entry) return null;
  // ⚠️ Type-tagged. `.map(String)` alone rendered `v.literal(1)` and
  // `v.literal("1")` identically, so a backend changing one to the other
  // produced NO detected change — the release gate saw nothing to block on and
  // production mode filed the resulting break as a standing defect rather than
  // the revision skew it actually is.
  const literals = entry.literals
    ? [...entry.literals].map((v) => `${typeof v}:${String(v)}`).sort(byText).join("|")
    : "*";
  return `${entry.kind}:${entry.optional ? "opt" : "req"}:${literals}`;
}

function pathsOf(fn) {
  if (!fn || !fn.args) return { paths: new Map(), rootDynamic: true };
  return declaredPaths(fn.args);
}

/**
 * @returns {{identifier: string, path: string, change: string, deployed: string|null, candidate: string|null}[]}
 *   One entry per changed path, in the shape `blockersForRelease` consumes.
 */
export function changedContractPaths(deployedSpec, candidateSpec) {
  const deployed = indexSpec(deployedSpec);
  const candidate = indexSpec(candidateSpec);

  const identifiers = new Set();
  for (const id of deployed.keys()) identifiers.add(normalizeIdentifier(id));
  for (const id of candidate.keys()) identifiers.add(normalizeIdentifier(id));

  // indexSpec keys by the raw identifier; normalize both sides once so
  // `vehicles.js:importBulk` and `vehicles.ts:importBulk` are the same function.
  const byNormalized = (index) => {
    const out = new Map();
    for (const [id, fn] of index) out.set(normalizeIdentifier(id), fn);
    return out;
  };
  const deployedN = byNormalized(deployed);
  const candidateN = byNormalized(candidate);

  const changes = [];
  for (const identifier of [...identifiers].sort(byText)) {
    const before = deployedN.get(identifier);
    const after = candidateN.get(identifier);

    // A function that exists on only one side changes every path it declares.
    // Emitting per-path (rather than a function-level wildcard) keeps the
    // blocker's path arithmetic uniform: there is no second kind of entry that
    // `pathsOverlap` would have to special-case.
    const kind = !before ? "FUNCTION_ADDED" : !after ? "FUNCTION_REMOVED" : null;

    const beforePaths = pathsOf(before).paths;
    const afterPaths = pathsOf(after).paths;

    const allPaths = new Set([...beforePaths.keys(), ...afterPaths.keys()]);
    for (const path of [...allPaths].sort(byText)) {
      const a = signature(beforePaths.get(path));
      const b = signature(afterPaths.get(path));
      if (a === b) continue;
      changes.push({
        identifier,
        path,
        change:
          kind ??
          (a === null
            ? "PATH_ADDED"
            : b === null
              ? "PATH_REMOVED"
              : "PATH_REDECLARED"),
        deployed: a,
        candidate: b,
      });
    }

    // A no-argument function appearing or vanishing declares no paths at all,
    // so the loop above emits nothing. Record it at the root so the change is
    // not silently invisible; `""` overlaps nothing, which is correct — there
    // is no field for a client UNKNOWN to intersect.
    if (kind && allPaths.size === 0) {
      changes.push({ identifier, path: "", change: kind, deployed: null, candidate: null });
    }
  }
  return changes;
}

/** Compact human summary; the detail lives in the JSON report. */
export function summarizeChanges(changes) {
  const byChange = {};
  for (const c of changes) byChange[c.change] = (byChange[c.change] ?? 0) + 1;
  return byChange;
}
