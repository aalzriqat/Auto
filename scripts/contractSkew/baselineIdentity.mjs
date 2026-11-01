/** Credential-free call identity checks. Backend finding identity remains the monitor's job. */
import path from "node:path";
import ts from "typescript";
import { loadBaseline } from "./baseline.mjs";
import { createClientProgram, extractClientCalls } from "./clientPaths.mjs";
import { CLIENT_SURFACES, listSurfaceFiles, toPosixRel } from "./clientFiles.mjs";

export { BASELINE_DIRECTORY as DEFAULT_BASELINE } from "./baselineShards.mjs";

/** Exit codes shared by the identity check and the relocation helper. */
export const EXIT_IDENTITY_DRIFT = 10;
export const EXIT_UNAVAILABLE = 3;

/** @typedef {{surface: string, file: string, callSiteId: string, functionId: string, contractPath?: string, kind?: string}} CallIdentity */
/** @param {CallIdentity} entry */
export const callKey = (entry) => JSON.stringify([entry.surface, entry.file, entry.callSiteId, entry.functionId]);
/** @param {CallIdentity} entry */
export const describeEntry = (entry) => `${entry.surface}:${entry.file} ${entry.callSiteId} ${entry.functionId}`;

/** @param {string} baselineDirectory */
export function readIdentityBaseline(baselineDirectory) {
  return readIdentityBaselineSnapshot(baselineDirectory).entries;
}

/**
 * The validated entries plus the shard snapshot they were read from, which `writeShardedBaseline` needs to refuse a
 * write if the directory changed in between.
 * @param {string} baselineDirectory
 */
export function readIdentityBaselineSnapshot(baselineDirectory) {
  const loaded = loadBaseline(baselineDirectory);
  if (!loaded.ok) throw new Error(loaded.problem);
  loaded.entries.forEach((entry, index) => {
    const fields = ["surface", "file", "callSiteId", "functionId"];
    if (!entry || fields.some((field) => typeof entry[field] !== "string" || !entry[field].trim())) {
      throw new Error(`Malformed call identity in baseline entry #${index + 1}`);
    }
    if (!CLIENT_SURFACES.some((surface) => surface.name === entry.surface) ||
        entry.file.includes("\\") || path.posix.isAbsolute(entry.file) ||
        entry.file.split("/").some((part) => part === ".." || part === ".") ||
        !entry.callSiteId.startsWith(`${entry.file}:`) ||
        !/^[1-9]\d*:[1-9]\d*$/.test(entry.callSiteId.slice(entry.file.length + 1))) {
      throw new Error(`Invalid call identity in baseline entry #${index + 1}: ${describeEntry(entry)}`);
    }
  });
  return { entries: loaded.entries, files: loaded.files };
}

/**
 * Scan only baseline-bearing files, using the monitor's surface config and extractor.
 * Imported dependencies still resolve through the real compiler program.
 * @param {CallIdentity[]} entries
 */
export function inspectBaselineIdentities(entries) {
  /** @type {CallIdentity[]} */
  const calls = [];
  for (const surface of CLIENT_SURFACES) {
    const wanted = new Set(entries.filter((entry) => entry.surface === surface.name).map((entry) => entry.file));
    if (!wanted.size) continue;
    const files = listSurfaceFiles(process.cwd(), surface)
      .filter((file) => wanted.has(toPosixRel(process.cwd(), file)));
    // createClientProgram([]) falls back to the whole tsconfig; missing files are drift.
    if (!files.length) continue;
    const program = createClientProgram(files, surface.tsconfig);
    for (const file of files) {
      const source = program.getSourceFile(file);
      if (!source || program.getSyntacticDiagnostics(source).length) throw new Error(`Cannot parse client source ${file}`);
    }
    for (const call of extractClientCalls(files, surface.tsconfig, { program }).calls) {
      if (call.skipped) continue;
      calls.push({ surface: surface.name, file: call.file, callSiteId: call.siteId,
        functionId: call.identifier });
    }
  }
  const found = new Set(calls.map(callKey));
  return entries.filter((entry) => !found.has(callKey(entry))).map((entry) => ({
    entry,
    candidates: calls.filter((call) => call.surface === entry.surface && call.file === entry.file &&
      call.functionId === entry.functionId),
  }));
}

/**
 * The extractor's site may point at the invoked binding or the function reference.
 * Require an exact AST-node start at the callee or first argument of its containing
 * call. A request map inside useMemo is not itself a Convex invocation; comparing
 * that wrapper would miss changes to the later useQueries consumer.
 * @param {import("typescript").SourceFile} source
 * @param {string} siteId
 * @returns {string | null}
 */
export function callExpressionAt(source, siteId) {
  const match = /:([1-9]\d*):([1-9]\d*)$/.exec(siteId);
  if (!match) return null;
  const line = Number(match[1]) - 1;
  const column = Number(match[2]) - 1;
  const starts = source.getLineStarts();
  if (line >= starts.length) return null;
  const position = starts[line] + column;
  if (position >= (starts[line + 1] ?? source.end)) return null;
  /** @type {import("typescript").Node | undefined} */
  let exact;
  const visit = (node) => {
    // A node whose full range excludes the position cannot start there, and neither can its children.
    if (position < node.getFullStart() || position >= node.end) return;
    if (node.getStart(source) === position) exact = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  while (exact && !ts.isCallExpression(exact)) exact = exact.parent;
  if (!exact || !ts.isCallExpression(exact)) return null;
  if (exact.expression.getStart(source) !== position && exact.arguments[0]?.getStart(source) !== position) return null;
  // Compare call TEXT independent of how the checkout stores line endings. `git show <rev>:file` returns
  // the stored blob (LF), while a working tree with core.autocrlf=true holds the same file as CRLF
  // (git-config "core.autocrlf": LF in the repository, CRLF in the working directory on checkout), so a
  // textually identical multi-line call would otherwise compare unequal. Only the CRLF pair is folded;
  // every other byte, including a lone CR, stays significant. Line and column positions are unaffected.
  return source.text.slice(exact.getStart(source), exact.end).replace(/\r\n/g, "\n");
}

/** @param {ReturnType<typeof inspectBaselineIdentities>[number]} stranded */
export function describeStranded({ entry, candidates }) {
  return `${describeEntry(entry)} (${entry.contractPath ?? "?"} [${entry.kind ?? "?"}]); candidates: ` +
    (candidates.map((call) => call.callSiteId).join(", ") || "none in the same surface/file for this function");
}
