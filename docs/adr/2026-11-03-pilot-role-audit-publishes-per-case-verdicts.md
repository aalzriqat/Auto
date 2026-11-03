# The pilot role audit publishes per-case verdicts

Status: accepted. Owner ruling SCRUM-891 c24395, option B, 2026-11-03.

## Context

`pilot-role-audit.yml` is red on `main` for every role that is allowed on the sales, deals and accounting routes. The public
`results.json` carried only counts: `roleRegressionsExpected` 7, `roleRegressionsObserved` 7, `roleRegressionsVerified` false
and `roleRegressionsMeasurement` FAIL. The title of the failing case existed only inside the encrypted
`role-evidence.tar.gpg`. This repository and its Actions artifacts are public, and Playwright error text, stacks, locations
and attachments can carry tenant data.

## Decision

`scripts/pilotRoleAuditEvidence.mjs` adds `roleRegressionCases` to the public `results.json`: one `{ title, project, status }`
entry for each title in the fixed `ROLE_CASE_PROJECTS` allowlist, in constant order, each exactly once.

- `title` and `project` come only from the constant, never from the report.
- `status` is a closed enum: `passed`, `failed`, `skipped`, `missing` (not observed), `duplicate` (observed more than once) or
  `wrong-project` (observed under a project other than the one the constant names).
- `passed` is the same exact shape that `roleRegressionsVerified` already required: the spec is `ok`, expected to pass, its
  test status is `expected` and it has one attempt whose status is `passed`. A skip (`skipped` test status, or only skipped
  attempts) is `skipped`. Everything else, including a status the installed Playwright (1.61) does not define, is `failed`,
  never `passed`. Playwright's JSON reporter documents test statuses `expected`, `unexpected`, `flaky` and `skipped`, and
  attempt statuses `passed`, `failed`, `timedOut`, `interrupted` and `skipped`.
- `roleRegressionsUnexpectedCount` is the number of observed cases whose title is not on the allowlist. Their titles are not
  published.
- When the report is absent, unparseable or carries global errors, every case is `missing`.
- `roleRegressionsVerified` is true only if every case is `passed` and the unexpected count is zero. No existing field,
  threshold or measurement changed.

## What stays private

Error messages, stacks, locations, attachments, stdout, step names, URLs, report titles outside the allowlist and the full
report remain only in the encrypted archive.

## Alternatives rejected

- Decrypting `role-evidence.tar.gpg` locally to read the failing title. The owner ruled that no agent decrypts it (c24395).
- Publishing the error message or step name. Error text can carry tenant data in a public artifact.
- Publishing report titles verbatim. A foreign or renamed title is attacker- or tenant-influenced text; the allowlist keeps the
  public surface to constants.

## Consequences

The next red run names the failing case and the project it ran in without exposing why it failed. The cause still needs the
private archive or a local reproduction. A renamed case shows as `missing` plus one unexpected case.
