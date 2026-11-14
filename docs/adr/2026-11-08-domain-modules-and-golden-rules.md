# Domain modules behind stable Convex doors, one writer per fact, and machine-checked limits

Status: accepted. This is the repository copy of the SCRUM-418 architecture decision. It records the decision of 2026-09-28, which the owner approved in SCRUM-418 comment c21105.

Two later changes refine it. On 2026-11-08 the decision was amended to follow the owner's ten golden rules and Matt Pocock's deep-module rules (SCRUM-418 §6, A1 to A10). The planning interview of 2026-11-09 (c24800, c24801) and the review response c24806 then set the timing of guardrail 9. The owner ruled on 2026-11-08 that this epic is not a SCRUM-760 blocker. Where this ADR does not amend c21105, c21105 binds in full, including every acceptance refinement. Jira SCRUM-418 remains the live record. If this file and Jira disagree, Jira wins and a reviewed PR corrects this file.

Under the owner ruling of 2026-11-09, the agent answers design questions in this refactor by what Matt Pocock's rules would choose, and records each answer in SCRUM-418. For this epic that ruling overrides the sentence in `.claude/skills/README.md` that says an agent never answers its own grilling questions. Where those rules say nothing, the agent follows established practice and says so. Owner rulings, the money gate (SCRUM-407, 411 and 413) and the gates in "Gates this decision does not change" still bind (c24801).

## Context

Change cost here comes from concentration, not from the technology. A handful of files hold most of the business rules and take most of the commits. They are the single Convex schema, the file of deal doors, the deal cockpit, and the accounting workflow hooks and posting rules.

Several files repeat rules that should have one owner, and the copies have already drifted:

- Tearing down a completed sale exists twice, with its steps in a different order.
- Code writes deal status outside the transition map.
- The web and mobile clients re-derive profit and permission rules that the server already decides.
- Developers hand-write tenant checks at hundreds of sites.

Count pins in tests turn every new mutation into a merge conflict.

## Decision

1. **Stable doors.** Public Convex function paths, their argument and return contracts and their authorization behavior do not change during a move, because the mobile app hard-codes the paths. Each public function in a file `convex/<module>.ts` becomes a thin door: validators, authentication, one call into a domain, and the return.
2. **One folder per business domain, one small interface (A1).** Logic moves into `convex/domains/<domain>/`. There are nine domains, and `GLOSSARY.md` lists them with their scope. Each domain exposes one `index.ts`, and everything else in the folder is private to it. Guardrail 2 sets the import rules. The internal layout of a domain is its own choice. A step creates a domain folder only when it moves real code into it, and only if the folder passes the deletion test: no pass-through modules, no empty folders made for symmetry.

   Naming rule (c24800): a Sale is the completed result of a Deal, so sales belong to Deal rather than to a domain of their own. "Deal" is the canonical term in the glossary, the domain folder (`convex/domains/deal/`) and all new code. "Finance application" names only the finance part of a deal. `applications.ts` and `financeApplications` keep their names, because public function paths stay unchanged.
