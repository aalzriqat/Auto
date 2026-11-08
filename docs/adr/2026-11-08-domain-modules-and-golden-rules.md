# Domain modules behind stable Convex doors, one writer per fact, machine-enforced ratchets

Status: accepted. This is the repository copy of the SCRUM-418 architecture decision. It records the decision of 2026-09-28 (owner approval in SCRUM-418 comment c21105) as amended on 2026-11-08 to follow the owner's ten golden rules and Matt Pocock's deep-module rules (SCRUM-418 §6, A1 to A10), and as refined by the planning interview of 2026-11-09 (c24800, c24801). Under the owner ruling of 2026-11-09, design questions in this refactor are answered by what Matt Pocock's rules would choose, and each answer is recorded in SCRUM-418. Jira SCRUM-418 remains the live record. If this file and Jira disagree, Jira wins and this file is corrected in a reviewed PR.

## Context

Change cost here comes from concentration, not from the technology. A handful of files hold most of the business rules and take most of the commits: the single Convex schema, the deal entry-point module, the deal cockpit component, and the accounting workflow hooks and posting rules. Rules that should have one owner are written out in several places and have already drifted: tearing down a completed sale exists twice with its steps in a different order, deal status is written outside the transition map, the web and mobile clients re-derive profit and permission rules the server already decides, and tenant checks are hand-written at hundreds of sites. Count pins in tests turn every new mutation into a merge conflict.

## Decision

