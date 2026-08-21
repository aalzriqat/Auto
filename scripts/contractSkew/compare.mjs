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
import { indexSpec, normalizeIdentifier } from "./specIndex.mjs";
import { validatorTree, compareNode } from "./contractTree.mjs";

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

    // ⚠️ A SKIPPED QUERY TRANSMITS NOTHING, so neither direction applies — but
    // the function-existence check above still does. `useQuery(fn, "skip")`
    // referencing a function the backend no longer exposes is a defect waiting
    // for the day the condition flips.
    if (call.skipped) continue;

    // ⚠️ THE FRAMEWORK SUPPLIES SOME ARGUMENTS, NOT THE CALLER.
    //
    // `usePaginatedQuery(api.x.list, { orgId }, { initialNumItems })` never
    // passes `paginationOpts` — the Convex React client injects it. Demanding it
    // from the caller produced 159 of 167 BREAKING findings on the second
    // whole-repo run: a fabricated outage across every paginated list in the
    // app, and precisely the kind of noise that gets a control switched off.
    const frameworkSupplied =
      call.via === "usePaginatedQuery"
        ? (p) => p === "paginationOpts" || p.startsWith("paginationOpts.")
        : () => false;

    // ⚠️ ONE TREE WALK, BOTH DIRECTIONS. The two questions — "does the client
    // send something undeclared" and "does the backend require something the
    // client omits" — are asked of the SAME node, which is why they can no
    // longer disagree about what a node is. The flat model asked them of two
    // different path maps and had to re-derive structure from strings at each,
    // which is where the array-element blind spot and the union merge came
    // from.
    const site = { identifier: call.identifier, file: call.file, line: call.line };
    const walked = compareNode(call.payload, validatorTree(fn.args), "", {
      site,
      frameworkSupplied,
    });
    findings.push(...walked.findings);
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
        "HTTP action request bodies (they carry no argument validator in the function spec, being keyed by path+method). Also DEFERRED Convex-to-Convex calls — `ctx.scheduler.runAfter`/`runAt` persist a function reference and arguments to be validated at EXECUTION time, so a deploy landing between enqueue and execution can have an already-queued call rejected. Synchronous `ctx.runMutation`/`runQuery`/`runAction` are safe (same transaction, same bundle) and are excluded deliberately; the scheduler forms are not, and are simply out of scope. Finally, a client value the TYPE SYSTEM cannot narrow (an `any`, an index signature, a value crossing a cast) is reported as an UNKNOWN rather than checked — that is coverage the control does not have, stated rather than hidden",
      previouslyNotCovered:
        "DISCRIMINATED OBJECT UNIONS were out of scope while the comparator flattened a validator into one path map: a payload combining fields from mutually exclusive branches (`{type:\"CASH\", cardNumber:\"...\"}` against `v.union(v.object({type:v.literal(\"CARD\"),cardNumber:...}), v.object({type:v.literal(\"CASH\")}))`) was checked per-path and read as compatible although Convex rejects it. They ARE covered now: a union is satisfied by ONE branch, and the client is compared against each branch in turn"
    },
  };
}
