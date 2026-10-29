/**
 * Renew reviewed baseline entries ONLY where the code they were reviewed
 * against is provably unchanged (SCRUM-866).
 *
 * Why this exists: every entry in needs-evidence-baseline.json expires, and
 * `evaluateBaseline` fails an expired entry, so the Contract skew monitor goes
 * red and refuses releases. An allow-list entry with an expiry is normally
 * renewed by moving the date and recording why (OSV-Scanner's `ignoreUntil` +
 * `reason`, Trivy's `exp:`); a bulk date bump with no check would turn the
 * expiry into decoration. So an entry is renewed here only when
 *
 *   - its client file,
 *   - its backend module (`convex/<module>.ts` from the functionId),
 *   - every repository file its rationale names, and
 *   - every in-repo file in the transitive import closure of the client file
 *     and of the backend module (`importClosure.mjs`: the TypeScript compiler
 *     with each surface's real tsconfig; `node_modules` and the generated
 *     `convex/_generated` are excluded there, with the reason)
 *
 * are byte-identical (same git blob) between the reviewed revision and HEAD.
 * Anything else, including a file that cannot be compared, is REFUSED and left
 * byte-for-byte untouched, so it keeps expiring until a person reviews it.
 *
 * What a renewal does NOT claim: the fingerprint and cause of the entry are
 * still re-checked against the live backend spec on every monitor run
 * (`evaluateBaseline`); this tool never writes them. The recorded `renewal`
 * text must say where that match was observed.
 *
 * ⚠️ The monitor never writes the baseline and this is not the monitor: it is
 * run by a person, against a revision they name, and its diff is reviewed.
 *
 * --check-evidence has a deliberately NARROWER scope (owner 2026-10-28): the
 * entry's own client file and the declaration file of its backend export only.
 * Re-exports and registered-function aliases resolve via TypeScript symbols;
 * missing/moved modules, missing exports, cycles and unsupported definitions
 * refuse. Entries sharing a client file still resolve their own function.
 * Star re-exports (including intermediate modules), computed forwarded values,
 * direct default export assignments, declaration-only/external targets and
 * syntax errors over-refuse conservatively. Module roots use `.ts` only.
 * A missing current file refuses even if named. Renames need a fresh review;
 * a path absent only at the original base can pass when named and present at
 * the recorded ancestor SHA. Whole-file changes can over-refuse unrelated edits.
 * The recorded SHA comes from `SCRUM-866 round N review against origin/main <sha>` or
 * `<KEY> review of PR #N head <sha>` (REVIEW_REFERENCES); the last one wins.
 * Alternatively the final reference can be `evidence-blobs [["path","blob"],...]`:
 * a JSON array of unique path/40-hex git blob pairs, ending the renewal text.
 * Both required files must have records matching HEAD. This form needs no
 * evidence commit or ancestry, so a squash/rebase cannot invalidate it.
 * --blob-evidence appends this form to mechanically verified renewals. In PR
 * mode (--pr-base), NEW/CHANGED renewal text using a commit must cite an
 * ancestor of that base; unchanged legacy text keeps its existing checks.
 * Wrapper hooks, shared validators, handler helpers, custom registration factory
 * bodies, re-export wiring, resolution/config/dependency changes and runtime
 * loaders are outside this check. Mechanical contract comparison uses exported
 * validators (sharedValidator.test.ts), but UNKNOWN payloads and handler semantics
 * remain limits. Prose truth, review quality, and arbitrary baseline tampering
 * require review; this check proves file coverage/freshness only. Import-closure
 * loader refusals still apply unchanged to mechanical renewal, not this mode.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CLIENT_SURFACES } from "./clientFiles.mjs";
import { assertSafeRevision, isAncestor, resolveCommit, resolveGit, runGitText } from "./gitExecutable.mjs";
import { DEFAULT_BASELINE, EXIT_UNAVAILABLE } from "./baselineIdentity.mjs";
import { parseCanonicalBaseline, resolveInside, serializeBaseline, writeBaselineAtomically } from "./baselineFile.mjs";
import { isRunDirectly } from "./runDirectly.mjs";
import { createImportClosure } from "./importClosure.mjs";
import { identityOf } from "./baseline.mjs";
import { createBackendDefinitionResolver } from "./backendDefinition.mjs";

const MODULE_FUNCTION_ID = /^([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Inputs every closure includes: dependency pins, and the schema (clients reach it only via the excluded generated dataModel).
const IMPLICIT_INPUTS = ["package.json", "pnpm-lock.yaml", "convex/schema.ts"];
const PATH_TOKEN = /[\w@()[\]/.-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|ya?ml)\b/g;

/**
 * Mechanical renewal keeps its existing module-id policy. Evidence attribution
 * resolves nested module paths separately in backendDefinition.mjs.
 * @param {string} functionId
 * @returns {string | undefined}
 */
