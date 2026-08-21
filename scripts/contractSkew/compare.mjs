/**
 * Compare what the client SENDS against what the live backend DECLARES.
 *
 * ⚠️ TWO INDEPENDENT DIMENSIONS. Collapsing them is the mistake that would make
 * this control lie in one direction or scream in the other:
 *
 *   SHAPE — can a key reach the backend that the backend does not declare?
 *       declared path                  -> key-safe
 *       undeclared path                -> BREAKING
 *       opaque KEYS (any/index sig)
 *         where a nested shape is declared -> SHAPE_UNKNOWN (needs evidence)
 *
 *   VALUE — can a value reach the backend that the backend would reject?
 *       statically compatible          -> safe
 *       statically incompatible        -> BREAKING
 *       `any` / unresolvable           -> TYPE_UNKNOWN (NOT fully verified)
 *
 * A known key carrying an `any` value is the case that proves the split is
 * needed. It cannot hide an undeclared field, so it is shape-safe — but a
 * runtime `make: 123` against `v.string()` is refused by Convex exactly as
 * firmly as an unknown field is. Reporting that as PASS would be a false claim
 * of verification; reporting it as BREAKING would bury the real findings. It is
 * neither, and it says so.
 *
 * ⚠️ SCOPE BOUNDARY, stated in the output rather than assumed by the reader:
 * this covers Convex function argument validators only. HTTP actions carry no
 * argument validator in the function spec (they are keyed by path+method), so
 * webhook request-body contracts are NOT covered by this control.
 */
import { declaredPaths, underDynamicPrefix, indexSpec, normalizeIdentifier } from "./declaredPaths.mjs";

/**
 * Does an evidence gap block a specific candidate release?
 *
 * ⚠️ LEGACY UNKNOWNS MUST NOT BLOCK EVERY RELEASE. The repo's honest steady
 * state is UNKNOWN — 86 paths whose values or keys are opaque, inherent to
 * `any`-typed client code. Treating that as a permanent red light would make
 * the control an obstacle rather than a check, and it would be switched off.
 *
 * But an UNKNOWN that overlaps the contract path a release is CHANGING is
 * different: there, "we cannot prove compatibility" is precisely the question
 * being asked, and the answer is not yet.
 *
 * ⚠️ PATH-SENSITIVE, NOT FUNCTION-SENSITIVE. Blocking on the function alone
 * would let one opaque corner of a big mutation freeze every unrelated change
 * to it. Overlap means equality, or an ancestor/descendant relationship:
 *
 *   UNKNOWN at vehicles[*]                    BLOCKS a change to vehicles[*].rowId
 *     (the opaque region contains the changed field)
 *   UNKNOWN at vehicles[*].rowId              BLOCKS a change to vehicles[*]
 *     (the change contains the opaque region)
 *   UNKNOWN at vehicles[*].valuations[*]      does NOT block vehicles[*].rowId
 *     (siblings — neither contains the other)
 */
/** `profile.bio` -> `profile`; `vehicles[*].rowId` -> `vehicles[*]`; a root field -> empty. */
function parentPathOf(path) {
  const dot = path.lastIndexOf(".");
  const bracket = path.lastIndexOf("[*]");
  if (bracket !== -1 && bracket > dot && bracket + 3 === path.length) return path.slice(0, bracket);
  return dot === -1 ? "" : path.slice(0, dot);
}

export function pathsOverlap(a, b) {
  // ⚠️ `<root>` is not a path, it is "the whole payload is unresolvable". It
  // therefore overlaps EVERY path — and it must, because it is the most
  // uncertain state the extractor can report. Treating it as an ordinary
  // string made it overlap nothing, so the one case where we know least about
  // what a client sends was the one case the release gate ignored: a candidate
  // could change any contract on that function and ship green. Scoping to the
  // right function is still the caller's job, and remains so.
  const ROOT = "<root>";
  if (a === ROOT || b === ROOT) return true;
  if (a === b) return true;
  const isDescendant = (child, ancestor) =>
    child.startsWith(`${ancestor}.`) || child.startsWith(`${ancestor}[`);
  return isDescendant(a, b) || isDescendant(b, a);
}

/**
 * Which evidence gaps stand in the way of one candidate release?
 *
 * @param {object} result          a compareContracts() result
 * @param {Array<{identifier:string, path:string}>} changed  contract paths the release alters
 */
export function blockersForRelease(result, changed) {
  const blocking = result.needsEvidence.filter((finding) =>
    changed.some(
      (change) =>
        change.identifier === finding.identifier && pathsOverlap(change.path, finding.path)
    )
  );
  return {
    // A proven break blocks regardless of which paths the release touches.
    blocked: result.breaking.length > 0 || blocking.length > 0,
    breaking: result.breaking,
    intersectingUnknowns: blocking,
    // Everything else is real, tracked, and not this release's problem.
    unrelatedUnknowns: result.needsEvidence.length - blocking.length,
  };
}

