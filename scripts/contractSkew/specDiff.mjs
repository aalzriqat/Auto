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
import { indexSpec, normalizeIdentifier } from "./specIndex.mjs";
import { validatorTree } from "./contractTree.mjs";

/**
 * Explicit ordering. Every value sorted here is a string, so the default sort
 * was already deterministic — but a signature is only comparable if its
 * ordering is stated rather than inferred from the call sites, and a literal
 * union can carry numbers as well as strings.
 */
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Type-tagged so `v.literal(1)` and `v.literal("1")` are not the same value. */
const tagged = (v) => `${v === null ? "null" : typeof v}:${String(v)}`;

/**
 * A COMPLETE structural fingerprint of a node and everything beneath it.
 *
 * ⚠️ NOTHING HERE DEPENDS ON ORDER. Object fields are sorted because field
 * order carries no meaning, and union BRANCHES are sorted too — see the union
 * case below — because Convex accepts a union if ANY branch matches, so branch
 * position is not semantics either.
 *
 * An earlier version of this comment claimed the opposite, and survived the
 * change that made branches sorted. A stale comment on a security control is
 * worse than none: it instructs the next reader to undo tested behaviour, and
 * the behaviour it would have undone is the one that stops a pure reorder being
 * reported as a redeclaration.
 */
function digest(node) {
  return JSON.stringify(digestValue(node));
}

/**
 * The structured form, before encoding. Arrays and JSON, never hand-joined
 * strings.
 *
 * ⚠️ THE HAND-JOINED VERSION WAS FORGEABLE, found independently by me and by
 * the Claude-family reviewer in the same round. Branch digests were joined with
 * `|` and literal values were interpolated raw, so a literal could embed the
 * delimiters and impersonate a different branch structure:
 *
 *   union([ literal('A)}|{y:s(number') ])        -> "({x:lit(string:A)}|{y:s(number)})"
 *   union([ {x: literal('A')}, {y: number} ])    -> "({x:lit(string:A)}|{y:s(number)})"
 *
 * Byte-identical. The redeclaration was still caught, but only because
 * `collect` records each path's own signature separately and that INDEPENDENT
 * signal happened to differ. Neither of us could reach a false PASS through
 * `changedContractPaths`, and no literal in this repo contains `(`, `)`, `|` or
 * `:` today — but "safe because a second mechanism happens to overlap" is not a
 * property anyone can rely on. A future refactor that removed the redundancy as
 * dead weight would silently make it exploitable.
 *
 * JSON encoding is unambiguous by construction, so the guarantee no longer
 * depends on the redundancy. The redundancy remains, now as defence in depth
 * rather than as the whole defence.
 */
function digestValue(node) {
  switch (node.kind) {
    case "object":
      return [
        "o",
        [...node.fields]
          .map(([name, f]) => [name, Boolean(f.optional), digest(f.node)])
          .sort((a, b) => byText(a[0], b[0])),
      ];
    case "array":
      return ["a", digest(node.element)];
    case "union":
      // Sorted, because branch POSITION is not semantics: Convex accepts a
      // union if ANY branch matches. Sorted on the ENCODED child, so ordering
      // is deterministic without depending on the shape of the value.
      return ["u", node.branches.map(digest).sort(byText)];
    case "literal":
      return ["l", node.value === null ? "null" : typeof node.value, String(node.value)];
    case "scalar":
      return ["s", node.type];
    case "id":
      return ["i", node.table ?? ""];
    default:
      return [node.kind];
  }
}

/**
 * Stable, comparable description of ONE NODE.
 *
 * ⚠️ THIS IS WHERE THE FLAT MODEL FAILED LAST, and the failure is the reason
 * for the redesign rather than another patch. `declaredPaths` grew a
 * `requiredWithinParent` dimension to fix a comparison defect; the signature
 * here was never taught about it, so `changedContractPaths` returned `[]`
 * across a required→optional flip. A real backend change that had not been
 * deployed was then classified as a STANDING DEFECT — "deploying will not fix
 * this" — when the truth was revision skew and deploying was the entire fix.
 * Two consumers of one flat record, and only one of them was updated. Twice.
 *
 * A node signature cannot have that gap: requiredness lives on the FIELD, and
 * the field is where the parent records it, so it is part of this node's own
 * signature by construction. Inherited optionality is a fact about an ANCESTOR
 * path, which carries its own entry.
 */
function signatureOf(node, optional) {
  const head = `${node.kind}:${optional ? "opt" : "req"}`;
  switch (node.kind) {
    case "literal":
      return `${head}:${tagged(node.value)}`;
    case "scalar":
      return `${head}:${node.type}`;
    case "id":
      return `${head}:${node.table ?? ""}`;
    case "union":
      // ⚠️ THE UNION CARRIES A FULL RECURSIVE DIGEST OF ITS BRANCHES, and the
      // reason is a round-1 review finding that disproved this module's own
      // justification. `collect` recurses into branches at the SAME path and
      // merges their signatures into a set, so a field moving from one branch
      // to another left that set byte-identical — same name, type and
      // optionality, different branch. `changedContractPaths` returned [], and
      // `classifyBreaking` then filed a genuine undeployed skew as a STANDING
      // DEFECT: "deploying will not fix this", when deploying was the whole fix.
      //
      // ⚠️ I previously DELETED a union summary here, having "proven" it
      // redundant by a byte-identical whole-repo run. That evidence was real and
      // insufficient: this repo does not contain the shape. Equivalence on
      // today's code is not equivalence, and a positional digest is what the
      // merged set cannot express.
      return `${head}:${digest(node)}`;
    default:
      return head;
  }
}