export function backendModuleOf(functionId) {
  const match = MODULE_FUNCTION_ID.exec(String(functionId));
  return match ? `convex/${match[1]}.ts` : undefined;
}

/**
 * Repository paths named in a rationale. A leading "(" that opens a sentence
 * parenthesis (more "(" than ")") is not part of the path; route groups such
 * as `app/(dashboard)/x.tsx` are balanced and kept.
 *
 * @param {string} rationale
 * @returns {string[]}
 */
export function rationalePaths(rationale) {
  const found = [];
  for (const token of String(rationale).match(PATH_TOKEN) ?? []) {
    let candidate = token;
    while (candidate.startsWith("(") && count(candidate, "(") > count(candidate, ")")) candidate = candidate.slice(1);
    if (!found.includes(candidate)) found.push(candidate);
  }
  return found;
}

const count = (text, char) => text.split(char).length - 1;

/**
 * @param {{ git: string, cwd: string, reviewed: string, head: string }} options
 * @returns {(file: string) => "identical" | "changed" | "missing"}
 *   `missing` = the file is not a blob at one of the two revisions.
 */
export function gitCompare({ git, cwd, reviewed, head }) {
  /** @type {Map<string, string> | undefined} */
  let before;
  /** @type {Map<string, string> | undefined} */
  let after;
  return (file) => {
    before ??= gitBlobs(git, cwd, reviewed);
    after ??= gitBlobs(git, cwd, head);
    const was = before.get(file);
    const now = after.get(file);
    return was === undefined || now === undefined ? "missing" : was === now ? "identical" : "changed";
  };
}

/** @param {string} git @param {string} cwd @param {string} revision @returns {Map<string, string>} */
function gitBlobs(git, cwd, revision) {
  // Read committed objects, not worktree hashes (which may include CRLF/filter differences).
  // https://git-scm.com/docs/git-ls-tree documents -z and object type/name output.
  const out = runGitText(git, ["ls-tree", "-r", "-z", revision], { cwd, maxBuffer: 256 * 1024 * 1024 });
  const blobs = new Map();
  for (const record of out.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, type, id] = record.slice(0, tab).split(" ");
    if (type === "blob") blobs.set(record.slice(tab + 1), id);
  }
  return blobs;
}
const label = (entry) => `${entry.functionId} ${entry.contractPath} @ ${entry.callSiteId}`;

