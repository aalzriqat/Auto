/**
 * Deciding whether an LCOV report is real evidence, before Sonar is allowed to
 * read it.
 *
 * Sonar does NOT fail when a coverage report is missing or unusable. It analyses
 * with no coverage data and reports 0.0% coverage on 0.0% of new code, which the
 * Quality Gate PASSES. That vacuous green is the failure this exists to prevent,
 * on a check that is required on `main`.
 *
 * ⚠️ This logic used to live as inline bash in the workflow, where it checked
 * three things: the file is non-empty, it has at least one `SF:` record, and
 * every `SF:` path exists. Two adversarial reports were then shown to satisfy
 * all three while proving nothing (SCRUM-185 review):
 *
 *   TN:                          <- one record, real path, ZERO coverage data
 *   SF:package.json
 *   end_of_record
 *
 *   SF:convex/foo.ts             <- structurally truncated: a write that died
 *   DA:1,1                          partway leaves no `end_of_record`
 *
 * The first says "a file exists" and nothing about whether it was measured. The
 * second is what a killed process actually leaves behind. So the rules below add
 * structural completeness and evidence of executable lines, and the whole thing
 * moved here where it can be tested — the repository already does this for
 * release gating (`releaseChecks.mjs`, `releaseGuard.ts`), and inline YAML bash
 * on a required check was the one place that convention was not followed.
 *
 * ⚠️ `LH > 0` is deliberately NOT required. A report where every line is
 * uncovered is a truthful measurement — "this code has no tests" is exactly the
 * signal Sonar should receive, and refusing it would make the gate lie in the
 * opposite direction. What must be present is evidence that lines were
 * MEASURED (`LF > 0`, or at least one `DA:` record), not that they were hit.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Parse LCOV into records, keeping the structural facts the checks need.
 *
 * `terminated` is tracked per record rather than inferred from how the file
 * ends, because a report can be truncated in the middle and still have later
 * records after the damaged one.
 */
export function parseLcov(text) {
  const records = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      current = { file: line.slice(3).trim(), linesFound: 0, daCount: 0, terminated: false };
      records.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("DA:")) current.daCount += 1;
    else if (line.startsWith("LF:")) current.linesFound = Number.parseInt(line.slice(3), 10) || 0;
    else if (line === "end_of_record") current.terminated = true;
  }
  return records;
}

/** A record carries evidence when lines were MEASURED — hit or not. */
export function hasExecutableEvidence(record) {
  return record.linesFound > 0 || record.daCount > 0;
}

/**
 * Normalise an `SF:` path for existence checking.
 *
 * Reports are produced on Linux in CI and on Windows locally; the separator
 * difference is an artefact of the writer, not a property of the repository.
 */
function toRepoRelative(file) {
  return file.replace(/\\/g, "/");
}

/**
 * Verify one report.
 *
 * Returns a result rather than throwing, so a caller can report on every report
 * instead of dying on the first one — the operator needs to see both.
 */
export function verifyReport(label, text, { repoRoot = process.cwd(), exists = existsSync } = {}) {
  const problems = [];

  if (text.trim() === "") {
    problems.push(
      `${label} is missing or empty. Refusing to scan: Sonar would report 0.0% coverage on 0.0% of new code and PASS the gate on no evidence.`
    );
    return { ok: false, problems, records: 0, measured: 0 };
  }

  const records = parseLcov(text);

  if (records.length === 0) {
    problems.push(`${label} contains no SF: source records. Refusing to scan on an empty report.`);
    return { ok: false, problems, records: 0, measured: 0 };
  }

  const unterminated = records.filter((r) => !r.terminated);
  if (unterminated.length > 0) {
    problems.push(
      `${label} has ${unterminated.length} of ${records.length} records with no end_of_record — the report is structurally truncated, which is what a coverage run killed mid-write leaves behind. First: ${unterminated[0].file}`
    );
  }

  const missing = records.filter((r) => !exists(path.resolve(repoRoot, toRepoRelative(r.file))));
  if (missing.length > 0) {
    problems.push(
      `${label} has ${missing.length} of ${records.length} source paths that do not exist at the repository root. Sonar would silently ignore them and measure less than it appears to. First: ${missing[0].file}`
    );
  }

  const measured = records.filter(hasExecutableEvidence).length;
  if (measured === 0) {
    problems.push(
      `${label} has ${records.length} records but not one carries executable-line data (no LF: > 0 and no DA: records). It names files without measuring them, so scanning it would report coverage on nothing. A fully UNCOVERED report is fine — this refuses an UNMEASURED one.`
    );
  }

  return { ok: problems.length === 0, problems, records: records.length, measured };
}
