# Agent skills

Shared skills for every agent session in this repository. Claude Code loads `.claude/skills/*/SKILL.md` automatically. They are guidance for how to work. They never replace `AGENTS.md`, the project instructions, Jira, or the repository's own gates.

## Precedence

1. `AGENTS.md`, the project instructions and the owner rulings (including SCRUM-760 and SCRUM-813).
2. `convex/_generated/ai/guidelines.md` for Convex code.
3. These skills.

A skill never lowers a gate. In particular:

- Money-touching changes still need the two-seat review (defined in the project instructions; if you do not have them, ask before merging any money change) on the final head SHA, or carried forward to it under the re-certification rule below (Seat 1: Opus 5.5 plus `/simplify` in a session separate from the implementer; Seat 2: Codex sol6 at medium effort or lower). Any subagent or "second opinion" a skill suggests is advisory and is not a seat.
- Never write `review-evidence/*.json`. Never claim a human review.
- The Production deploy approval in GitHub stays a human action.
- **Re-certification after the head moves (owner rule, 2026-10-19, set in the project chat).** A seat certifies one head SHA.
  - The PR's own code changed, or updating from main hit a merge conflict: both seats fully re-certify the new head.
  - The only change is a clean update from main and the PR's own diff is identical (same `git patch-id`, and no whitespace-only edits in the PR's own files): carry the certification forward. Re-run CI on the new head and note the carried SHA on the PR and the Jira issue.
  - That clean update brought in main changes to code the PR touches or depends on: run one short, scoped re-review of only the interaction, recorded against the new head SHA before merging. On a money PR, both seats do it, Seat 1 in a session separate from the implementer. On other PRs, one independent read-only reviewer does it.
  - A re-check that was not run is recorded as not run. Never claim a seat for a head it did not read.
- Skills that ask a person a question are answered by the decision rule in the project instructions (consult Codex sol6, medium effort at most). Codex quota is low, so skills do not trigger extra Codex runs.

## Which skill when

| Situation | Skill |
| --- | --- |
| Diagnosing a bug, shaping a non-trivial change, reviewing your own diff, or about to say "done" | `engineering-principles` |
| Something is broken, failing, throwing or slow and the cause is not obvious | `diagnosing-bugs`. Build a red-capable feedback loop before forming any theory. Redact: this repository is public. |
| Fixing a bug | `tdd`. Mandatory for money and permission bugs: the test fails before the fix and passes after (SCRUM-761). |
| Any change to money, permissions, tenancy, schema, indexes, crons, webhooks or shared helpers, and every review of one | `blast-radius`. Prove the one fact the change is safe because of by running real code. |
| Reporting or acting on any performance, I/O or cost number | `benchmark-checklist`. Tie the number to its measured source and name the limiter. |
| Writing or editing TypeScript or TSX | `typescript-best-practices`. `convex/_generated/ai/guidelines.md` wins inside `convex/`. |
| Before asking for review seats on your own change | `two-axis-review`: advisory Standards and Spec check against AGENTS.md and the Jira issue. It is never a seat and is never labelled as an independent review. |
| PR bodies, commit messages, docs, runbooks, RFCs | `technical-writing`, then `unslop` on the text. The PR template and attribution block still apply. |
| Replies, Jira comments, review notes | `unslop` |
| The same agent mistake has shown up twice in this repo | `correct`. Manual only. Raise a normal PR; it needs its own review. |

## Enforcement (owner request, 2026-10-20)

The table above is no longer left to memory. Two mechanisms check it. Both read their path list and skill list from `scripts/skillEnforcement/policy.mjs`, so they cannot drift.