/** @returns {string | undefined} the reason this entry must not be renewed, if any */
function refusalFor(entry, compare, closureOf) {
  const backend = backendModuleOf(entry.functionId);
  if (backend === undefined) return `functionId ${entry.functionId} names no backend module`;
  if (typeof entry.file !== "string" || entry.file.trim() === "") return "entry names no client file";

  /** @returns {string | undefined} why `file` is not provably unchanged; `subject` completes the sentence */
  const differs = (file, subject) => {
    const state = compare(file);
    if (state === "changed") return `${subject} changed since the reviewed revision`;
    if (state === "missing") return `${subject} is missing at the reviewed revision or HEAD`;
    return undefined;
  };

  const direct = differs(entry.file, `client file ${entry.file}`) ?? differs(backend, `backend module ${backend}`);
  if (direct !== undefined) return direct;

  // What the two files import decides what is sent and how it is handled, so it was part of the review.
  for (const [role, file] of [["client file", entry.file], ["backend module", backend]]) {
    const closure = closureOf(file);
    if (closure.unresolved.length > 0) return `cannot resolve in-repo import(s) of ${role} ${file}: ${closure.unresolved.join(", ")}`;
    for (const imported of closure.files) {
      if (imported === file) continue;
      const reason = differs(imported, `${role} ${file} imports ${imported}, which`);
      if (reason !== undefined) return reason;
    }
  }

  for (const named of rationalePaths(entry.rationale)) {
    // A bare name with no directory that is not a tracked file (`result.json`)
    // is a variable or payload name in prose, not a repository path.
    if (compare(named) === "missing" && !named.includes("/")) continue;
    const reason = differs(named, `rationale file ${named}`);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * @param {string} text  the baseline file's text
 * @param {{ compare: (file: string) => "identical" | "changed" | "missing", closureOf: (file: string) => { files: string[], unresolved: string[] }, expires: string, renewal: string, blobEvidenceFor?: (entry: { file: string, functionId: string }) => string }} options
 * @returns {{ text: string, renewed: number, skipped: number, refused: Array<{ index: number, entry: string, reason: string }> }}
 */
export function renewBaseline(text, { compare, closureOf, expires, renewal, blobEvidenceFor }) {
  if (typeof closureOf !== "function") throw new Error("closureOf is required: a renewal without an import closure is refused");
  if (!DATE.test(expires) || Number.isNaN(Date.parse(expires))) throw new Error(`expires must be YYYY-MM-DD, got ${expires}`);
  if (typeof renewal !== "string" || renewal.trim() === "") throw new Error("a non-empty renewal reason is required");

  const document = parseCanonicalBaseline(text);
  if (!document || !Array.isArray(document.entries)) throw new Error("the baseline has no entries array");

  let renewed = 0;
  let skipped = 0;
  /** @type {Array<{ index: number, entry: string, reason: string }>} */
  const refused = [];
  document.entries = document.entries.map((entry, index) => {
    // Never shorten a review, and never renew the same entry twice.
    if (typeof entry?.expires === "string" && entry.expires >= expires) {
      skipped++;
      return entry;
    }
    const reason = refusalFor(entry, compare, closureOf);
    if (reason !== undefined) {
      refused.push({ index, entry: label(entry), reason });
      return entry;
    }
    renewed++;
    return { ...entry, expires, renewal: blobEvidenceFor ? `${renewal}; ${blobEvidenceFor(entry)}` : renewal };
  });

  return { text: serializeBaseline(document, text), renewed, skipped, refused };
}

/**
 * Legacy review references retain group 1. The final recognized reference wins;
 * evidence-blobs has no commit capture and its remaining text is parsed as JSON.
 * `SCRUM-866 round <n> review against origin/main <sha>`, or, for a change reviewed on its own
 * branch before it reaches main, `<JIRA-KEY> review of PR #<n> head <sha>`. Both are followed
 * by an 8-40 digit lowercase hex SHA that must be a verified ancestor of HEAD. The SHA must end the
 * token: only the end of the text, whitespace or `.,;:)]` may follow, so a longer or run-on token
 * is malformed rather than silently truncated to its first 40 digits.
 */
const REVIEW_REFERENCES = [
  /SCRUM-866 round \d+ review against origin\/main ([0-9a-f]{8,40})(?=$|[\s.,;:)\]])/g,
  /\b[A-Z][A-Z0-9]*-\d+ review of PR #\d+ head ([0-9a-f]{8,40})(?=$|[\s.,;:)\]])/g,
  /\bevidence-blobs(?=\s|$)/g,
];

/** @param {string} text */
function lastReviewReference(text) {
  return REVIEW_REFERENCES.flatMap((pattern) => [...text.matchAll(pattern)])
    .sort((a, b) => a.index - b.index).at(-1);
}

/**
 * A marker is recognized even when its records are malformed, so it cannot
 * silently fall back to an older valid commit. Duplicate paths refuse too.
 * @param {string} text @returns {Map<string, string> | undefined}
 */
