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
import { indexAllNamed, normalizeIdentifier } from "./specIndex.mjs";
import { validatorTree, compareNode } from "./contractTree.mjs";

/**
 * What KIND of Convex function each hook / SDK method can call (CS2-2). The
 * backend refuses a `useQuery` of a mutation exactly as firmly as an unknown
 * field, so a mismatch is a PROVEN break, not an unknown.
 *
 * ⚠️ A `via` absent from this table is not checked for type — it is never
 * guessed. Visibility is checked for every call regardless.
 */
export const EXPECTED_FUNCTION_TYPE = {
  useQuery: "Query", usePaginatedQuery: "Query", useQueries: "Query",
  fetchQuery: "Query", preloadQuery: "Query", query: "Query", runQuery: "Query",
  watchQuery: "Query", prewarmQuery: "Query", onUpdate: "Query", consistentQuery: "Query",
  useMutation: "Mutation", mutation: "Mutation", runMutation: "Mutation", fetchMutation: "Mutation",
  useAction: "Action", action: "Action", runAction: "Action", fetchAction: "Action",
};

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
 * Does ONE finding sit on a contract path one of `changed` alters? The single
 * definition of "touches" for the release gate (blockers and break
 * classification both use it).
 *
 * ⚠️ `<function>` IS THE WHOLE FUNCTION, ON EITHER SIDE. A finding at `<function>`
 * (`args: null`, a missing function) has no field path, so any change to that
 * function touches it; a change at `<function>` (a Query -> Mutation flip, args
 * becoming null) alters every call to the function, so it touches every finding
 * on it. Both match on identifier alone. This used to be written twice with the
 * second half of that rule missing from one copy, which let an unproven field
 * ride a function-level change green: it fails closed now.
 *
 * @param {Array<{identifier:string, path:string}>} changed
 * @param {{identifier:string, path:string}} finding
 */
export function touchesChange(changed, finding) {
  return changed.some(
    (change) =>
      change.identifier === finding.identifier &&
      (change.path === "<function>" || finding.path === "<function>" || pathsOverlap(change.path, finding.path))
  );
}

/**
 * Which evidence gaps stand in the way of one candidate release?
 *
 * @param {object} result          a compareContracts() result
 * @param {Array<{identifier:string, path:string}>} changed  contract paths the release alters
 */
export function blockersForRelease(result, changed) {
  const touches = (finding) => touchesChange(changed, finding);
  const blocking = result.needsEvidence.filter(touches);
  // A coverage gap (SPEC-1) is unwaivable and, on a path the release changes, a
  // blocker too. Absent on a plain compareContracts() result in older callers.
  const gaps = (result.gaps ?? []).filter(touches);
  return {
    // A proven break blocks regardless of which paths the release touches.
    blocked: result.breaking.length > 0 || blocking.length > 0 || gaps.length > 0,
    breaking: result.breaking,
    intersectingUnknowns: blocking,
    intersectingGaps: gaps,
    // Everything else is real, tracked, and not this release's problem.
    unrelatedUnknowns: result.needsEvidence.length - blocking.length,
  };
}

/**
 * The identity of a break: WHERE it is and WHAT it is. Two runs of the same
 * client against two specs produce the same key for "the same break", which is
 * what lets a release be compared against what is already live.
 */
export const breakKey = (f) => findingKey(f, BREAK_KEY_FIELDS);

/**
 * A finding's identity over exactly the named fields (an absent `surface` reads
 * as ""). Every dedupe in the control is `findingKey` over its own field list, so
 * the lists stay explicit at each call site and the keying cannot drift.
 *
 * @param {Record<string, any>} f
 * @param {readonly string[]} fields
 */
export const findingKey = (f, fields) =>
  JSON.stringify(fields.map((name) => (name === "surface" ? (f.surface ?? "") : f[name])));

const BREAK_KEY_FIELDS = ["surface", "file", "line", "identifier", "path", "dimension"];

/**
 * SCRUM-178 v2 batch 3 (R1, D-27). A RELEASE IS ANSWERABLE FOR WHAT IT
 * INTRODUCES, MEASURED AGAINST THE SPEC IT WOULD SHIP, NOT THE ONE LIVE TODAY.
 *
 * Release mode used to compare the client only against the DEPLOYED spec and use
 * the candidate just to decide which paths "changed". Every deployed break on a
 * changed path then read as release-introduced: a candidate that FIXES a break
 * (adds the field the client already sends) exited 8, and a candidate that
 * REMOVES a function the client calls exited 0 because the deployed spec still
 * had it. Both inverted.
 *
 * Inputs are the SAME calls compared against both specs:
 *   deployed  compareContracts(calls, deployedSpec)
 *   candidate compareContracts(calls, candidateSpec)
 *
 *   RELEASE BREAK   a candidate break whose identity is not in the deployed
 *                   break set, or one on a path the candidate changed
 *   STANDING        a candidate break also present against the deployed spec, on
 *                   a path the candidate does not change: not this release's
 *   FIXED           a deployed break the candidate no longer has
 *
 * @param {{breaking: any[]}} deployed
 * @param {{breaking: any[]}} candidate
 * @param {Array<{identifier: string, path: string}>} changed
 */