1. **Session hook** (`.claude/settings.json`, `scripts/skillEnforcement/skillGate.mjs`). Before `git commit`, `git push`, `gh pr create` and the GitHub MCP write tools, the hook reads the session transcript and denies the step unless the required skills were invoked with the Skill tool in this session.
   - Commit and push: `typescript-best-practices` is not gated: it loads itself when a `.ts`/`.tsx` file is read or edited (its `paths` setting), so a gate on it would deadlock sessions that never opened such a file. On any file under `convex/` (default deny: money, permission, tenancy, schema, cron and webhook code all live there; only `convex/_generated/` and non-source files are exempt) also `tdd` and `blast-radius`. On gate or production-safeguard files (`AGENTS.md`, `.github/`, `.claude/`, release scripts) also `blast-radius`.
   - PR creation: `technical-writing` and `unslop`. On money or gate paths also `two-axis-review` and `engineering-principles`.
   - If the changed files cannot be determined, the hook treats the change as a money change. A crash blocks the step (`onFailure: block`).
   - It counts a skill only when the `Skill` tool call returned without error, or when the user typed the `/skill` command. Assistant text that mentions a skill counts for nothing.
   - It scans the raw command for git, so `do`, `then`, `else`, `timeout`, `nice`, `!`, `sudo -u`, `bash -c 'git commit'`, `env git push` and `$(git commit)` are all caught. It skips git only as an argument to `echo`, `printf` or `grep`, so `echo git commit` is not a commit.
   - `git -C <dir>` and an earlier `cd <dir>` inspect that directory's files. `--git-dir`, `--work-tree`, `GIT_DIR=` and a dynamic `cd` make the files unknown, which is treated as a money change.
   - For `git commit` the hook adds the command's pathspecs (`git commit -m x convex/sales.ts`, `--only`, `-- <path>`; git expands directories and globs) and `-a`/`--all` to the staged files. It fails closed (treats the change as money) when it cannot read the arguments: `-p`, a `$(…)` or `~` argument, an unclosed quote, a path outside the repository.
   - Text piped into a shell (`… | bash`, `curl … | sh`, `| xargs sh`), `eval`, PowerShell `iex`/`Invoke-Expression`/`& $cmd`/`-Command`, a `sh -c` with a dynamic argument, a command word held in a variable (`$g push`) and git aliases (`git -c alias.*`, `--config-env`, or any subcommand that is not a git built-in) are gated as an unknown commit and push, whatever produces the text. Quoted text that is an argument to a non-shell command (`grep -rn "eval(" src`, `echo "git push"`, `jira comment add "git push failed"`) is never scanned. A pipe into a shell stays gated even for harmless input (`curl … | sh`): its content cannot be known, so it is an accepted false block.
   - Known false blocks (fail closed, accepted): a commit that touches only `convex/` test files still needs `tdd` and `blast-radius`; a quoted example or heredoc body with `git push` after a separator; `ls git push`. Residual gaps: `"git" push` and a script or program that runs git itself.
   - It proves a skill was invoked, not that it was followed. An agent can still edit the hook, so it is a guard on mistakes, not a boundary.
2. **`skill-evidence` PR check** (`.github/workflows/skill-evidence.yml`). A PR that touches a money, permission or gate path must carry a `## Skill evidence` section in its body: skills run, the red run output, the `/simplify` output, the Seat 1 session link, model and certified SHA, and the Seat 2 model, effort and certified SHA. The check fails when the section is missing, still a placeholder, shows a red run with no failure sign (a non-zero failed count, `FAIL`, `AssertionError`), names the implementing session (in the body or a PR commit trailer) as Seat 1, gives a model or effort that is not exactly Opus 5.5 (Seat 1) or gpt-6-sol at low or medium (Seat 2), or cites a SHA that is not in the PR. It runs from `main` (`pull_request_target`), so a PR cannot loosen its own check, and it never reads or writes `review-evidence/*.json`.
   - A change that touches only test files and docs may replace the red run with `Red run: No behaviour change: <reason>`. It is valid only when no changed file is money or permission source (a `convex/` file that is not a `*.test.*`/`*.spec.*` file) and both the Seat 1 SHA and Seat 2 SHA lines also say "no behaviour change". Any sensitive source file needs a real red run.
   - The red run fence must name a test file that is in the PR diff and show a failure (a non-zero failed count, `FAIL`, `AssertionError`). The `/simplify` output must be at least 40 characters and name what was reviewed (reuse, simplification, efficiency, altitude, or no changes/findings).
   - **The check verifies form only.** It cannot prove a review happened or that the output is real. The seats' own signed PR comments are the authoritative evidence, and the check says so in its output.
   - The check reads only the PR body, so the seat evidence must be in the body. A certified SHA must be the PR head or a commit in the PR's own range, not an older commit on `main`.
   - The check validates form and consistency. It cannot prove the text is true. The session links let the owner verify.
   - It is only a gate once it is a required status check on `main` (repository setting). Until then a red result is visible but does not block merge.