function parseBlobEvidence(text) {
  try {
    const records = JSON.parse(text);
    if (!Array.isArray(records) || !records.length) return undefined;
    const blobs = new Map();
    for (const record of records) {
      if (!Array.isArray(record) || record.length !== 2 || typeof record[0] !== "string" || !record[0].trim() ||
          typeof record[1] !== "string" || !/^[0-9a-f]{40}$/.test(record[1]) || blobs.has(record[0])) return undefined;
      blobs.set(record[0], record[1]);
    }
    return blobs;
  } catch {
    return undefined;
  }
}

/** @param {string | undefined} text @returns {Map<string, unknown> | undefined} */
function prBaseRenewals(text) {
  if (text === undefined) return undefined;
  const entries = parseCanonicalBaseline(text)?.entries;
  if (!Array.isArray(entries)) throw new Error("the PR base baseline has no entries array");
  const renewals = new Map(entries.map((entry) => [identityOf(entry), entry.renewal]));
  if (renewals.size !== entries.length) throw new Error("the PR base baseline has duplicate identities");
  return renewals;
}

/**
 * @param {string | undefined} reviewHead
 * @param {Map<string, unknown> | undefined} prRenewals
 * @param {Record<string, unknown>} entry
 * @param {((sha: string) => void) | undefined} requireCommitOnPrBase
 */
function requirePrBaseReview(reviewHead, prRenewals, entry, requireCommitOnPrBase) {
  if (!reviewHead || !prRenewals || prRenewals.get(identityOf(entry)) === entry.renewal) return;
  if (!requireCommitOnPrBase) throw new Error("requireCommitOnPrBase is required in PR mode");
  requireCommitOnPrBase(reviewHead);
}

/**
 * @param {{ file: string, functionId: string, renewal: string }} entry
 * @param {Pick<Parameters<typeof renewalEvidenceGaps>[1], "compare" | "backendDefinitionOf" | "evidenceChanged" | "blobOf"> & { reviewHead?: string, blobs?: Map<string, string> }} options
 */
function sourceEvidenceGaps(entry, { compare, backendDefinitionOf, evidenceChanged, blobOf, reviewHead, blobs }) {
  const definition = backendDefinitionOf(entry.functionId);
  const unresolved = definition.file ? definition.unresolved : [...definition.unresolved, "backend definition is unavailable"];
  const files = [...new Set([entry.file, ...(definition.file ? [definition.file] : [])])];
  const changed = files.filter((file) => compare(file) !== "identical");
  if (blobs && !blobOf) throw new Error("blobOf is required to compare evidence-blobs with HEAD");
  const changedSinceEvidence = files.filter((file) => blobs
    ? !blobs.has(file) || blobOf?.(file) !== blobs.get(file)
    : evidenceChanged(/** @type {string} */ (reviewHead), file) !== "identical");
  const named = blobs ? new Set(blobs.keys()) : new Set(rationalePaths(entry.renewal));
  const missing = (blobs ? files : changed).filter((file) => !named.has(file));
  return { missing, changedSinceEvidence, unresolved };
}

/**
 * A human renewal must name each changed client/defining backend file.
 * This checks evidence coverage, not whether the prose's interpretation is true.
 * @param {string} text
 * @param {{ reviewedText: string, compare: (file: string) => "identical" | "changed" | "missing", backendDefinitionOf: (functionId: string) => { file?: string, unresolved: string[] }, evidenceChanged: (sha: string, file: string) => "identical" | "changed" | "missing", blobOf?: (file: string) => string | undefined, prBaseText?: string, requireCommitOnPrBase?: (sha: string) => void }} options
 * @returns {Array<{ index: number, entry: string, missing: string[], changedSinceEvidence: string[], unresolved: string[], renewalProblem?: "malformed" | "missing" }>}
 */
