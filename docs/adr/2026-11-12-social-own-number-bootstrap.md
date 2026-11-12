# Self-driving own-number maintenance with isolated failures

Status: local implementation candidate for SCRUM-949 / PR 812, round 5. No deployment or independent certification is claimed.

## Contract and scope

Own dealership and staff numbers cannot qualify a customer mobile. The own-number reader is independent of retained history; the rest of the intake door is not certified here. Existing customer lookup and manager notification/assignment scans remain outside this PR, under the coordinator's scope decision in SCRUM-949 c25033.

Existing organizations refuse mobile extraction until all source and membership phases finish. They still retain the incoming event and customer without a mobile. No second permanent reader is introduced. New organizations start ready, unless a legacy or damaged staff/contact relationship makes their sources unknown.

## Supported alternatives and decision

Installed packages are Convex 1.42.1, convex-helpers 0.1.120 and convex-test 0.0.53. No migrations component is installed. Adding one solely for this walk is unnecessary.

A trigger-only scheduler chain cannot start for an idle existing organization on deployment. A cron that performs only one page per minute starts correctly and resumes after failure but lengthens the mobile-capture gap. Use the native minute interval cron as both deployment starter and recovery pulse, plus a one-second paced scheduler chain for work. The persisted next-run time prevents overlapping pulses from multiplying chains. Completed ticks perform two point queries, read one progress document and write none.

The source phases use row and byte budgets. Membership selection and 32-phone copying occur in separate invocations. Progress commits with each page. Failed pages roll back in a child transaction and retry with exponential delay, capped at five minutes. A source fault is isolated, fenced and queued for repair; a poisoned contribution leaves that scope blocked while other scopes continue.

Failing the source write on an index error keeps the source/index atomic but lets derived corruption refuse authentication sync, offboarding and website publishing. Catching errors around ordinary helper calls commits partial deltas. Instead, the index delta runs in a native nested mutation. An exception rolls back the child. The parent records a scope fence and retry, then commits the source. Intake checks the repair fence as well as readiness and ambiguity, including when readiness rows were duplicated out of band.

Repair clears and re-counts fenced contributions in bounded pages, then replays the latest source. Priority orders user recounts, organization recounts, user retries, then organization retries. This lets fanout adjust rebuilt organization counters. A blocked user dependency blocks the affected organization rather than certifying it. Contact changes during a recount reset its progress and keep extraction fenced. Phone-independent patches bypass contact hydration only for tables without another trigger; memberships and organizations retain the counting and bank-generation triggers.

## Operational state and tenancy

Repair jobs are separate from contact contributions because cursor, ordering and blocked states must not be interpreted as phone evidence. Existing v1 bootstrap progress remains in socialOwnNumberSources to avoid another progress migration. A future split of that progress is simpler conceptually but has no demonstrated correctness benefit in this round.

Global source pagination never supplies a target tenant. Each row derives its organization or seller user from stored authority, and membership copying derives the organization from that membership. Published pointers validate both organization and website-settings identity. The cross-tenant poison/bootstrap test proves one tenant's contact is not attributed to the other.

## Limits and evidence

These are local convex-test logical I/O and scheduling results, not cloud, OCC, provider delivery or production read/write evidence. Native transaction limits remain limits on extreme source documents or relationship fanout. Imports and dashboard edits bypassing application maintenance remain uncertified; detected inconsistencies are fenced, but arbitrary undetected out-of-band deletions are not a supported maintenance path. A persistently malformed scope stays visibly blocked until corrected, rather than retrying hot or admitting an own number.

Convex documents [cron startup on deployment](https://docs.convex.dev/scheduling/cron-jobs), [durable scheduling and status](https://docs.convex.dev/scheduling/scheduled-functions), [nested mutation rollback](https://docs.convex.dev/api/interfaces/server.GenericMutationCtx#runmutation), [transaction limits](https://docs.convex.dev/production/state/limits), and [the mock backend's scope](https://docs.convex.dev/testing/convex-test). Those sources support the design; the named tests and measured counters establish local implementation evidence.
