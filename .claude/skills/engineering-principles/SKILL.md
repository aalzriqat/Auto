---
name: engineering-principles
description: Engineering rules for debugging, designing, testing, migrating and verifying changes in AutoFlow. Use when diagnosing a bug, shaping a non-trivial change, writing or reviewing tests, or before declaring work done.
---

# Engineering principles

> Condensed from the `principle-*` skills in pstack by Lauren Tan (MIT), cursor/plugins@d457567. See ../PSTACK-LICENSE and ../README.md. Rewritten and shortened for this repository. The rules in `AGENTS.md` and the project instructions always win.

Apply the sections that fit the task. Say which rule changed a decision when you report.

## Debugging

- **Fix root causes.** Reproduce first. Ask why until the answer is a wrong decision in the code. A guard, retry, clamp or swallowed error hides a bug unless the state it handles is legitimate. Find every place with the same fault. A workaround that needs a paragraph of comment is the wrong code.
- **Attack the premise.** When two fixes that share one assumption have failed the same check, write the assumption down and test it directly before writing a third fix.
- **Explain the number.** Before you trust or report a measurement, name what limits it and rule out errors, skipped work, caches and noise. For performance numbers use the `benchmark-checklist` skill.

## Design

- **Name the data shape first.** Define core types and access patterns before logic. Encode the domain in a state machine, discriminated union, table or small module, not scattered booleans and branches. Skip the abstraction when the current shape is clear and local.
- **Subtract before you add.** Delete dead code first. The smallest change that solves the problem wins. Consolidate a repeated decision behind one source of truth.
- **Minimize reader load.** Count the layers a reader traces and the state they hold. Inline one-caller wrappers. Prefer pure functions, narrow scope and derived values over synced copies.
- **Boundaries.** Validate and parse where data crosses in (webhooks, HTTP, Clerk, client arguments, stored documents). Trust typed values inside. Keep business logic in pure functions and the Convex function a thin shell.
- **Make illegal states unrepresentable.** Brand semantic primitives, parse external data into domain types, derive types from the schema instead of hand-writing a parallel one. See `typescript-best-practices`.
- **Idempotent operations.** For every state-changing step ask what happens if it runs twice and if the last run stopped halfway. Derive each step from the current state. Backfills are bounded and resumable.
- **Separate before serializing shared state.** If two actors write the same document, key, file or branch, remove the sharing first. A convention is not concurrency control. In Convex, a transaction is the serialization.
- **Migrate callers, then delete the legacy API** in one change when nothing external depends on it. Never when data or deployed clients still do.
- **Design twice for one-way doors.** Schema shape, indexes, money formulas and public contracts get two structurally different candidates before code. Reversible choices do not.

## Testing and verification

- **Test behavior, not implementation.** A test must fail when the behavior breaks and keep passing when only internals change. Derive expected values from the requirement, never from a run of the code under test.
- **Prove it works.** Check the real artifact, not a proxy such as "it compiles" or a summary. When a check passes too easily, suspect the observation method first.
- **Sequence verifiable units.** Small units, each ending in a check. Do not start the next until the current one is green. Order commits so the sequence proves itself, such as the failing test and then the fix.
- **Build the lever.** For non-trivial or repetitive work, write the small script or test that does or proves it, so a reviewer can rerun it.

## Not adopted from pstack

- "Outcome-oriented execution" allows planned intermediate breakage. That is not acceptable for money, permissions, schema or deployed data in this project.
- "Never block on the human" is replaced by the project autonomy and decision rules in `AGENTS.md` and the project instructions.