export function renewalEvidenceGaps(text, { reviewedText, compare, backendDefinitionOf, evidenceChanged, blobOf, prBaseText, requireCommitOnPrBase }) {
  if (typeof evidenceChanged !== "function") throw new Error("evidenceChanged is required: a renewal review SHA must be compared with HEAD");
  const document = parseCanonicalBaseline(text);
  if (!document || !Array.isArray(document.entries)) throw new Error("the baseline has no entries array");
  const reviewed = parseCanonicalBaseline(reviewedText);
  if (!reviewed || !Array.isArray(reviewed.entries) || !reviewed.entries.length) throw new Error("the reviewed baseline has no entries");
  const reviewedEntries = new Map(reviewed.entries.map((entry) => [identityOf(entry), entry]));
  if (reviewedEntries.size !== reviewed.entries.length) throw new Error("the reviewed baseline has duplicate identities");
  const prRenewals = prBaseRenewals(prBaseText);
  return document.entries.flatMap((entry, index) => {
    const previous = reviewedEntries.get(identityOf(entry));
    // A relocated/new identity cannot establish an unchanged expiry. Evidence is
    // owed from the baseline comparison, never from the presence of `renewal`.
    const needsEvidence = !previous || entry.expires !== previous.expires;
    const hasRenewal = Object.hasOwn(entry, "renewal");
    if (!hasRenewal && !needsEvidence) return [];
    if (!hasRenewal || typeof entry.renewal !== "string" || !entry.renewal.trim()) {
      return [{ index, entry: label(entry), missing: [hasRenewal ? "(malformed renewal text)" : "(changed expiry or new identity requires renewal text)"],
        changedSinceEvidence: [], unresolved: [], renewalProblem: hasRenewal ? "malformed" : "missing" }];
    }
    if (typeof entry.file !== "string" || !entry.file.trim()) {
      return [{ index, entry: label(entry), missing: ["(invalid client or backend root)"], changedSinceEvidence: [], unresolved: [] }];
    }
    const reference = lastReviewReference(entry.renewal);
    const reviewHead = reference?.[1];
    const blobs = reference && !reviewHead ? parseBlobEvidence(entry.renewal.slice(reference.index + reference[0].length)) : undefined;
    if (!reviewHead && !blobs) return [{ index, entry: label(entry), missing: [reference ? "(malformed evidence-blobs in renewal)" : "(no reviewed source SHA in renewal)"], changedSinceEvidence: [], unresolved: [], renewalProblem: "malformed" }];
    requirePrBaseReview(reviewHead, prRenewals, entry, requireCommitOnPrBase);
    const { missing, changedSinceEvidence, unresolved } = sourceEvidenceGaps(entry,
      { compare, backendDefinitionOf, evidenceChanged, blobOf, reviewHead, blobs });
    return missing.length || changedSinceEvidence.length || unresolved.length
      ? [{ index, entry: label(entry), missing, changedSinceEvidence, unresolved }] : [];
  });
}

/** The repository this copy of the tool lives in. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * @param {string[]} argv
 * @param {{ log: (line: string) => void, error: (line: string) => void }} [io]
 * @param {string} [root]  the repository to check; every path option must stay inside it
 * @returns {number} the process exit code
 */
