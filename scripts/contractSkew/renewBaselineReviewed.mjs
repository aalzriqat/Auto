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
 *   - its backend module (`convex/<module>.ts` from the functionId), and
 *   - every repository file its rationale names
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
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveGit } from "./gitExecutable.mjs";

export const RENEWED_EXPIRES = "2026-12-01";

const MODULE_FUNCTION_ID = /^([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PATH_TOKEN = /[\w@()[\]/.-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|ya?ml)\b/g;

/**
 * @param {string} functionId  e.g. `sourcingPayables:markPaid`
 * @returns {string | undefined} `convex/<module>.ts`, or undefined when the id is not `module:function`
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
  const cache = new Map();
  const blobAt = (rev, file) => {
    try {
      const id = execFileSync(git, ["rev-parse", "--verify", "--quiet", `${rev}:${file}`], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const type = execFileSync(git, ["cat-file", "-t", id], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      return type === "blob" ? id : undefined;
    } catch {
      return undefined;
    }
  };
  return (file) => {
    if (!cache.has(file)) {
      const before = blobAt(reviewed, file);
      const after = blobAt(head, file);
      cache.set(file, before === undefined || after === undefined ? "missing" : before === after ? "identical" : "changed");
    }
    return cache.get(file);
  };
}

const label = (entry) => `${entry.functionId} ${entry.contractPath} @ ${entry.callSiteId}`;

/** @returns {string | undefined} the reason this entry must not be renewed, if any */
function refusalFor(entry, compare) {
  const backend = backendModuleOf(entry.functionId);
  if (backend === undefined) return `functionId ${entry.functionId} names no backend module`;
  if (typeof entry.file !== "string" || entry.file.trim() === "") return "entry names no client file";

  const client = compare(entry.file);
  if (client === "changed") return `client file ${entry.file} changed since the reviewed revision`;
  if (client === "missing") return `client file ${entry.file} is missing at the reviewed revision or HEAD`;

  const module = compare(backend);
  if (module === "changed") return `backend module ${backend} changed since the reviewed revision`;
  if (module === "missing") return `backend module ${backend} is missing at the reviewed revision or HEAD`;

  for (const named of rationalePaths(entry.rationale)) {
    const state = compare(named);
    if (state === "changed") return `rationale file ${named} changed since the reviewed revision`;
    // A bare name with no directory that is not a tracked file (`result.json`)
    // is a variable or payload name in prose, not a repository path.
    if (state === "missing" && named.includes("/")) return `rationale file ${named} is missing at the reviewed revision or HEAD`;
  }
  return undefined;
}

/**
 * @param {string} text  the baseline file's text
 * @param {{ compare: (file: string) => "identical" | "changed" | "missing", expires: string, renewal: string }} options
 * @returns {{ text: string, renewed: number, skipped: number, refused: Array<{ index: number, entry: string, reason: string }> }}
 */
export function renewBaseline(text, { compare, expires, renewal }) {
  if (!DATE.test(expires) || Number.isNaN(Date.parse(expires))) throw new Error(`expires must be YYYY-MM-DD, got ${expires}`);
  if (typeof renewal !== "string" || renewal.trim() === "") throw new Error("a non-empty renewal reason is required");

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = text.replace(/\r\n/g, "\n");
  const document = JSON.parse(normalized);
  if (JSON.stringify(document, null, 2) + "\n" !== normalized) {
    throw new Error("the baseline is not in canonical 2-space JSON, so a rewrite would reformat it; refusing");
  }
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
    const reason = refusalFor(entry, compare);
    if (reason !== undefined) {
      refused.push({ index, entry: label(entry), reason });
      return entry;
    }
    renewed++;
    return { ...entry, expires, renewal };
  });

  const out = JSON.stringify(document, null, 2) + "\n";
  return { text: eol === "\n" ? out : out.replace(/\n/g, eol), renewed, skipped, refused };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") args.write = true;
    else if (/^--(reviewed|head|baseline|expires|renewal)$/.test(arg) && argv[i + 1] !== undefined) args[arg.slice(2)] = argv[++i];
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const args = parseArgs(argv);
  if (!args.reviewed) throw new Error("--reviewed <rev> is required");
  if (!args.renewal) throw new Error('--renewal "<reason>" is required: a renewal records why, it is never defaulted');
  const git = resolveGit();
  if (!git) throw new Error("git could not be located (set CONTRACT_SKEW_GIT to an absolute path)");
  const head = args.head ?? "HEAD";
  const baseline = args.baseline ? path.resolve(args.baseline) : path.join(root, "scripts", "contractSkew", "needs-evidence-baseline.json");

  const resolve = (rev) => execFileSync(git, ["rev-parse", "--verify", `${rev}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
  const reviewed = resolve(args.reviewed);
  const headSha = resolve(head);
  // A reviewed revision that is not an ancestor of HEAD says nothing about HEAD's history.
  execFileSync(git, ["merge-base", "--is-ancestor", reviewed, headSha], { cwd: root });

  const result = renewBaseline(fs.readFileSync(baseline, "utf8"), {
    compare: gitCompare({ git, cwd: root, reviewed, head: headSha }),
    expires: args.expires ?? RENEWED_EXPIRES,
    renewal: args.renewal,
  });
  console.log(`reviewed ${reviewed}\nhead     ${headSha}`);
  console.log(`renewed ${result.renewed}, already current ${result.skipped}, refused ${result.refused.length}`);
  for (const r of result.refused) console.log(`REFUSED entry #${r.index + 1} ${r.entry}: ${r.reason}`);
  if (args.write) {
    fs.writeFileSync(baseline, result.text);
    console.log(`wrote ${baseline}`);
  } else {
    console.log("dry run; pass --write to apply");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`renewBaselineReviewed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