export const SEVERITY = {
  BREAKING: "BREAKING",
  SHAPE_UNKNOWN: "SHAPE_UNKNOWN",
  TYPE_UNKNOWN: "TYPE_UNKNOWN",
};

/** Convex validator kind -> the coarse client kinds that satisfy it. */
const COMPATIBLE = {
  string: new Set(["string", "union", "unresolved"]),
  number: new Set(["number", "union", "unresolved"]),
  float64: new Set(["number", "union", "unresolved"]),
  int64: new Set(["number", "bigint", "union", "unresolved"]),
  boolean: new Set(["boolean", "union", "unresolved"]),
  id: new Set(["string", "union", "unresolved"]),
  bytes: new Set(["object", "union", "unresolved"]),
  null: new Set(["null", "union", "unresolved"]),
  literal: new Set(["string", "number", "boolean", "union", "unresolved"]),
  union: new Set(["string", "number", "boolean", "object", "array", "union", "null", "unresolved"]),
  object: new Set(["object", "union", "unresolved"]),
  array: new Set(["array", "union", "unresolved"]),
};

/** Kinds that carry nested keys — an opaque value here can hide a field. */
const NESTED_KINDS = new Set(["object", "array"]);

/**
 * @param {Array} clientCalls  from extractClientCalls()
 * @param {object} spec        parsed `convex function-spec --prod` output
 */
