# The pilot role audit publishes per-case verdicts

Status: accepted. Owner ruling SCRUM-891 c24395, option B, 2026-11-03.

## Context

`pilot-role-audit.yml` is red on `main` for every role that is allowed on the sales, deals and accounting routes. The public
`results.json` carried only counts: `roleRegressionsExpected` 7, `roleRegressionsObserved` 7, `roleRegressionsVerified` false
and `roleRegressionsMeasurement` FAIL. The title of the failing case existed only inside the encrypted
`role-evidence.tar.gpg`. This repository and its Actions artifacts are public, and Playwright error text, stacks, locations
and attachments can carry tenant data.

## Decision

`scripts/pilotRoleAuditEvidence.mjs` adds `roleRegressionCases` to the public `results.json`: one
`{ title, project, status, location }` entry for each title in the fixed `ROLE_CASE_PROJECTS` allowlist, in constant order,
each exactly once.

- `title` and `project` come only from the constant, never from the report.
- `status` is a closed enum: `passed`, `failed`, `skipped`, `missing` (not observed), `duplicate` (observed more than once) or
  `wrong-project` (observed under a project other than the one the constant names).
- `passed` is the same exact shape that `roleRegressionsVerified` already required: the spec is `ok`, expected to pass, its
  test status is `expected` and it has one attempt whose status is `passed`.
- `skipped` means only that Playwright expected the case to skip (`expectedStatus` `skipped`: `test.skip`, `test.fixme` or a
  runtime skip) and it did. Playwright 1.61 (`computeTestCaseOutcome`) also reports test status `skipped` for an
  interrupted-only test, a test with no attempt, and a skipped attempt of a test expected to pass. Those cases could not
  run, so they are `failed` (the pilot gate says a case that cannot run is a failure, never a skip). Everything else,
  including a status Playwright 1.61 does not define, is `failed`, never `passed`.
- `location` is `"<repo-relative path>:<line>"` for a `failed` case, otherwise `null`. It comes only from the last failing
  attempt's `errorLocation`, or else its first `errors[].location`, in the Playwright JSON report. The path is normalised to
  `/` and cut at the last `playwright/` segment. It is published only if the result matches
  `^playwright/[A-Za-z0-9_\-./]+\.(ts|tsx|js|mjs)$`, no segment is `..` or `node_modules`, and `line` is a positive safe
  integer. Otherwise it is `null`. The runner's absolute path, the column and all other report text are never published, and a
  malformed location becomes `null` without making the report absent.
- `roleRegressionsUnlistedCount` is the number of observed cases whose title is not on the allowlist. Their titles are not
  published. It was named "unexpected" before release, which is Playwright's word for a failure.
- When the report is absent, unparseable or carries global errors, every case is `missing`.
- `roleRegressionsVerified` is true only if every case is `passed` and the unlisted count is zero. No existing field,
  threshold or measurement changed.

## What stays private

Error messages, stacks, the absolute location and column, attachments, stdout, step names, URLs, report titles outside the allowlist and the full
report remain only in the encrypted archive.

## Alternatives rejected

- Decrypting `role-evidence.tar.gpg` locally to read the failing title. The owner ruled that no agent decrypts it (c24395).
- Publishing the error message or step name. Error text can carry tenant data in a public artifact.
- Publishing report titles verbatim. A foreign or renamed title is attacker- or tenant-influenced text; the allowlist keeps the
  public surface to constants.

## Consequences

The next red run names the failing case, the project it ran in and the `playwright/` file and line where it failed, without
exposing why it failed. The cause still needs the
private archive or a local reproduction. A renamed case shows as `missing` plus one unlisted case.