export function main(argv, io = { log: console.log, error: console.error }, root = REPO_ROOT) {
  try {
    return run(argv, io, root);
  } catch (error) {
    io.error(`renewBaselineReviewed: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_UNAVAILABLE;
  }
}

/** @returns {number} 0, or 10 when the evidence check found stale entries; throws when the check cannot be made */
function run(argv, io, root) {
  // node:util parseArgs is strict by default: an unknown option, a positional, or an option missing its value throws.
  const { values: args } = parseArgs({
    args: argv,
    options: {
      reviewed: { type: "string" },
      baseline: { type: "string" },
      expires: { type: "string" },
      renewal: { type: "string" },
      "check-evidence": { type: "boolean" },
      "pr-base": { type: "string" },
      "blob-evidence": { type: "boolean" },
      write: { type: "boolean" },
    },
  });
  if (!args.reviewed) throw new Error("--reviewed <rev> is required");
  if (!args["check-evidence"] && !args.expires) throw new Error("--expires <YYYY-MM-DD> is required: the new expiry is a decision, never defaulted");
  if (!args["check-evidence"] && !args.renewal) throw new Error('--renewal "<reason>" is required: a renewal records why, it is never defaulted');
  if (args["check-evidence"] && (args.write || args.expires || args.renewal || args["blob-evidence"])) throw new Error("--check-evidence is read-only and takes only --reviewed, --baseline and --pr-base");
  if (args["pr-base"] && !args["check-evidence"]) throw new Error("--pr-base requires --check-evidence");
  const git = resolveGit();
  if (!git) throw new Error("git could not be located (set CONTRACT_SKEW_GIT to an absolute path)");
  const baseline = resolveInside(root, args.baseline ?? DEFAULT_BASELINE, "baseline");

  /** @param {string} revision @param {string} role */
  const resolveHistoryCommit = (revision, role) => {
    // A malformed revision is a usage error, not missing history: say so before the history hint can mislead.
    assertSafeRevision(revision, role);
    try {
      return resolveCommit(git, revision, root);
    } catch {
      throw new Error(`${role} ${revision} is unavailable; fetch full Git history (actions/checkout fetch-depth: 0) before checking renewal evidence`);
    }
  };
  const reviewed = resolveHistoryCommit(args.reviewed, "reviewed revision");
  // Source attribution is read from the working tree and compared by HEAD's blobs.
  const headSha = resolveCommit(git, "HEAD", root);
  /** @param {string} revision @param {string} role */
  const requireAncestor = (revision, role) => {
    if (!isAncestor(git, revision, headSha, root)) {
      throw new Error(`HISTORY_ANCESTRY_REFUSED: ${role} ${revision} is not a verified ancestor of HEAD; check the revision and available Git history before retrying`);
    }
  };
  // A reviewed revision that is not an ancestor of HEAD says nothing about HEAD's history.
  requireAncestor(reviewed, "reviewed revision");
  const prBase = args["pr-base"] ? resolveHistoryCommit(args["pr-base"], "PR base revision") : undefined;
  if (prBase) requireAncestor(prBase, "PR base revision");
  const dirty = new Set(runGitText(git, ["diff", "--name-only", "-z", "HEAD"], { cwd: root }).split("\0").filter(Boolean));

  const baselineText = fs.readFileSync(baseline, "utf8");
  const entries = parseCanonicalBaseline(baselineText)?.entries;
  if (!Array.isArray(entries)) throw new Error("the baseline has no entries array");
  const compare = gitCompare({ git, cwd: root, reviewed, head: headSha });
  /** @type {Map<string, string> | undefined} */
  let headBlobs;
  const blobOf = (file) => {
    if (dirty.has(file)) throw new Error(`${file} has uncommitted changes; commit or discard them before checking evidence`);
    headBlobs ??= gitBlobs(git, root, headSha);
    return headBlobs.get(file);
  };
  if (args["check-evidence"]) {
    if (entries.length === 0) throw new Error("baseline has no entries to check");
    const backendDefinitionOf = createBackendDefinitionResolver({ root, functionIds: entries.map((entry) => entry.functionId) });
    const reviewedText = runGitText(git, ["show", `${reviewed}:${DEFAULT_BASELINE}`], { cwd: root });
    /** @type {Map<string, ReturnType<typeof gitCompare>>} */
    const evidenceComparisons = new Map();
    /** @param {string} sha @param {string} file */
    const evidenceChanged = (sha, file) => {
      let comparison = evidenceComparisons.get(sha);
      if (!comparison) {
        const evidenceHead = resolveHistoryCommit(sha, "recorded evidence revision");
        requireAncestor(evidenceHead, "recorded evidence revision");
        comparison = gitCompare({ git, cwd: root, reviewed: evidenceHead, head: headSha });
        evidenceComparisons.set(sha, comparison);
      }
      return comparison(file);
    };
    const compareRequiredFile = (file) => {
      if (dirty.has(file)) throw new Error(`${file} has uncommitted changes; commit or discard them before checking evidence`);
      return compare(file);
    };
    const prBaseText = prBase ? runGitText(git, ["show", `${prBase}:${DEFAULT_BASELINE}`], { cwd: root }) : undefined;
    const checkedPrCommits = new Set();
    const requireCommitOnPrBase = (sha) => {
      if (checkedPrCommits.has(sha)) return;
      const guidance = "use --blob-evidence to record reviewed file blobs that survive squash merges";
      let evidenceHead;
      try {
        evidenceHead = resolveHistoryCommit(sha, "recorded evidence revision");
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; ${guidance}`);
      }
      if (!prBase || !isAncestor(git, evidenceHead, prBase, root)) {
        throw new Error(`PR_EVIDENCE_REFUSED: new or changed renewal cites ${sha}, which is not on the PR base; ${guidance}`);
      }
      checkedPrCommits.add(sha);
    };
    const gaps = renewalEvidenceGaps(baselineText, { reviewedText, compare: compareRequiredFile, backendDefinitionOf, evidenceChanged,
      blobOf, prBaseText, requireCommitOnPrBase });
    const renewedEntries = entries.filter((entry) => Object.hasOwn(entry, "renewal")).length;
    const malformed = gaps.filter((gap) => gap.renewalProblem === "malformed").length;
    const missing = gaps.filter((gap) => gap.renewalProblem === "missing").length;
    io.log(`renewal evidence: ${renewedEntries} renewed entries checked, ${entries.length - renewedEntries} unrenewed, ${gaps.length} stale, ${malformed} malformed, ${missing} missing`);
    for (const gap of gaps.slice(0, 20)) io.log(`STALE entry #${gap.index + 1} ${gap.entry}: unnamed ${gap.missing.join(", ")}; changed after review ${gap.changedSinceEvidence.join(", ")}; unresolved ${gap.unresolved.join(", ")}`);
    if (gaps.length > 20) io.log(`... ${gaps.length - 20} more stale entries`);
    return gaps.length ? 10 : 0;
  }

  const projects = [
    ...CLIENT_SURFACES.map((surface) => ({
      tsconfig: surface.tsconfig,
      rootFiles: [...new Set(entries.filter((e) => e.surface === surface.name).map((e) => e.file))],
    })),
    { tsconfig: "convex/tsconfig.json", rootFiles: [...new Set(entries.map((e) => backendModuleOf(e.functionId)).filter(Boolean))] },
  ];
  const resolveClosure = createImportClosure({ root, projects, implicitInputs: IMPLICIT_INPUTS });
  const closureOf = (file) => {
    const closure = resolveClosure(file);
    const edited = closure.files.find((f) => dirty.has(f));
    if (edited) throw new Error(`${edited} has uncommitted changes; commit or discard them before renewing`);
    return closure;
  };
  const backendDefinitionOf = args["blob-evidence"]
    ? createBackendDefinitionResolver({ root, functionIds: entries.map((entry) => entry.functionId) }) : undefined;
  const blobEvidenceFor = backendDefinitionOf ? (entry) => {
    const definition = backendDefinitionOf(entry.functionId);
    if (!definition.file || definition.unresolved.length) throw new Error(`cannot resolve backend definition ${entry.functionId} for blob evidence`);
    const records = [...new Set([entry.file, definition.file])].map((file) => {
      const blob = blobOf(file);
      if (!blob || compare(file) !== "identical") throw new Error(`cannot record unverified blob for ${file}`);
      return [file, blob];
    });
    return `evidence-blobs ${JSON.stringify(records)}`;
  } : undefined;
  const result = renewBaseline(baselineText, {
    compare,
    closureOf,
    expires: String(args.expires),
    renewal: String(args.renewal),
    blobEvidenceFor,
  });
  io.log(`reviewed ${reviewed}\nhead     ${headSha}`);
  io.log(`renewed ${result.renewed}, already current ${result.skipped}, refused ${result.refused.length}`);
  for (const r of result.refused) io.log(`REFUSED entry #${r.index + 1} ${r.entry}: ${r.reason}`);
  if (args.write) {
    writeBaselineAtomically(baseline, result.text, baselineText, root);
    io.log(`wrote ${baseline}`);
  } else {
    io.log("dry run; pass --write to apply");
  }
  return 0;
}

if (isRunDirectly(import.meta.url)) process.exitCode = main(process.argv.slice(2));