export function classifyRelease(deployed, candidate, changed) {
  // Each break's key is computed once per side, and the changes are bucketed by
  // function so a lookup scans only that function's changes.
  const deployedKeyed = deployed.breaking.map((f) => [f, breakKey(f)]);
  const candidateKeyed = candidate.breaking.map((f) => [f, breakKey(f)]);
  const deployedKeys = new Set(deployedKeyed.map(([, key]) => key));
  const candidateKeys = new Set(candidateKeyed.map(([, key]) => key));
  const changedByFunction = new Map();
  for (const change of changed) {
    const bucket = changedByFunction.get(change.identifier);
    if (bucket) bucket.push(change);
    else changedByFunction.set(change.identifier, [change]);
  }
  const releaseBreaks = [];
  const standingAgainstBoth = [];
  for (const [f, key] of candidateKeyed) {
    if (!deployedKeys.has(key) || touchesChange(changedByFunction.get(f.identifier) ?? [], f)) releaseBreaks.push(f);
    else standingAgainstBoth.push(f);
  }
  const fixedByCandidate = deployedKeyed.filter(([, key]) => !candidateKeys.has(key)).map(([f]) => f);
  return { releaseBreaks, standingAgainstBoth, fixedByCandidate };
}

export const SEVERITY = {
  BREAKING: "BREAKING",
  SHAPE_UNKNOWN: "SHAPE_UNKNOWN",
  TYPE_UNKNOWN: "TYPE_UNKNOWN",
  COVERAGE_GAP: "COVERAGE_GAP",
};

/**
 * @param {Array} clientCalls  from extractClientCalls()
 * @param {object} spec        parsed `convex function-spec --prod` output
 */
export function compareContracts(clientCalls, spec, extraUnresolved = []) {
  const byId = indexAllNamed(spec);
  /** identifier(normalized) -> spec entry (public AND internal: see the visibility check below) */
  const normalized = new Map();
  for (const [id, fn] of byId) normalized.set(normalizeIdentifier(id), fn);

  const findings = [];

  /** A break on the function itself (visibility, kind), carrying the baseline's site keys. */
  const breakAtFunction = (call, detail) =>
    findings.push({
      severity: SEVERITY.BREAKING,
      dimension: "SHAPE",
      identifier: call.identifier,
      path: "<function>",
      file: call.file,
      line: call.line,
      siteId: call.siteId,
      surface: call.surface,
      detail,
    });

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
        siteId: call.siteId,
        surface: call.surface,
        detail: "the live deployment exposes no such function",
      });
      continue;
    }

    // ⚠️ EXISTING IS NOT CALLABLE. An `internal` function is in the spec but not
    // reachable from a client: the generated `api` never exposes it, so a
    // reference reaching it is a stale or hand-built one, and the backend
    // refuses it.
    if (fn.visibility?.kind !== "public") {
      breakAtFunction(
        call,
        `the live deployment's function is ${fn.visibility?.kind ?? "of unknown"} visibility, not public, so a client cannot call it`,
      );
      continue;
    }
    const expectedType = call.via ? EXPECTED_FUNCTION_TYPE[call.via] : undefined;
    if (expectedType && fn.functionType !== expectedType) {
      breakAtFunction(
        call,
        `\`${call.via}\` calls a ${expectedType}, but the live deployment's function is a ${fn.functionType}`,
      );
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
    // `siteId` and `surface` are what the needs-evidence baseline keys on: a
    // finding is identified by WHERE it is, not by how many there are.
    const site = {
      identifier: call.identifier,
      file: call.file,
      line: call.line,
      siteId: call.siteId,
      surface: call.surface,
    };
    // ⚠️ `args: null` (SPEC-1) IS A FUNCTION WE KNOW NOTHING ABOUT, NOT ONE THAT
    // ACCEPTS ANYTHING. A call to it is an unwaivable coverage gap: not BREAKING
    // (nothing proven), not a baselinable unknown. A function nobody calls never
    // reaches this line, so it costs nothing. Absent `args` is treated the same
    // here as defence in depth; `specProblems` already refuses such a document.
    if (fn.args === null || fn.args === undefined) {
      findings.push({
        severity: SEVERITY.COVERAGE_GAP,
        dimension: "SHAPE",
        identifier: call.identifier,
        path: "<function>",
        file: call.file,
        line: call.line,
        siteId: call.siteId,
        surface: call.surface,
        detail: "the backend declares no argument validator for this function (`args: null`), so this call is NOT verified",
      });
      continue;
    }
    const walked = compareNode(call.payload, validatorTree(fn.args), "", {
      site,
      frameworkSupplied,
    });
    findings.push(...walked.findings);
  }

  const breaking = findings.filter((f) => f.severity === SEVERITY.BREAKING);
  // Gaps are NOT evidence to be baselined: they are kept out of `needsEvidence`
  // so they can never be waived, and reported on their own list.
  const gaps = findings.filter((f) => f.severity === SEVERITY.COVERAGE_GAP);
  const needsEvidence = findings.filter(
    (f) => f.severity !== SEVERITY.BREAKING && f.severity !== SEVERITY.COVERAGE_GAP
  );

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
    : needsEvidence.length || gaps.length || coverage.clientCallSitesUnresolved > 0
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
    gaps,
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