/**
 * Every declared path of one function, with the signature of the node there.
 *
 * ⚠️ A UNION RECORDS ITS BRANCHES AT ITS OWN PATH, so the branch set is part of
 * that path's signature without the node needing to summarise itself. A branch
 * removed, added or retyped changes the merged string. (Mutation testing proved
 * an explicit summary redundant: neutering it changed no observable answer,
 * which makes it complexity with no reader.)
 *
 * ⚠️ UNION BRANCHES ARE MERGED HERE, DELIBERATELY, and that is sound for this
 * question only. Merging branches is wrong when deciding whether a payload is
 * ACCEPTED — it is what let `{type:"CASH", cardNumber}` satisfy two mutually
 * exclusive branches — but this function asks whether a declaration CHANGED,
 * and a change in any branch changes the merged signature at that path. The
 * paths must stay plain because they are intersected with client finding paths.
 */
function collect(node, path, out, optional) {
  // ⚠️ ACCUMULATE A SET, NEVER A HAND-JOINED STRING.
  //
  // This used to join merged signatures with a bare `&` and split on it to
  // re-read them. Signatures embed literal VALUES, so a literal containing `&`
  // made the merged string ambiguous: the set {"X&Y"} and the set {"X","Y"}
  // both rendered as `X&Y`, and a real redeclaration between those two could
  // not be seen.
  //
  // No false PASS was reachable, because a merged string only occurs under a
  // union and the union node records its own recursive digest at the same path.
  // That is exactly the "safe because a second mechanism happens to overlap"
  // property this file rejects thirty lines above, and the same ambiguity class
  // already found and closed in `digest`. Keeping the parts separate and
  // encoding once removes the question instead of relying on the overlap.
  const bucket = out.get(path);
  const sig = signatureOf(node, optional);
  if (bucket) bucket.add(sig);
  else out.set(path, new Set([sig]));

  if (node.kind === "object") {
    for (const [name, field] of node.fields) {
      collect(field.node, path ? `${path}.${name}` : name, out, field.optional);
    }
  } else if (node.kind === "array") {
    collect(node.element, `${path}[*]`, out, false);
  } else if (node.kind === "union") {
    for (const branch of node.branches) collect(branch, path, out, optional);
  }
}

/**
 * One signature string per path, encoded unambiguously.
 *
 * `collect` accumulates a Set per path; the JSON encoding happens exactly once,
 * here, so no separator can be confused with content. A single signature keeps
 * its plain form, which is what a reader sees in the report for the ordinary
 * case; only a genuinely merged path pays for the encoding.
 *
 * ⚠️ EXPORTED SO ITS PROPERTY CAN BE PINNED DIRECTLY. The ambiguity this closes
 * is NOT reachable through `changedContractPaths`, because the union node's
 * recursive digest at the same path already separates any structural
 * difference. Two mutants proved it: reverting to the `&`-join and removing the
 * sort both left every end-to-end test green. Testing it through that path
 * would be testing nothing — so the injectivity is asserted here, where it is
 * observable, and the integration overlap stays what it is: defence in depth,
 * not the proof.
 */
export function encodeSignatures(set) {
  const parts = [...set].sort(byText);
  // ⚠️ THE PLAIN FORM IS ONLY SAFE WHILE NO SIGNATURE CAN LOOK LIKE THE ENCODED
  // FORM — AND THAT WAS A PROPERTY OF A DIFFERENT FUNCTION. Every signature
  // `signatureOf` produces begins `${node.kind}:`, and every node kind is
  // alphabetic, so none can begin with `[`. That is what made the shortcut
  // safe, and it was held implicitly: add a node kind, or change how a
  // signature renders, and this quietly stops being injective with no test
  // failing anywhere.
  //
  // The guard costs one comparison and makes the function injective on its own
  // terms. Distinct sets now always differ: two plain forms because their
  // contents do, two encoded forms because JSON of a sorted array is
  // injective, and a plain form can never equal an encoded one because only
  // the encoded form starts with `[`.
  if (parts.length === 1 && !parts[0].startsWith("[")) return parts[0];
  return JSON.stringify(parts);
}

function pathsOf(fn) {
  const out = new Map();
  if (!fn || !fn.args) return out;
  const root = validatorTree(fn.args);
  // ⚠️ The ARGUMENT OBJECT ITSELF gets no entry. Convex always renders it as an
  // object, so its own signature can never change, and emitting it would give
  // every altered function a spurious `""` change on top of the real ones —
  // while stealing the one meaning `""` has here: a no-argument function that
  // appeared or vanished, recorded below so it cannot slip out of the report.
  if (root.kind === "object") {
    for (const [name, field] of root.fields) collect(field.node, name, out, field.optional);
  } else {
    collect(root, "", out, false);
  }
  for (const [path, set] of out) out.set(path, encodeSignatures(set));
  return out;
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

    const beforePaths = pathsOf(before);
    const afterPaths = pathsOf(after);

    const allPaths = new Set([...beforePaths.keys(), ...afterPaths.keys()]);
    for (const path of [...allPaths].sort(byText)) {
      const a = beforePaths.get(path) ?? null;
      const b = afterPaths.get(path) ?? null;
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
