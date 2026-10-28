#!/usr/bin/env node
/** Explicit author tool; never imported or invoked by the production monitor. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import ts from "typescript";
import { resolveGit } from "./gitExecutable.mjs";
import { DEFAULT_BASELINE, readIdentityBaseline, inspectBaselineIdentities, callExpressionAt,
  callKey, describeStranded } from "./baselineIdentity.mjs";

try {
  const { values } = parseArgs({ options: {
    baseline: { type: "string", default: DEFAULT_BASELINE }, base: { type: "string" }, write: { type: "boolean" },
  } });
  if (!values.base) throw new Error("Required: --base <revision containing the reviewed calls at their old sites>");
  const git = resolveGit();
  if (!git) throw new Error("Git is unavailable; cannot verify the old call expression");
  const runGit = (args) => execFileSync(git, args, { timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const base = runGit(["rev-parse", "--verify", "--end-of-options", `${values.base}^{commit}`]).toString("utf8").trim();
  const before = fs.readFileSync(values.baseline, "utf8");
  const entries = readIdentityBaseline(values.baseline);
  const stranded = inspectBaselineIdentities(entries);
  const occupied = new Set(entries.map(callKey));
  const sources = new Map();
  const headSources = new Map();
  const proposals = stranded.map((finding) => {
    const { entry, candidates } = finding;
    if (!sources.has(entry.file)) {
      // Fatal decoding prevents different invalid UTF-8 bytes comparing equal as replacement characters.
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(runGit(["show", `${base}:${entry.file}`]));
      const source = ts.createSourceFile(entry.file, text, ts.ScriptTarget.Latest, true);
      sources.set(entry.file, source);
      const headText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(entry.file));
      headSources.set(entry.file, ts.createSourceFile(entry.file, headText, ts.ScriptTarget.Latest, true));
    }
    const original = callExpressionAt(sources.get(entry.file), entry.callSiteId);
    const identical = candidates.filter((call) => original !== null &&
      callExpressionAt(headSources.get(call.file), call.callSiteId) === original);
    const target = identical.length === 1 && !occupied.has(callKey(identical[0])) ? identical[0] : undefined;
    return { ...finding, target };
  });
  // Distinct old calls cannot both claim one new site, even if their text is identical.
  const owners = new Map();
  for (const proposal of proposals) {
    if (!proposal.target) continue;
    const key = callKey(proposal.target);
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(callKey(proposal.entry));
  }
  let refused = 0;
  for (const proposal of proposals) {
    const { entry, target } = proposal;
    if (!target || owners.get(callKey(target)).size !== 1) {
      console.error(`NEEDS HUMAN REVIEW (changed, absent, ambiguous or occupied call): ${describeStranded(proposal)}`);
      refused++;
    } else {
      console.log(`${values.write ? "RELOCATE" : "PROPOSE"}: ${entry.callSiteId} -> ${target.callSiteId} (${entry.functionId}, ${entry.contractPath})`);
      entry.callSiteId = target.callSiteId;
    }
  }
  if (values.write && proposals.length > refused) {
    // Preserve all review metadata; the only semantic edits permitted here are callSiteId values.
    if (fs.readFileSync(values.baseline, "utf8") !== before) throw new Error("Baseline changed while checking; refusing write");
    const document = JSON.parse(before);
    document.entries = entries;
    const temporary = path.join(path.dirname(values.baseline), `.${path.basename(values.baseline)}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(document, null, 2) + "\n", { flag: "wx", mode: fs.statSync(values.baseline).mode });
      fs.renameSync(temporary, values.baseline);
    } finally {
      // This file is created by this invocation; never remove the original baseline on failure.
      fs.rmSync(temporary, { force: true });
    }
  }
  console.log(`${proposals.length - refused} safe relocation(s), ${refused} requiring human review. ${values.write ? "Write requested." : "Dry run; baseline unchanged."}`);
  process.exitCode = refused ? 10 : 0;
} catch (error) {
  console.error(`Relocation UNAVAILABLE; inspect the baseline before retrying: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 3;
}
