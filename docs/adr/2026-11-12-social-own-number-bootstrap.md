# Self-driving own-number maintenance with isolated failures

Status: local implementation candidate for SCRUM-949 / PR 812, round 7. Schema, derived-index bootstrap and repair are included. No deployment or independent certification is claimed.

## Round 7 recovery decision (before implementation)

Invariant: a known-bad scope remains fenced until its complete recount and latest-source replay succeed. Once a fault disappears, capture recovers automatically within a bounded retry budget. A poisoned scope cannot monopolize another scope's progress. Historical customer, event and lead rows are outside repair.

Candidate A: put a persisted due time and attempt count on scope jobs and select the earliest eligible job through an index. Active pages have due time zero, preserving user-before-organization ordering. Failed pages retain their phase/cursor, increment attempts, and become eligible after exponential backoff (2, 4, 8, 16 seconds). The fifth failure exhausts the budget, removes eligibility and leaves the fence. Schedule a driver wake for each retry; the existing cron recovers missed wakes. Completed idle ticks still execute exactly two indexed queries, read one progress document and write nothing.

Candidate B: keep the priority queue unchanged and schedule a separate per-scope wake mutation with a generation token. A wake restores a parked job's phase/priority and starts the driver. This also preserves idle cost, but adds another state transition, stale-wake token and function contract. Choose A: one selector owns eligibility; no second queue-restoration protocol. Due time is optional only for source-replay rows and exhausted fences; all scope jobs created by this unreleased PR receive it. This table has not been deployed by this lane.

An internal reader returns counts by phase and oldest fence age only, with a 1,000-scope limit and an explicit generic refusal beyond it. It returns no document identifiers or source data. Waiting and exhausted jobs remain included. Repair diagnostics log fixed messages and counts, not error payloads containing tenant/source identifiers. Ordinary source changes restart recount and retry budget; no manual queue reset is needed within the automatic budget. Exhausted jobs remain fenced and observable; correcting a source through its normal writer restarts a bounded attempt cycle.

