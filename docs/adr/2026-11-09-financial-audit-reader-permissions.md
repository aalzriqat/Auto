# Financial audit copies inherit their source reader's permissions

Date: 2026-11-09. Issue: SCRUM-936. Baseline: 0498711b0cd642631a4b5c85a1b60fca01c7257f.
Status: accepted for implementation, pending independent review.

Invariant: `financialAudit.listAuditLog` must not disclose an amount, protected
identity, or free text that the source reader withholds from the same viewer.
`manage:finance` authorizes reading the event trail, not every copied payload.
The coordinator supplied SCRUM-902 c24475 and the S850-R5-1, S850-R6-1 and
S850-R7-PRE-1 reproductions. Jira, review seats and release work belong to the
coordinator. This change writes no production data and activates no pilot door.

## Decision and alternatives

Candidate A projects every result of the four audit query branches through one
exhaustive action-policy table. The action union comes from the stored schema.
An unclassified action fails compilation and a runtime coverage test. The
restricted result contains explicit event metadata, fixed amount-free text and
validated counts. It excludes arbitrary payloads and command keys. Safe opening
edit summaries introduced by #792 retain their existing version/count contract
through an allowlist, including when an older row contains extra amount fields.

Candidate B changes writers to store summaries only. This reduces copied data,
but cannot protect historical rows and permanently discards detail even from
authorized auditors. Every new writer could independently repeat the defect.

Choose A. Also remove numeric totals from new descriptions; structured payloads
remain available to authorized readers. No text parsing determines permission.
Reuse the cost predicate and the existing payroll and commission grants. Opening
payroll checks must cover allocation kinds and legacy employee control lines.
The ordinary-finance, cost and commission classifications are established from
the complete writer census, rather than from action names alone. Mixed actions
such as `POST_EVENT` and `ALLOCATE_PAYMENT` need their resource-specific policy.
Pending manual journal drafts keep the existing `manage:finance` audience.

## Impact and design attacks

Writers remain append-only. Stored rows, reversals, retries and voids pass through
the same projection; there is no migration, deletion, balance change or reversal
obligation. Tenant authentication and indexed organization scoping remain on the
server. Authorized readers retain original rows. Resource, actor, action and time
remain visible, while payload entity ids and arbitrary text are withheld.

Predicted failures to test: a branch bypasses projection; a new action lacks a
classification; legacy descriptions or payload ids leak; cost access bypasses
payroll withholding; ordinary finance or authorized commission readers lose data.
Public-function tests exercise each branch, source-reader negative controls and
authorized positive controls. Mutants remove each branch's projection and the
posted-journal classification. UI consumers are enumerated before finalization.
Local `convex-test` proves serial behavior, not platform limits, OCC, cloud
behavior or production prevalence. Independent seats and CI remain outstanding.

## Sources checked

- [OWASP Logging Cheat Sheet, data to exclude](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html#data-to-exclude): restrict sensitive log data and log access.
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): least privilege, deny by default, server-side checks on every request and authorization tests.
- [Convex auth in functions](https://docs.convex.dev/auth/functions-auth): derive identity from the function context on the server.

These sources support the design; repository tests must establish the behavior.


Implementation review refined the projection before freeze. Restricted rows
retain the resource type and audit-event id, and replace protected source ids
with `WITHHELD`. The SCRUM-850 regression now asserts that stronger exclusion.
Opening void text uses the maintenance reader's manage-payroll grant, distinct
from opening allocation readback's view-or-manage grant. Untyped historical edit
payloads without a provable payroll audience are withheld even if today's draft
no longer contains employee controls. Unwind actors retain the same remittance
fields as `unwindStatus`, through its shared predicate, while free text and the
forward contribution stay withheld. Both `lines` and `lineCount` producer shapes
retain their counts.

The new indexed journal-to-opening lookup follows [Convex's native index
pattern](https://docs.convex.dev/database/reading-data/indexes/). Exhaustive
classification uses TypeScript's [`satisfies` operator](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator).