1. **Stable doors.** Public Convex function paths and their argument and return contracts do not change; the mobile app hard-codes them. A file `convex/<module>.ts` becomes a thin door: validators, authentication, one call into a domain, and the return.
2. **One folder per business domain, one small interface (A1).** Logic moves into `convex/domains/<domain>/`. There are nine domains: Deal (quotes, finance applications, sales, handover), Inventory (vehicles, consignment intake), Accounting (ledger, postings, periods, accounting outbox), Collections (receipts, payments, cheques), Suppliers, Expenses, Commissions and payroll, Customers, and Organization and access. A Sale is the completed result of a Deal, so sales belong to Deal rather than to a domain of their own. "Deal" is the canonical name in the glossary, the domain folder (`convex/domains/deal/`) and new code; "finance application" names only the finance part of a deal, and the existing `applications.ts` and `financeApplications` keep their names because public paths do not change. Each domain exposes one `index.ts`; everything else in the folder is private to it. Other domains and doors import only that interface. The internal layout of a domain is its own choice. A domain folder is created only when a step moves real code into it, and only if it passes the deletion test: no pass-through modules, no empty folders made for symmetry.
3. **The mutation is the transaction boundary.** Domain commands are plain functions taking the mutation context, the actor and the input, called synchronously and awaited from the door. No chaining of mutations to split one transaction, no ORM, no repository classes, no dependency-injection container ([Convex: use helper functions to write shared code](https://docs.convex.dev/understanding/best-practices/#use-helper-functions-to-write-shared-code); [Convex: mutations are transactions](https://docs.convex.dev/functions/mutation-functions#transactions)).
4. **Explicit lifecycle commands over a composite state, one writer per fact.** The deal lifecycle is the deal status, credit decision, gap resolution, handover status and settlement, not one large enum. One guarded authority writes each lifecycle field, together with its status log and required side effects, in the same transaction. A generic "set status" bypass does not count as a single writer.
5. **The server decides; the UI presents (A2).** The deal read model returns the caller's next action as a command, whether it is enabled, and the first refusal reason code, computed by the same readiness rule the mutation re-checks. The next action is a projection, never an authorization token. The UI never re-derives permission, refusal or money rules. Domain policy imports no React and no generated server module.
6. **Money authority stays on the server.** Canonical deal economics, profit, commission policy, the treatment of SOURCED (consignment) vehicles and posting decisions are computed on the server. Web and mobile show server previews. Shared packages keep display formatting and the already-shared pure financing helpers, never a second client profit or consignment policy. Owned versus sourced economics belong to the Deal domain, in one module; Inventory records only who owns a vehicle.
7. **Tenancy by construction (A6).** `orgQuery` and `orgMutation` builders, made with convex-helpers custom functions, give every public function a tenant-checked context. They replace hand-written organization checks, including for lists, writes and related-row ownership. They become mandatory for new public functions once they exist (migration step 3). Exceptions live in one checked-in list, each entry with a reason, and adding an entry needs both review seats. Logic that is not public uses internal functions, and the door checks the command's permission.
8. **One authority per rule (A3).** Posting identity keys are built only by their event family's builder; completion refusal precedence, completed-sale cancellation and commission basis each have one owning module; each refusal's error code and English text are declared once, by the module that owns the refusal.
9. **Typed, validated boundaries (A5).** Every public Convex function declares `args` and `returns` validators ([Convex: argument and return value validation](https://docs.convex.dev/functions/validation)). Money crosses every seam as integer minor units plus a currency: arguments, read models and posting data. Stored fields still in major units are converted later, one field at a time, each with its own ticket and ADR. A door that moves to minor-unit arguments accepts both the old and the new field until no deployed mobile build sends the old one, then the old field is removed (expand and contract). Each posting rule exports a typed payload builder. A business refusal throws `ConvexError` with a typed code and no internal detail, and the UI shows the English or Arabic text; an unexpected error is logged on the server and the client receives only a generic message ([Convex: application errors](https://docs.convex.dev/functions/error-handling/application-errors)).
10. **Idempotent commands, recoverable async work (A7).** Every retried business command carries an idempotency key checked on the server in the same transaction, added door by door as each door moves behind a command service (step 6). One client module owns minting, retiring and fencing those keys (step 5). A duplicate submit of a money command produces exactly one receipt, one settlement and one journal, and a test proves it. The accounting outbox keeps hold and dead-letter states with a reason, and redrive is tested.
11. **Tests through the public interface (A8).** Each module's interface is what its tests lock. Work in vertical slices: one test, then one implementation. Every invariant gets positive, negative, authorization-failure and regression cases. Where `convex-test` cannot prove concurrency, because it serializes transactions, the gap is recorded rather than claimed. Each domain has a fast targeted test command. Parity and visual tests stay, but stop being the main proof of logic.
12. **Observability and read budgets (A9).** One structured log per door call (operation, organization, actor, command id, duration, outcome, reason code; no personal data and no economic figures beyond ids). Unknown outcomes are reported through Convex's built-in logs; no new error-reporting vendor is added for web or Convex until a ticket shows the need. Every query reads through an index and lists paginate ([Convex best practices](https://docs.convex.dev/understanding/best-practices/)). Hot read models carry a documented read budget, checked before and after each change.
13. **Shared language and recorded decisions (A4, A10).** `GLOSSARY.md` at the repository root holds the business terms and the architecture vocabulary. This ADR mirrors the decision next to the code. CODEOWNERS is not used: with one human owner it fails the deletion test. Schema and data changes follow widen, migrate, narrow, and every deploy states its rollback. The architecture survey runs periodically on the files that change most.

The SOLID principles apply in this narrow form: single responsibility as one writer per fact and one command per module; interface segregation as small, caller-specific read models; dependency inversion only at the seam between a command and its pure policy; open-closed as exhaustive typed command and event variants, so a new source of money must declare how it is reversed.

## Guardrails

Machine checks land before any large move (SCRUM-426, SCRUM-169). Each compares a change against the trusted target branch, so a pull request cannot raise its own allowance, and new debt fails from the first guardrail PR.

1. File size: new production files are at most 600 formatted lines; existing larger files are capped at their current size and the cap only goes down.
2. Import boundaries: policy imports no generated server module, React or door; nothing imports a door; components do not import Convex utilities or domain internals; one domain imports another only through its `index.ts`.
3. Single writer: deal lifecycle fields are written only from the transitions module.
4. Count pins become enumerated sets, each skip with a reason.
5. Byte pins are replaced in stages, only after behaviour guards with negative controls cover the protected paths.
6. Ticket and reviewer history goes in commits and Jira, not source comments.
7. Separate typecheck gates for the root, Convex, shared and mobile code.
8. Type escapes (`any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`) only go down.
9. Public functions not built with the tenant builders only go down, and new ones fail once the builders exist.
10. No new unbounded `.collect()` on a growing table and no new query `.filter` without an index.
11. Every new public Convex function declares `args` and `returns` validators.

## Migration sequence

Each step is a small PR that is proven behaviour-identical, and moves are kept separate from behaviour changes. Steps 2 to 7 run one at a time, one session per step, and the next starts only after the previous one has merged. Each step gets its own spec in Jira just before it begins, and each spec designs its main interface twice before any code.

1. Guardrails 1, 2, 4 and 8 to 11 in ratchet mode, characterisation tests (deal stages, next action by role, projections, owned versus sourced economics, journals and reversals), `GLOSSARY.md` and this ADR.
2. The mechanical split of the schema into `convex/schemaParts/`, one file per domain and nothing else (SCRUM-282), proven by identical codegen and a comparison of the effective tables, validators and indexes. It lands the same day, in a short freeze agreed with the SCRUM-760 coordinator, when no open pilot PR that touches the schema is in review.
3. The tenant builders, migrating low-risk modules first.
4. The pure deal lifecycle transition table, then the single-writer transitions module, starting with `status` and `handoverStatus`, one transition per vertical slice, tested through the transitions module's interface.
5. The next action from the server read model (first consumer SCRUM-417), then the per-stage cockpit split (SCRUM-336).
6. Command services, one door at a time, low risk first.
7. Last, accounting workflow hooks and posting rules split into a registry, proven by identical journals on the accounting rehearsal cases.

Collision rule: one owner per hot-spot file, small PRs landed within a day, and generated-file conflicts resolved by regenerating, never by hand.

## Gates this decision does not change

- Finalizing, cancelling and creating a deal from a quote, the single completed-sale teardown, and accounting authority are extracted only after SCRUM-407, SCRUM-411 and SCRUM-413 have merged and the integrated baseline is verified, each with its own release requirements.
- Characterisation tests never preserve a known bug. Where two implementations disagree, such as the two completed-sale teardown orders, the approved order is settled first (SCRUM-704) with a failing-first regression test before they are unified.
- Every money or permission PR still needs its own ADR, both review seats, and the repository's CI and deploy gates.

## Considered options

- **Money calculations shared with web and mobile.** Rejected in favour of server authority, so there is one posting authority and the consignment rule cannot drift into a client.
- **Removing byte pins once a file holds only doors.** Adopted as the end state, but only after behaviour guards with negative controls cover the same paths.
- **An 800-line budget.** Rejected for 600 lines on new files, with ratchets for existing ones, counted the same way the formatter lays the code out.
- **A mandated commands, policy and reads sub-folder in every domain.** Replaced on 2026-11-08 by one interface per domain, because a fixed layout invites shallow pass-through modules.
- **Class hierarchies, repository interfaces, dependency-injection containers, one giant lifecycle enum, and splitting one transaction into several mutations.** Rejected: they add indirection without a second adapter to justify the seam, or they break the transaction boundary.
