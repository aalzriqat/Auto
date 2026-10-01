#!/usr/bin/env node
/**
 * SCRUM-293 - trusted validator for the candidate-generated LCOV artifact.
 *
 * Run by `.github/workflows/sonar-pr-report.yml` from the TRUSTED checkout
 * (`trusted/`, the immutable workflow_sha), never from the candidate merge, so a
 * PR cannot weaken the check that judges its own coverage artifact.
 *
 * The artifact is untrusted data. It is refused when it:
 *  - contains a control character other than LF, CRLF or tab (a bare CR or NUL
 *    lets one physical line read as two records to a different parser);
 *  - names an SF source outside convex/, scripts/, apps/mobile/src/,
 *    apps/mobile/app/ or packages/shared/src/ (exact directories -
 *    apps/mobile/appx/, packages/shared/srcx/, other packages/ paths and
 *    .github/ (workflows and scripts alike) are refused);
 *  - names an absolute path, or a path with an empty, "." or ".." segment or
 *    trailing whitespace;
 *  - names a source that is not an existing regular, non-symlink file in the
 *    exact candidate merge checkout.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_SOURCE = /^(convex|scripts|apps\/mobile\/(src|app)|packages\/shared\/src)\//;
// Any C0 control except TAB (0x09) and LF (0x0a), DEL, or a CR that is not part of CRLF.
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/;

function refuse(source, reason) {
  return new Error(`Trusted Sonar refuses out-of-scope LCOV source path (${reason}): ${JSON.stringify(source)}`);
}

function validateLcovSources(text, { candidateRoot }) {
  if (FORBIDDEN_CONTROL.test(text)) {
    throw new Error("Trusted Sonar refuses LCOV containing a control character other than LF, CRLF or tab.");
  }
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("SF:")) continue;
    const source = line.slice(3).replaceAll("\\", "/");
    if (source.startsWith("/")) throw refuse(source, "absolute path");
    if (/\s$/.test(source)) throw refuse(source, "trailing whitespace");
    if (source.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw refuse(source, "empty, '.' or '..' segment");
    }
    if (!ALLOWED_SOURCE.test(source)) throw refuse(source, "outside allowlist");
    let stat;
    try {
      stat = fs.lstatSync(path.join(candidateRoot, source));
    } catch {
      stat = undefined;
    }
    if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) {
      throw refuse(source, "not an existing regular file in the candidate checkout");
    }
    count += 1;
  }
  return count;
}

/** CLI body: `node validateLcovSources.cjs <lcov.info> <candidateRoot>`; returns the exit code. */
function main(argv) {
  const [lcovPath, candidateRoot] = argv;
  if (!lcovPath || !candidateRoot) {
    console.error("usage: validateLcovSources.cjs <lcov.info> <candidateRoot>");
    return 1;
  }
  try {
    const count = validateLcovSources(fs.readFileSync(lcovPath, "utf8"), { candidateRoot });
    console.log(`Validated ${count} LCOV source records.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

module.exports = { validateLcovSources, main };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