export function compareContracts(clientCalls, spec, extraUnresolved = []) {
  const byId = indexSpec(spec);
  /** identifier(normalized) -> spec entry */
  const normalized = new Map();
  for (const [id, fn] of byId) normalized.set(normalizeIdentifier(id), fn);

  const findings = [];

  for (const call of clientCalls) {
    const fn = normalized.get(call.identifier);
    if (!fn) {
      // The client references a function the live backend does not expose at
      // all. That is the most severe shape of this defect: not a field
      // mismatch but a missing endpoint.
      findings.push({
        severity: SEVERITY.BREAKING,
        dimension: "SHAPE",
        identifier: call.identifier,
        path: "<function>",
        file: call.file,
        line: call.line,
        detail: "the live deployment exposes no such function",
      });
      continue;
    }

    const { paths: declared, dynamicPrefixes } = declaredPaths(fn.args);
    const unknownSet = new Set(call.unknowns.map((u) => u.replace(/ \(max depth\)$/, "")));

    // ── Direction 1: the client sends something the backend does not declare.
    for (const [sentPath, sentInfo] of call.sent) {
      if (declared.has(sentPath)) {
        // Shape is fine. Now the value dimension, kept separate on purpose.
        const declaredKind = declared.get(sentPath).kind;
        const clientKind = sentInfo.valueKind;

        if (clientKind === "any") {
          const nestedDeclared = NESTED_KINDS.has(declaredKind);
          findings.push({
            severity: nestedDeclared ? SEVERITY.SHAPE_UNKNOWN : SEVERITY.TYPE_UNKNOWN,
            dimension: nestedDeclared ? "SHAPE" : "VALUE",
            identifier: call.identifier,
            path: sentPath,
            file: call.file,
            line: call.line,
            detail: nestedDeclared
              ? `value is \`any\` where the backend declares ${declaredKind}: undeclared keys could hide inside it`
              : `key is declared (${declaredKind}) but the value is \`any\`: shape-safe, value NOT verified`,
          });
          continue;
        }

        // ── Literal unions: assignability is NOT verification.
        //
        // `v.union(v.literal("CASH"), v.literal("CHEQUE"))` and a client typed
        // `string` are both "strings", and a coarse kind check calls that a
        // match — while `"MAYBE"` is refused at runtime. Verification here
        // means the client's possible values are provably a SUBSET of the
        // accepted set; anything wider is unproven, not safe.
        const accepted = declared.get(sentPath).literals;
        if (accepted) {
          const clientValues = sentInfo.literals;
          if (!clientValues) {
            findings.push({
              severity: SEVERITY.TYPE_UNKNOWN,
              dimension: "VALUE",
              identifier: call.identifier,
              path: sentPath,
              file: call.file,
              line: call.line,
              detail: `backend accepts only [${[...accepted].join(", ")}]; the client type is wider than an enumeration, so the value is NOT verified`,
            });
            continue;
          }
          const offending = [...clientValues].filter((v) => !accepted.has(v));
          if (offending.length) {
            findings.push({
              severity: SEVERITY.BREAKING,
              dimension: "VALUE",
              identifier: call.identifier,
              path: sentPath,
              file: call.file,
              line: call.line,
              detail: `client can send [${offending.join(", ")}]; backend accepts only [${[...accepted].join(", ")}]`,
            });
          }
          continue; // provable subset -> verified
        }

        const allowed = COMPATIBLE[declaredKind];
        if (allowed && !allowed.has(clientKind)) {
          findings.push({
            severity: SEVERITY.BREAKING,
            dimension: "VALUE",
            identifier: call.identifier,
            path: sentPath,
            file: call.file,
            line: call.line,
            detail: `client sends ${clientKind} where the backend declares ${declaredKind}`,
          });
        }
        continue;
      }

      if (underDynamicPrefix(sentPath, dynamicPrefixes)) continue;

      // A path under something we could not resolve is not proof of a bug —
      // report it as needing evidence rather than as a defect.
      const parentOpaque = [...unknownSet].some(
        (u) => u !== "<root>" && (sentPath.startsWith(`${u}.`) || sentPath.startsWith(`${u}[`))
      );
      // ⚠️ BREAKING REQUIRES PROOF OF TRANSMISSION, NOT TYPE MEMBERSHIP.
      //
      // An OPTIONAL property of a shared type may never be assigned at this
      // call site, in which case Convex never sees it and there is no defect.
      // The first whole-repo run called thirteen such fields BREAKING; every
      // one was type membership rather than evidence. So only an explicit
      // literal, a resolvable spread, or a non-optional resolved property
      // counts as proof — anything weaker is uncertainty, and says so.
      const provenance = sentInfo.provenance ?? "TYPE_OPTIONAL";
      const transmissionProven =
        provenance === "LITERAL" || provenance === "SPREAD" || provenance === "TYPE_REQUIRED";

      findings.push({
        severity: parentOpaque || !transmissionProven ? SEVERITY.SHAPE_UNKNOWN : SEVERITY.BREAKING,
        dimension: "SHAPE",
        identifier: call.identifier,
        path: sentPath,
        file: call.file,
        line: call.line,
        provenance,
        detail: parentOpaque
          ? "sent under an opaque parent; cannot prove the backend accepts it"
          : !transmissionProven
            ? `the live backend declares no such field, but this path is only an OPTIONAL member of the payload type (${provenance}) — it may never be assigned, so transmission is unproven`
            : "the live backend declares no such field — Convex rejects undeclared fields",
      });
    }

    // ── Direction 2: the backend REQUIRES something the client never sends.
    // This is the #227 shape seen from the other side, and it is how a backend
    // deployed AHEAD of its frontend breaks.
    // ⚠️ THE FRAMEWORK SUPPLIES SOME ARGUMENTS, NOT THE CALLER.
    //
    // `usePaginatedQuery(api.x.list, { orgId }, { initialNumItems })` never
    // passes `paginationOpts` — the Convex React client injects it. Demanding it
    // from the caller produced 159 of 167 BREAKING findings on the second
    // whole-repo run: a fabricated outage across every paginated list in the
    // app, and precisely the kind of noise that gets a control switched off.
    const frameworkSupplied =
      call.via === "usePaginatedQuery" ? (p) => p === "paginationOpts" || p.startsWith("paginationOpts.") : () => false;

    for (const [declaredPath, info] of declared) {
      if (frameworkSupplied(declaredPath)) continue;
      if (declaredPath.includes("[*]")) continue; // element fields are covered by the array itself
      if (call.sent.has(declaredPath)) continue;
      if (unknownSet.has("<root>")) continue; // whole payload opaque; reported once below

      let detail = "the live backend requires this field and the client does not send it";

      if (info.optional) {
        // A CONDITIONAL requirement. Optionality is inherited so that a
        // required field inside an OMITTED optional parent is not demanded
        // of the payload - without that, four fabricated BREAKING findings
        // appeared on the first whole-repo run. But the backend still
        // demands the field when the parent IS present, and collapsing the
        // two questions meant `profile: v.optional(v.object({ bio:
        // v.string() }))` reported a clean PASS for a client sending
        // `{ profile: {} }`, which Convex rejects outright.
        //
        // So it is demanded only where the demand is PROVABLE: the client
        // proves it sends the parent, and the parent shape was resolved.
        // An omitted parent, a merely-possible one, or an opaque one all
        // stay silent - type membership is not proof of transmission.
        if (!info.requiredWithinParent) continue;
        const parent = parentPathOf(declaredPath);
        if (!parent) continue;
        const parentSent = call.sent.get(parent);
        if (!parentSent || parentSent.provenance === "TYPE_OPTIONAL") continue;
        if (unknownSet.has(parent)) continue;
        detail =
          "the client sends this optional object but omits a field the live backend requires inside it";
      }

      findings.push({
        severity: SEVERITY.BREAKING,
        dimension: "SHAPE",
        identifier: call.identifier,
        path: declaredPath,
        file: call.file,
        line: call.line,
        detail,
      });
    }

    if (unknownSet.has("<root>")) {
      findings.push({
        severity: SEVERITY.SHAPE_UNKNOWN,
        dimension: "SHAPE",
        identifier: call.identifier,
        path: "<root>",
        file: call.file,
        line: call.line,
        detail: "the whole payload is opaque (`any`); nothing about this call is verified",
      });
    }
  }

  const breaking = findings.filter((f) => f.severity === SEVERITY.BREAKING);
  const needsEvidence = findings.filter((f) => f.severity !== SEVERITY.BREAKING);

  // ── Coverage. A verdict without a denominator is not a verdict.
  //
  // "PASS" from a scan that silently skipped the call sites it could not parse
  // is the exact failure this control exists to prevent, one level up: a green
  // report standing in for work never done. So an unresolved call site is a
  // first-class coverage gap, it is listed with its file and line, and it is
  // enough on its own to deny PASS.
  const resolved = clientCalls.filter((c) => !c.unresolved);
  const unresolved = clientCalls.filter((c) => c.unresolved);
  const coverage = {
    clientCallSitesFound: clientCalls.length + extraUnresolved.length,
    clientCallSitesResolved: resolved.length,
    clientCallSitesUnresolved: unresolved.length + extraUnresolved.length,
    unresolvedSites: [...unresolved, ...extraUnresolved].map((c) => ({
      identifier: c.identifier ?? "<unresolved>",
      file: c.file,
      line: c.line,
      reason: c.unresolved ?? c.reason ?? "payload could not be resolved statically",
    })),
  };

  // ── Run-level verdict.
  //
  //   FAIL    at least one BREAKING finding
  //   UNKNOWN no BREAKING, but some coverage gap or unproven value remains
  //   PASS    zero BREAKING and coverage complete for every in-scope call site
  //
  // UNKNOWN exists so that "we missed a wrapper" can never render as green.
  const verdict = breaking.length
    ? "FAIL"
    : needsEvidence.length || coverage.clientCallSitesUnresolved > 0
      ? "UNKNOWN"
      : "PASS";

  // ── Verdict is not the same thing as alert severity.
  //
  // ⚠️ Conflating them would make this control untrustworthy in its first week.
  // UNKNOWN means "this control could not prove compatibility here" — a fact
  // about the DETECTOR's reach. Paging someone with "production is
  // incompatible" because a custom hook could not be followed is a false
  // outage, and a monitor that cries outage gets muted, which leaves the real
  // BREAKING case unwatched.
  //
  // So exactly one condition is an incident: a proven BREAKING skew.
  const alert = {
    productionSkew: breaking.length > 0,
    coverageWarning: verdict === "UNKNOWN",
    summary: breaking.length
      ? `PRODUCTION SKEW: ${breaking.length} client field(s) the live backend would refuse`
      : verdict === "UNKNOWN"
        ? `coverage warning: compatibility not proven for ${coverage.clientCallSitesUnresolved} call site(s) and ${needsEvidence.length} path(s) — this is control health, NOT a confirmed outage`
        : `compatible: ${coverage.clientCallSitesResolved}/${coverage.clientCallSitesFound} call sites proven against the live deployment`,
  };

  return {
    verdict,
    alert,
    findings,
    breaking,
    needsEvidence,
    coverage,
    scope: {
      covered: "Convex function argument validators (queries, mutations, actions)",
      notCovered:
        "DISCRIMINATED OBJECT UNIONS — branches are flattened into one path map, so a payload combining fields from different branches (`{type:\"CASH\", cardNumber:\"...\"}` against `v.union(v.object({type:v.literal(\"CARD\"),cardNumber:...}), v.object({type:v.literal(\"CASH\")}))`) is checked per-path and reads as compatible although Convex rejects it. One such union exists in the live spec today. Also: HTTP action request bodies (no argument validator in the function spec), and DEFERRED Convex-to-Convex calls — `ctx.scheduler.runAfter`/`runAt` persist a function reference and arguments to be validated at EXECUTION time, so a deploy landing between enqueue and execution can have an already-queued call rejected. Synchronous `ctx.runMutation`/`runQuery`/`runAction` are safe (same transaction, same bundle) and are excluded deliberately; the scheduler forms are not, and are simply out of scope",
    },
  };
}
