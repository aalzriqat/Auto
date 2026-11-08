# Issue tracker: Jira

AutoFlow work lives in Jira project `SCRUM` on `https://autoflowdealer.atlassian.net`. Use the connected Atlassian Jira tools, not duplicate GitHub Issues or local markdown tickets. Current cloud ID: `028a6ec2-f5df-4b8b-a13a-d7e9cafd3c6c` (a site identifier, not a credential).

## Existing owner workflow

- Read the relevant Jira issue, its comments, linked blockers and parent before material work. Search for an existing issue before creating one; reuse the existing issue when it describes the same work.
- Jira is authoritative for current issue state and owner rulings. The pilot gate is SCRUM-760; current contract-repair lineage includes SCRUM-711 and SCRUM-862. Fetch these live when that scope applies rather than treating this note as current completion evidence.
- Prefix Codex issue descriptions and progress comments with `[Codex Update]`, or `[Codex Review]` for reviews. Preserve the session's ownership and coordination rules.
- Follow each invoked skill's actual publishing prerequisites. For decisions it requires, use the invoking user's approval or an applicable existing [documented owner decision-rule delegation](../../.claude/skills/README.md#precedence). Before publishing, record the draft scope and actual user approval or delegated decision in the task/Jira context; reuse existing authorization rather than adding an approval gate. An automated decision is never a human review. Planning completeness does not authorize implementation, merge, deployment, purchases or new credentials.
- Keep all repository financial, tenancy, review, CI and human deployment gates. Merged, deployed and production-verified are distinct states. Do not mark Done merely because a spec or ticket has been published.

## Native operations

- Read/search: use the connected Jira issue reader and JQL search scoped to project SCRUM and the relevant keys/topic. Read full descriptions and comments where needed.
- Publish: create the approved spec as one Jira issue, or each approved vertical slice as its own issue. Reuse an existing matching issue rather than duplicating it.
- Parent: use Jira's supported parent relationship only where the project's issue types allow it. Otherwise keep an explicit linked parent reference; do not invent unsupported parent/subtask types or close/modify the parent without authorization.
- Blocking edges: use the native `Blocks` issue-link type. Live inspection found ID `10000`, outward `blocks`, inward `is blocked by`; resolve these again before writing. Verify direction and read the links back. If unavailable or unauthorized, report that limitation rather than silently converting native dependencies into prose or changing Jira configuration.
- After writes, read back the saved issue body, fields and links to confirm the artifact and dependencies were preserved. Never include secrets, personal data or private local paths in public artifacts.

## Wayfinding operations

How `/wayfinder` keeps its map in Jira. The owner approved these operations on 2026-11-08 (SCRUM-933). Owner rulings and the decision rule bind every decision the map records. If Jira refuses a `Subtask` or a `Blocks` link, report that limitation instead of working around it.

- **Map:** one Jira `Task` with the label `wayfinder:map`. Its parent is the epic the effort belongs to, for example SCRUM-418 for the architecture refactor. The Task description is the map body: Destination, Notes, Decisions so far, Not yet specified, Out of scope.
- **Tickets:** each decision ticket is a Jira `Subtask` of the map, with exactly one label `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` or `wayfinder:task`. The description holds only `## Question`.
- **Coordinator:** each map has exactly one coordinator session at a time. Every wayfinder session runs `/wayfinder`, so running it does not make a session the coordinator. The `coord.mjs` claim does. Before a session acts as coordinator, it checks the workstation's `coord.mjs` claims for one that names the map key, and stops if another session holds it. Otherwise it claims with the map key in the claim text, and completes that claim when the session ends. If the session that holds the claim is gone, another session takes the claim over only after the owner confirms. Only the coordinator assigns tickets, edits the map, and moves tickets to Done. Any other session or subagent that works a ticket, such as a research subagent, posts its findings as a ticket comment and changes nothing else. If `coord.mjs` is not available, run only one wayfinder session at a time.
- **Claim:** the coordinator assigns a ticket before work on it starts. The assignee only hides the ticket from the frontier query. It cannot tell two agent sessions apart. The coordinator claim does. When work on a ticket is abandoned, the coordinator unassigns it so the frontier query shows it again.
- **Blocking:** the native `Blocks` link, as above. Create every ticket first, then wire the links in a second pass with real keys.
- **Frontier:** `parent = <map key> AND statusCategory != Done AND assignee is EMPTY ORDER BY created ASC`. JQL cannot filter on the state of linked issues, so read each result's `is blocked by` links and drop every ticket that has one that is not Done. The first ticket left is the next one.
- **Map edits:** only the coordinator edits the map. Jira keeps the last write to a description, so read the map just before you edit it, then read it back and re-apply any line that is missing.
- **Resolve:** post the answer as a comment with the usual agent prefix, move the ticket to Done, and add one line to the map's Decisions so far that links the ticket.
- **Out of scope:** post a comment that starts with the agent prefix, then `Out of scope:` and the reason. Move the ticket to Done and add one line to the map's Out of scope section. Do not add it to Decisions so far.
- **Retire a ticket:** when a ticket no longer applies, close it with a comment that says why. Never delete a Jira issue.
- **Map complete:** when the map has no open tickets and Not yet specified is empty, post the destination as a comment, move the map to Done, and continue with `/to-spec` or the next step the Destination names.

Some upstream steps change for this repository, because it is public and every pushed branch is public too:

- **Research tickets:** the upstream `research` skill writes a Markdown file in the repository and pushes a `research/<name>` branch. Write the notes to the OS temp directory instead, post the findings as a ticket comment, and push nothing.
- **Prototype tickets:** build the prototype in the OS temp directory or on a local branch that is never pushed or deployed. Record the answer as a ticket comment. Never fold the prototype into real code. Real code changes go through `/to-tickets` or ordinary issues and the repository gates.
- **Task tickets:** the owner does every sign-up, purchase, access grant and credential step. An agent never uses production data for a task ticket, and the answer never records where a credential is kept.

The `wayfinder:` labels go only on a map and its tickets. Decision tickets never carry `ready-for-agent`. A resolved map authorizes planning only. Implementation still goes through `/to-tickets` or ordinary issues and the repository gates.

## Labels and request surfaces

The `triage` skill is not adopted, so this setup does not provision a triage-label vocabulary or create any labels other than the `wayfinder:` labels above. Preserve existing Jira statuses and labels. Apply `ready-for-agent` only if it already exists in SCRUM and the approved publishing scope includes applying it. If the label is absent, omit it and report its absence. Do not create the label or invent status mappings. The label never authorizes implementation or merge.

GitHub remains the code/PR/CI surface, not a second issue tracker. This setup adds no Slack messages or new posting automation. Existing project communication rules remain authoritative.