3. **The mutation is the transaction boundary.** Domain commands are plain functions taking the mutation context, the actor and the input, called synchronously and awaited from the door. No chaining of mutations to split one transaction, no ORM, no repository classes, no dependency-injection container ([Convex: use helper functions to write shared code](https://docs.convex.dev/understanding/best-practices/#use-helper-functions-to-write-shared-code), [Convex: mutations are transactions](https://docs.convex.dev/functions/mutation-functions#transactions)).
4. **Explicit lifecycle commands over a composite state, one writer per fact.** The deal lifecycle is the deal status, credit decision, shortfall resolution (the stored field is `gapResolution`), handover status and settlement, not one large enum. One guarded authority writes each lifecycle field, together with its status log and required side effects, in the same transaction. A generic "set status" bypass does not count as a single writer, and the source-level guard covers the actual supported write forms, not only literal status patches.
5. **The server decides and the UI presents (A2).** The deal read model returns the caller's next action as a command, whether it is enabled, and the first refusal reason code, which the same readiness rule computes and the mutation re-checks. The next action is a projection, never an authorization token. Refusals carry stable reason codes plus role-safe parameters (SCRUM-414), and the client localizes them in Arabic and English. An action that another role handles names the handoff without leaking protected economics. The UI never re-derives permission, refusal or money rules.
6. **Money authority stays on the server.** The server computes canonical deal economics, profit, commission policy, the treatment of sourced vehicles and posting decisions. Web and mobile show server previews. A client preview never authorizes a financial write, and the mutation resolves its own inputs and recomputes and validates the result. This refactor does not revive the paused automatic commission. Shared packages keep display formatting and the already-shared pure financing helpers, never a second client profit or consignment policy. Owned versus sourced economics belong to the Deal domain, in one module. Inventory records only who owns a vehicle.
7. **Tenancy by construction (A6).** `orgQuery` and `orgMutation` builders, made with convex-helpers custom functions, give every public function a tenant-checked context. They replace hand-written organization checks, including for lists, writes and related-row ownership. They become mandatory for new public functions from the PR that adds them (migration step 3). Guardrail 9 sets when the check starts to block. Exceptions live in one checked-in list, each entry with a reason, and adding an entry needs both review seats. Logic that is not public uses internal functions, and the door checks the command's permission.
8. **One authority per rule (A3).** Only the builder for an event family builds that family's posting identity keys. Completion refusal precedence, completed-sale cancellation and commission basis each have one owning module. The module that owns a refusal declares its error code and English text once.
9. **Typed, validated interfaces (A5).** Every public Convex function declares `args` and `returns` validators ([Convex: argument and return value validation](https://docs.convex.dev/functions/validation)). Money crosses every seam as integer minor units plus a currency: arguments, read models and posting data. The first case is `DealInvoiceReceiptsPanel`, which sends major units to `collections.recordPayment`. Later changes convert the stored fields still in major units, one field at a time, each with its own ticket and ADR. A door that moves to minor-unit arguments accepts both the old and the new field until no deployed mobile build sends the old one, then the old field is removed (expand and contract). Each posting rule exports a typed payload builder. A business refusal throws `ConvexError` with a typed code and no internal detail, and the UI shows the English or Arabic text. An unexpected error is logged on the server and the client receives only a generic message ([Convex: application errors](https://docs.convex.dev/functions/error-handling/application-errors)).
10. **Idempotent commands, recoverable async work (A7).** Every retried business command carries an idempotency key checked on the server in the same transaction, added door by door as each door moves behind a command module (step 6). One client module owns minting, retiring and fencing those keys (step 5). A duplicate submit of a money command produces exactly one receipt, one settlement and one journal, and a test proves it. The accounting outbox keeps hold and dead-letter states with a reason, and redrive is tested.
11. **Tests through the public interface (A8).** Each module's interface is what its tests lock. Work in vertical slices: one test, then one implementation. Every invariant gets positive, negative, authorization-failure and regression cases. Where `convex-test` cannot prove concurrency, because it serializes transactions, the gap is recorded rather than claimed. Each domain has a fast targeted test command. Parity and visual tests stay, but stop being the main proof of logic.
12. **Observability and read budgets (A9).** One structured log per door call with the operation, organization, actor, command id, duration, outcome and reason code. It holds no personal data and no economic figures beyond ids. Convex's built-in logs report unknown outcomes. No new error-reporting vendor is added for web or Convex until a ticket shows the need. Every query reads through an index and lists paginate ([Convex best practices](https://docs.convex.dev/understanding/best-practices/)). Hot read models, such as the deal cockpit and the accounting reports, carry a documented read budget. Convex insights, which report the database reads of each function, measure it before and after each change.
13. **Shared language and recorded decisions (A4, A10).** `GLOSSARY.md` at the repository root holds the business terms and the architecture vocabulary. Business thresholds become named constants, and reviews apply the deletion test. Code and reviews use the architecture vocabulary exactly, as the `codebase-design` skill sets it. They avoid "component", "service" and "API" in place of Module and Interface, and they do not call a module seam a "boundary". This ADR mirrors the decision next to the code. CODEOWNERS is not used: with one human owner it fails the deletion test. Schema and data changes follow widen, migrate, narrow, and every deploy states how it is undone. The architecture survey runs periodically on the files that change most.

The SOLID principles apply only through decisions 4, 5, 8 and 9: one writer per fact, small read models for each kind of caller, dependency inversion only between a command and its pure policy, and exhaustive typed variants so a new source of money must declare how it is reversed.

## Guardrails

Machine checks land before any large move (SCRUM-426, SCRUM-169). Each compares a change against the trusted target branch, so a pull request must not silently raise the allowance it is checked against, and new debt fails from the first guardrail PR. Guardrail 9 is the one exception, and its entry gives the timing.

1. File size: new production files are at most 600 formatted lines, and existing larger files are capped at their current size. The cap lowers itself when the file shrinks. Any exclusion is explicit, narrow and reviewed, and generated files are identified explicitly. The count follows the formatter's layout, and nobody compresses code, strips useful comments or splits files into arbitrary part1, part2 or utils buckets to meet it. An ESLint `max-lines-per-function` warning at 150 lines is planned and deferred from step 1.
2. Import rules: policy imports no generated server module, React or door. Nothing imports a door. Components import neither `convex/utils/*` nor `convex/domains/**`, including a domain's `index.ts`, so no server domain policy reaches the client. One domain imports another only through its `index.ts`.
3. Single writer: only the transitions module writes deal lifecycle fields, and the guard covers every supported write form.
4. Count pins become enumerated sets, each skip with a reason. The guard compares each set against independently discovered implementation entries, and never regenerates the set and the list together until they agree.
5. Byte pins are replaced in stages, and existing protection stays until behaviour guards with negative controls cover the protected paths. Each replacement needs a mapping from path to invariant to test, and the negative controls must show that the tests reject representative regressions. The whole-file `applications.ts` pin is removed only once the file holds only doors and the replacement checks are required. The end state is that any remaining justified pins narrow to small authority modules. Extracting a file never creates a permanent new pin.
6. Ticket and reviewer history goes in commits and Jira, not source comments. A lint rule bans reviewer names in `convex/**`.
7. Separate typecheck gates for the root, Convex, shared and mobile code.
8. Type escapes (`any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`) only go down.
9. Public functions not built with the tenant builders. From step 1 this guardrail counts these functions and reports the count, and it blocks nothing, because the builders do not exist yet. The PR that adds `orgQuery` and `orgMutation` (step 3) makes it block new debt. From then on the count only goes down and every new public function uses the builders. A rule is enforced together with the way to comply with it. This timing follows SCRUM-426 comment c24798 and SCRUM-418 comment c24806.
10. No new unbounded `.collect()` on a growing table and no new query `.filter` without an index.
11. Every new public Convex function declares `args` and `returns` validators.

## Migration sequence

Each step is a small PR that tests prove behaviour-identical, and moves stay separate from behaviour changes. Steps 2 to 7 run one at a time, one session per step, and the next starts only after the previous one has merged. Step 2 starts only after step 1 (SCRUM-426) has merged. Each step gets its own spec in Jira just before it begins, and each spec designs its main interface twice before any code.

1. Guardrails 1, 2, 4 and 8 to 11 (guardrail 9 as a report only), each as a limit that can only go down, characterisation tests (deal stages, next action by role, projections, owned versus sourced economics, journals and reversals), `GLOSSARY.md` and this ADR.
2. The mechanical split of the schema into `convex/schemaParts/`, one file per domain and nothing else (SCRUM-282). The split covers the mobile facade and runs the separate root, Convex, shared and mobile typechecks. It is proven by identical codegen and a comparison of the effective tables, validators and indexes. The split rejects duplicate table keys. It lands the same day, in a short freeze agreed with the SCRUM-760 coordinator, when no open pilot PR that touches the schema is in review.
3. The tenant builders, migrating low-risk modules first. This PR also makes guardrail 9 blocking.
4. The pure deal lifecycle transition table, then the single-writer transitions module, starting with `status` and `handoverStatus`, one transition per vertical slice, tested through the transitions module's interface.
5. The next action from the server read model (first consumer SCRUM-417), then the per-stage cockpit split (SCRUM-336). The proof is the visual gate plus the `DealCockpit*` suites.
6. Command modules, one door at a time, low risk first. The money gate below applies to this step.
7. Last, accounting workflow hooks and posting rules split into a registry, proven by identical journals on the accounting rehearsal cases.

Collision rule: one candidate per lane, one owner per hot-spot file, small PRs landed within a day, and generated-file conflicts resolved by regenerating, never by hand.

## Gates this decision does not change

- Finalizing, cancelling and creating a deal from a quote, the single completed-sale teardown, and accounting authority move only after SCRUM-407, SCRUM-411 and SCRUM-413 have merged. The integrated baseline must also be verified, each with its own release requirements. The agent rechecks the GitHub merge and CI state when the work starts, and does not infer it from Jira.
- Characterisation tests never preserve a known bug. Where two implementations disagree, such as the two completed-sale teardown orders, SCRUM-704 first settles whether the difference is a defect. If it is, SCRUM-704 writes a failing-first regression test before the two are unified.
- [`AGENTS.md`](../../AGENTS.md) owns the repository's CI, review and deploy gates, and they bind. Every money or permission PR still needs its own ADR.

## Considered options

- **Money calculations shared with web and mobile.** The decision rejects them in favour of server authority, so there is one posting authority and the consignment rule cannot drift into a client.
- **Removing byte pins once a file holds only doors.** The decision adopts this as the end state, but only after behaviour guards with negative controls cover the same paths, each replacement has a mapping from path to invariant to test, and the replacement checks are required.
- **An 800-line budget.** The decision rejects this in favour of 600 lines on new files, with a per-file cap that only goes down for existing ones, counted the same way the formatter lays the code out.
- **A mandated commands, policy and reads sub-folder in every domain.** On 2026-11-08 one interface per domain replaced this, because a fixed layout invites shallow pass-through modules.
- **Class hierarchies, repository interfaces, dependency-injection containers, one giant lifecycle enum, and splitting one transaction into several mutations.** The decision rejects these because they add indirection without a second adapter to justify the seam, or they break the transaction boundary.

## Consequences

What gets easier:

- Each business rule has one owning module, so a change to a rule touches one place and a review reads one place.
- New public functions get their tenant check from the builders, so a reviewer no longer hunts for a missing check.
- A new mutation no longer collides with a count pin, because enumerated sets replace the counts.
- Schema edits stop colliding in the single schema file once the split lands.

What gets harder:

- After step 3, every new public function must use `orgQuery` or `orgMutation`, and an exception needs an entry with a reason and both review seats.
- A domain exposes one `index.ts`, so code in another domain cannot reach its internals and must ask for a change to the interface.
- Moves stay separate from behaviour changes, so one refactor takes more than one PR.

What it costs:

- Steps 2 to 7 run one at a time, and each needs its own Jira spec before it starts.
- Characterisation tests and negative controls come first, before any large move.
- Stored fields in major units stay in major units until their own ticket converts them.
