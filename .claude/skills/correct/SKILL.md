---
name: correct
description: "Automatically invoke when evidence shows the same agent mistake has occurred twice in this repo, including across sessions. Do not wait for the operator to request /correct. Find the recurring mistake class and prevent it with architecture, types, lint, or tests before adding docs. Also use for /correct."
disable-model-invocation: false
---

# Correct

> Adapted from pstack by Lauren Tan (MIT), cursor/plugins@d457567. See ../PSTACK-LICENSE and ../README.md.

The operator keeps correcting agents in this repo for the same mistakes. Change the repo so the next agent can't make them.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Design the repo so a change that looks right from one file is right for the whole repo.

## Find the mistake classes

Invoke this skill as soon as you identify a second occurrence of the same agent mistake in this repo. Do not wait for another user correction or an explicit `/correct` command. Record evidence for both occurrences from the current session, commits, reverts, reviews, Jira, or repository memory. Two mentions of one incident are not two occurrences. If recurrence is not established, investigate before calling it a repeated mistake.

First, read recent commits, reverts, review comments, agent instruction files, and comments that explain workarounds. Group the mistakes into classes. A class counts once it has happened twice.

## Fix each class at the highest level that works

1. **Eliminate it with architecture.** Give each piece of state one owner and each task one supported way. Hide internals so the wrong import fails. Replace hand-synced lists with one source of truth. Delete old ways and dead code an agent would copy.
2. **Enforce it with types so the bad state can't be written.** If bad code still compiles, add a lint or CI check whose error names the file, type, or function to use instead. If the pattern is already common, fail only when a change adds more.
3. **Test the behavior.** Fix or delete any test that still passes when the behavior it checks breaks, or that fails when only the internals change.
4. **Write docs or agent rules last, only for judgment calls.** Nothing fails when an agent skips them.

## Fix and prove

Then fix the most frequent classes now, one commit each. Prove each new check fails on a real past mistake. Run the same command locally and in CI. Exceptions go on the offending line with a reason, an expiry date, and a human's approval.

## Keep the rule table

Last, keep a table in the agent instruction file that pairs each rule with what enforces it. When the operator corrects you, fix the mistake and add the rule. If the rule was already there and nothing enforces it, that's a repeat, so fix it at the highest level in the same change. Drop a rule once its mistake can't happen.

**Reply:** each class with its evidence, the level you picked, and why a higher level didn't work.

## AutoFlow constraints

- Automatic invocation starts diagnosis and prevention work. It does not authorize unrelated changes, pin renewals, flag writes, merges, or deployments. Keep the prevention change within the authorized scope, or record a scoped follow-up in Jira. Apply the normal review gates to any resulting PR.
- A new lint, test or CI check goes through a normal PR with its own review. It never weakens, skips or waives an existing check, and never touches `.github/release-waivers.json` or the review policy to get a change through.
- Money, permission and tenancy rules belong in backend code and tests, not in agent rule text.
- Agent rule text goes in `AGENTS.md` or `.claude/skills/README.md`, and only for judgment calls nothing can enforce.
