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

## Labels and request surfaces

The `triage` skill is not installed, so this setup does not provision a triage-label vocabulary or create any labels. Preserve existing Jira statuses and labels. Apply `ready-for-agent` only if it already exists in SCRUM and the approved publishing scope includes applying it. If the label is absent, omit it and report its absence. Do not create the label or invent status mappings. The label never authorizes implementation or merge.

GitHub remains the code/PR/CI surface, not a second issue tracker. This setup adds no Slack messages or new posting automation. Existing project communication rules remain authoritative.