Design sources: native [nested mutation rollback](https://docs.convex.dev/api/interfaces/server.GenericMutationCtx#runmutation), [durable scheduling](https://docs.convex.dev/scheduling/scheduled-functions), and Amazon's [bounded retries and backoff](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/). The existing single paced driver bounds dispatch load, so deterministic exponential delays are retained instead of random jitter. Local harness measurements will verify the I/O claim; documentation does not prove it.

## Contract and scope

Own dealership and staff numbers cannot qualify a customer mobile. The own-number reader is independent of retained history; the rest of the intake door is not certified here. Existing customer lookup and manager notification/assignment scans remain outside this PR, under the coordinator's scope decision in SCRUM-949 c25033.

Existing organizations refuse mobile extraction until all source and membership phases finish. They still retain the incoming event and customer without a mobile. No second permanent reader is introduced. New organizations start ready, unless a legacy or damaged staff/contact relationship makes their sources unknown.

## Supported alternatives and decision

Installed packages are Convex 1.42.1, convex-helpers 0.1.120 and convex-test 0.0.53. No migrations component is installed. Adding one solely for this walk is unnecessary.

A trigger-only scheduler chain cannot start for an idle existing organization on deployment. A cron that performs only one page per minute starts correctly and resumes after failure but lengthens the mobile-capture gap. Use the native minute interval cron as both deployment starter and recovery pulse, plus a one-second paced scheduler chain for work. The persisted next-run time prevents overlapping pulses from multiplying chains. Completed ticks perform two point queries, read one progress document and write none.

The source phases use row and byte budgets. Membership selection and 32-phone copying occur in separate invocations. Progress commits with each page. Failed pages roll back in a child transaction and retry with exponential delay, capped at five minutes. A source fault is isolated, fenced and queued for repair; a poisoned contribution leaves that scope blocked while other scopes continue.

Failing the source write on an index error keeps the source/index atomic but lets derived corruption refuse authentication sync, offboarding and website publishing. Catching errors around ordinary helper calls commits partial deltas. Instead, the index delta runs in a native nested mutation. An exception rolls back the child. The parent records a scope fence and retry, then commits the source. Intake checks the repair fence as well as readiness and ambiguity, including when readiness rows were duplicated out of band.

Repair clears and re-counts fenced contributions in bounded pages, then replays the latest source. Priority orders user recounts, organization recounts, user retries, then organization retries. This lets fanout adjust rebuilt organization counters. A blocked user dependency blocks the affected organization rather than certifying it. Contact changes during a recount reset its progress and keep extraction fenced. Phone-independent patches bypass contact hydration only for tables without another trigger; memberships and organizations retain the counting and bank-generation triggers.

### Guard-provable dispatch, follow-up 5d

Every migration query names its literal table. Shared page visitation accepts the completed page, not a database or a run-time table. Source pages retain 32 rows, pointer pages retain one row, and both retain their row-read and 1 MiB byte bounds. Phase order and persisted cursors are unchanged.

The patch adapter extends the installed native `DatabaseWriterWithTriggers` compatibility class. Only the nine contact-only tables have a raw fast path, each with a literal table and an id returned by `normalizeId` for that table. A patch containing any contact key falls through to `super.patch`, as do every membership and organization patch and every other table. Both native patch overloads are preserved, including explicit table/id validation. No database method is detached or invoked indirectly.

The compatibility class is exported but deprecated in convex-helpers 0.1.120 in favor of `writerWithTriggers`. Its installed implementation simply delegates to that same function. This is a deliberate compatibility dependency: the function-returned generic patch interface cannot supply an inherited fallback, while a new generic forwarding call cannot satisfy the unchanged supplier source guard. Extending the native class preserves its existing trigger queue, locks and supplier behavior without implementing another database writer. A dependency upgrade that removes the class requires revisiting this adapter.

Returning early from a registered trigger was rejected because native hydration has already read old and new documents. Removing the fast path adds two reads to unrelated user and listing patches. A generic forwarding wrapper or reflection prevents the supplier guard from proving table/lock coverage. Dispatching every application table would duplicate the database schema and supplier-lock policy. The native fallback avoids those changes.

Sources checked: Convex [patch semantics](https://docs.convex.dev/database/writing-data), [cursor pagination](https://docs.convex.dev/database/pagination), and the maintained [trigger implementation](https://github.com/convex/convex-helpers/blob/main/packages/convex-helpers/server/triggers.ts), compared with the installed version. Tests measure harness I/O before and after, including all eleven contact tables; this is not cloud billing or OCC evidence.

## Operational state and tenancy

Repair jobs are separate from contact contributions because cursor, ordering and blocked states must not be interpreted as phone evidence. Existing v1 bootstrap progress remains in socialOwnNumberSources to avoid another progress migration. A future split of that progress is simpler conceptually but has no demonstrated correctness benefit in this round.

Global source pagination never supplies a target tenant. Each row derives its organization or seller user from stored authority, and membership copying derives the organization from that membership. Published pointers validate both organization and website-settings identity. The cross-tenant poison/bootstrap test proves one tenant's contact is not attributed to the other.

## Limits and evidence

These are local convex-test logical I/O and scheduling results, not cloud, OCC, provider delivery or production read/write evidence. Native transaction limits remain limits on extreme source documents or relationship fanout. Imports and dashboard edits bypassing application maintenance remain uncertified; detected inconsistencies are fenced, but arbitrary undetected out-of-band deletions are not a supported maintenance path. A persistently malformed scope stays visibly blocked until corrected, rather than retrying hot or admitting an own number.

Convex documents [cron startup on deployment](https://docs.convex.dev/scheduling/cron-jobs), [durable scheduling and status](https://docs.convex.dev/scheduling/scheduled-functions), [nested mutation rollback](https://docs.convex.dev/api/interfaces/server.GenericMutationCtx#runmutation), [transaction limits](https://docs.convex.dev/production/state/limits), and [the mock backend's scope](https://docs.convex.dev/testing/convex-test). Those sources support the design; the named tests and measured counters establish local implementation evidence.