The section template is `TEMPLATE` in `scripts/skillEnforcement/prSkillEvidence.mjs`; the check prints it on failure. Neither mechanism is a review seat, and neither replaces the two-seat review.

The pilot bug hunters (SCRUM-760) are not skills. Scenarios they find become backend tests or browser replays through `tdd` and SCRUM-761.

## Not adopted

From pstack (56 skills): These were read and left out on purpose:

- `poteto-mode` and its 23 playbooks, `figure-it-out`, the `orchestrate`, `autopilot-*`, `shipping` and `babysit` playbooks: tied to Cursor's subagent and model setup (Grok, `pstack-models.mdc`), and their autonomy rules (arm merges, land stacks, "never block on the human") conflict with the two-seat review, the deploy gate and the decision rule here.
- `architect`, `arena`, `swarm`, `interrogate`, `how`, `why`, `teach`, `recall`, `reflect`, `no-comments` with the `comment-sicko` agent: need Cursor's Task tool and model slugs, and Slack, Datadog and Linear sources we do not use. `interrogate` is a multi-model review panel, which would duplicate or blur the two-seat review. The comment-deletion rules are not this repository's convention.
- `setup-pstack` writes to `~/.claude/rules`, and `automate-me` edits personal skills. Both change the user's environment.
- `make-bot-ui` pipes a downloaded installer into `sudo sh` and joins the machine to a Tailscale network. Rejected on security grounds.
- `show-me-your-work`, `create-verification-skill`, the formal-verification skills, `sharpen`, `ketchup`, `bro`, `in-your-own-words`, `poteto-help`: overlap Jira, the status checklist and the existing Playwright scenario work, or add context cost for little gain.
- The `principle-*` skills are folded into `engineering-principles`, minus `outcome-oriented-execution` (allows planned intermediate breakage), `never-block-on-the-human`, and the Cursor-specific `guard-the-context-window`.

From Matt Pocock's skills (27 listed at aihero.dev/skills, MIT, `mattpocock/skills`):

- `grilling`, `grill-me`, `grill-with-docs`, `to-questionnaire`: interview the user and wait for answers. Threads here work without approval waits and use the decision rule instead.
- `to-spec`, `to-tickets`, `implement`, `implement-spec`, `triage`, `setup-matt-pocock-skills`: built around GitHub or GitLab issues and parallel worktree fleets that merge themselves. `wizard` generates a script that writes `.env` values and GitHub secrets, so it is rejected on security grounds. The tracker here is Jira, and merges follow the repository gates.
- `pr`: its PR body template conflicts with the required attribution block and Before/After/How format. Its one-way or two-way door and blast radius idea is already covered by `blast-radius`.
- `domain-modeling`, `codebase-design`, `improve-codebase-architecture`: would create a glossary and decision records, or propose refactors, in a money codebase without an owner ruling. Revisit if the owner wants a glossary.
- `wayfinder`, `prototype`, `research`, `retro`, `handoff`, `teach`, `wait-what`, `ask-matt`, `writing-for-agents`: overlap `correct`, the existing handoff flow, or what Claude does by default.
- The `misc` and `in-progress` skills, including `git-guardrails-claude-code`, which blocks `git push` and would stop threads from delivering work.
- Its `diagnosing-bugs` and `code-review` are adopted in adapted form. `code-review` is renamed `two-axis-review` so it does not shadow the built-in `/code-review`. Its `tdd` rules are folded into the existing `tdd` skill.

## Provenance

Adapted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan, MIT license (`PSTACK-LICENSE`), at `cursor/plugins` commit `d457567332aa6989e753ea289f30ea2bfbc80bc0`. Every file was read before adoption. None of the adopted files contains scripts, hooks or network calls. The changes are edits for Claude Code, removal of Cursor-only parts, and AutoFlow rules added to the end or the top of each skill.

Matt Pocock's skills, MIT license (`MATTPOCOCK-LICENSE`), `mattpocock/skills` commit `49dd158d1076134a641b33efb035946536778336`. The adopted files have no scripts. The interactive `hitl-loop.template.sh` from `diagnosing-bugs` was left out on purpose.

To refresh from upstream, diff against that commit, read the change, and re-apply the AutoFlow edits in a PR.
