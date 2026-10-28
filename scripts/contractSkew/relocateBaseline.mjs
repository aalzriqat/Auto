#!/usr/bin/env node
/** Explicit author tool; never imported or invoked by the production monitor. */
import fs from "node:fs";
import { parseArgs } from "node:util";
import ts from "typescript";
import { resolveCommit, resolveGit, runGitBytes } from "./gitExecutable.mjs";
import { serializeBaseline, writeBaselineAtomically } from "./baselineFile.mjs";
import { DEFAULT_BASELINE, EXIT_IDENTITY_DRIFT, EXIT_UNAVAILABLE, readIdentityBaseline, inspectBaselineIdentities, callExpressionAt,
  callKey, describeStranded } from "./baselineIdentity.mjs";

// Fatal decoding prevents different invalid UTF-8 bytes comparing equal as replacement characters.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

try {
  const { values } = parseArgs({ options: {
    baseline: { type: "string", default: DEFAULT_BASELINE }, base: { type: "string" }, write: { type: "boolean" },
  } });
  if (!values.base) throw new Error("Required: --base <revision containing the reviewed calls at their old sites>");
  const git = resolveGit();
  if (!git) throw new Error("Git is unavailable; cannot verify the old call expression");
  const base = resolveCommit(git, values.base);
  const before = fs.readFileSync(values.baseline, "utf8");
  const entries = readIdentityBaseline(values.baseline);
  const stranded = inspectBaselineIdentities(entries);
  const occupied = new Set(entries.map(callKey));
  /** @type {Map<string, { base: import("typescript").SourceFile, head: import("typescript").SourceFile }>} */
  const sourcesByFile = new Map();
  const proposals = stranded.map((finding) => {
    const { entry, candidates } = finding;
    let sources = sourcesByFile.get(entry.file);
    if (!sources) {
      const parse = (text) => ts.createSourceFile(entry.file, text, ts.ScriptTarget.Latest, true);
      sources = {
        base: parse(strictUtf8.decode(runGitBytes(git, ["show", `${base}:${entry.file}`]))),
        head: parse(strictUtf8.decode(fs.readFileSync(entry.file))),
      };
      sourcesByFile.set(entry.file, sources);
    }
    const original = callExpressionAt(sources.base, entry.callSiteId);
    const identical = candidates.filter((call) => original !== null &&
      callExpressionAt(sources.head, call.callSiteId) === original);
    const target = identical.length === 1 && !occupied.has(callKey(identical[0])) ? identical[0] : undefined;
    return { ...finding, target };
  });
  // Distinct old calls cannot both claim one new site, even if their text is identical. Several findings of the
  // SAME old call (one per contract path) share a call key and may share the target; a second old call is a conflict.
  /** @type {Map<string, string | null>} target key -> the one old call claiming it, or null once two differ */
  const claimant = new Map();
  for (const proposal of proposals) {
    if (!proposal.target) continue;
    const target = callKey(proposal.target);
    const old = callKey(proposal.entry);
    claimant.set(target, claimant.has(target) && claimant.get(target) !== old ? null : old);
  }
  let refused = 0;
  for (const proposal of proposals) {
    const { entry, target } = proposal;
    if (!target || claimant.get(callKey(target)) === null) {
      console.error(`NEEDS HUMAN REVIEW (changed, absent, ambiguous or occupied call): ${describeStranded(proposal)}`);
      refused++;
    } else {
      console.log(`${values.write ? "RELOCATE" : "PROPOSE"}: ${entry.callSiteId} -> ${target.callSiteId} (${entry.functionId}, ${entry.contractPath})`);
      entry.callSiteId = target.callSiteId;
    }
  }
  if (values.write && proposals.length > refused) {
    // Preserve all review metadata; the only semantic edits permitted here are callSiteId values.
    const document = JSON.parse(before);
    document.entries = entries;
    writeBaselineAtomically(values.baseline, serializeBaseline(document, before), before);
  }
  console.log(`${proposals.length - refused} safe relocation(s), ${refused} requiring human review. ${values.write ? "Write requested." : "Dry run; baseline unchanged."}`);
  process.exitCode = refused ? EXIT_IDENTITY_DRIFT : 0;
} catch (error) {
  console.error(`Relocation UNAVAILABLE; inspect the baseline before retrying: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT_UNAVAILABLE;
}
