# Self-driving own-number maintenance with isolated failures

Status: local implementation candidate for SCRUM-949 / PR 812, round 7. Schema, derived-index bootstrap and repair are included. No deployment or independent certification is claimed.

## Round 7 recovery decision (before implementation)

Invariant: a known-bad scope remains fenced until its complete recount and latest-source replay succeed. Once a fault disappears, capture recovers automatically within a bounded retry budget. A poisoned scope cannot monopolize another scope's progress. Historical customer, event and lead rows are outside repair.

Candidate A: put a persisted due time and attempt count on scope jobs and select the earliest eligible job through an index. Active pages have due time zero, preserving user-before-organization ordering. Failed pages retain their phase/cursor, increment attempts, and become eligible after exponential backoff (2, 4, 8, 16 seconds). The fifth failure exhausts the budget, removes eligibility and leaves the fence. Schedule a driver wake for each retry; the existing cron recovers missed wakes. Completed idle ticks still execute exactly two indexed queries, read one progress document and write nothing.

Candidate B: keep the priority queue unchanged and schedule a separate per-scope wake mutation with a generation token. A wake restores a parked job's phase/priority and starts the driver. This also preserves idle cost, but adds another state transition, stale-wake token and function contract. Choose A: one selector owns eligibility; no second queue-restoration protocol. Due time is optional only for source-replay rows and exhausted fences; new active scope jobs receive it. A versioned, 32-row adoption walk restarts old-format scope jobs, including parked jobs without attempt/due metadata. This avoids relying on an assumption about whether a prior PR head ran anywhere. Adoption visits derived queue rows only, once per persisted queue version.

An internal reader returns counts by phase and oldest fence age only, with a 1,000-scope limit and an explicit generic refusal beyond it. It returns no document identifiers or source data. Waiting and exhausted jobs remain included. Repair diagnostics log fixed messages and counts, not error payloads containing tenant/source identifiers. Ordinary source changes restart recount and retry budget; no manual queue reset is needed within the automatic budget. Exhausted jobs remain fenced and observable. After correcting a persistent derived fault, an operator can invoke internal `restartBlockedRepairs` with no arguments: at most 32 fences restart from clear, preserving the legitimate source phone and returning only the restart count. This lane does not invoke it on a backend.

A two-page fault reproduction exposed an ordering requirement introduced by due-time retries. A user replay must wait while any affected organization's recount is in clear/recount, including while its due time is in the future. Otherwise replay can insert a new join behind that organization's saved cursor, count it once during fanout and again on the next page, and leave a stale exclusion after removal. The guard reads current and retained memberships before every user retry/finalization. Organization retry already waits for the user fence to clear. Thus organization recount completes, user replay runs, then organization retry certifies. Signed tests on both platforms prove the next number is released after that exact interleaving.

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

### Round 7 contact descriptors and behavioral coverage

One descriptor per table declares the scope key, phone cardinality, membership organization key, published pointer, settings authority and snapshot projection. The patch fast path, trigger comparison, invalidation scope extraction and synchronizer consume these declarations. Literal database dispatch remains outside the descriptors so the supplier guard can prove table access. The descriptor module contains no database access.

The rejected alternative was to retain three handwritten lists and add five tests. That leaves adding a new field dependent on synchronizing three places. Schema-derived coverage now checks phone-bearing fields against a fixed table census; non-contact metadata exceptions include a reason. The field tests use fixed literal titles and expectations, independently of the descriptor list. Removing a descriptor cannot shrink the test matrix.

| Table | Contact fields and authority keys | Maintenance behavior |
| --- | --- | --- |
| users | whatsappPhone; scope _id | User contribution fans out to every membership |
| memberships | userId, orgId | Join/leave contribution; native count triggers retained |
| branches | phone, additionalPhones, orgId | Organization contribution |
| marketplaceListings | sellerPhone, sellerWhatsapp, sellerUserId | User contribution, including retained listings |
| marketplaceIndividualSellerProfiles | phone, sellerUserId | User contribution independent of a listing |
| marketplaceDealerProfiles | whatsappNumber, orgId | Organization contribution |
| marketplaceWhatsAppFlows | phone, orgId | Organization contribution, including retained flows |
| websiteSettings | publishedSnapshotId, orgId | Current published pointer only |
| websiteDomains | publishedSnapshotId, websiteSettingsId, orgId | Independent current domain pointer |
| websitePublishSnapshots | snapshotJson, websiteSettingsId, orgId | Re-evaluate existing current references only |
| organizations | scope _id, insertion/deletion | Readiness and bounded cleanup; native bank triggers retained |

Published authority changes have a distinct contract: changing only organization or settings identity makes the pointer unknown. Capture stays closed until the reference is removed or made valid. Such a patch cannot truthfully be described as releasing the old phone immediately. Signed tests check refusal, then release after the pointer is cleared. Direct scope transfers check release in the old scope and exclusion in the new one.

The eleven bootstrap tests each make the tested phase necessary for capture: eight independent contact sources (including a domain-only pointer), user readiness, membership copying and organization readiness. Unreferenced snapshots are never bootstrap inputs. No historical customer/event/lead is repaired.

For shared users, retain the existing fanout implementation and reject truncation through a fixed matrix, rather than rewriting correct fanout to fit a test. The matrix covers user WhatsApp, listing phone, listing WhatsApp and seller profile, two memberships and an unrelated organization, updates, old-number release, removal, public membership leave and rejoin on both signed handlers. User profile, listing updates and membership lifecycle use their real public APIs. Required listing/profile phone fields have no public clearing API; physical removal is tested through a synthetic handler of the production public mutation builder. The listing's profile cache is isolated when testing the profile contribution so it cannot mask a missing sibling producer.

Convex's [shallow patch contract](https://docs.convex.dev/database/writing-data) makes top-level keys, including explicit undefined, the correct change boundary. The generic descriptor follows that boundary; nested published contacts still use the validated projection parser. This does not certify arbitrary dashboard edits, imports, platform concurrency or scheduling.

### Separate Sonar refactor and remaining sequential work

The behavior-preserving refactor splits repair phases and driver orchestration, uses literal per-table change handlers, and separates phone parsing decisions. Synchronous HTTP response construction stays separate from the native callback's required `Promise<Response>` contract. No dummy await, suppression or guard allowance is added. Independent fence writes and deletes run together; new phone additions are unique by construction and settle before an error is rethrown so the child transaction has no unfinished sibling delta at rollback.

Five reported S9382 sites retain sequential execution: source-ledger recounts within a page, source bootstrap visitation, membership phone copying, old-contact removals, and recounting a contribution's phone list. These operations can share a counter or idempotency key, including under corruption. A generic `Promise.all` can change the next read's input. The signed two-contribution repair test checks exclusion after repair and release after the last source is removed. Rewriting a synchronous array as an async iterable or using a promise chain merely to hide the await adds work without removing the dependency. The owner's round-7 stop condition applies to these sites: leave them unsuppressed and report the evidence for a decision. Zero open Sonar issues is not established.

The [ESLint rule documentation](https://eslint.org/docs/latest/rules/no-await-in-loop#when-not-to-use-it) explicitly distinguishes dependent iterations. [MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for-await...of) documents the extra promise unwrapping when async iteration is applied to synchronous arrays. These support keeping the dependency visible; they do not waive the owner's zero-issue gate.

Repair jobs are separate from contact contributions because cursor, ordering and blocked states must not be interpreted as phone evidence. Existing v1 bootstrap progress remains in socialOwnNumberSources to avoid another progress migration. A future split of that progress is simpler conceptually but has no demonstrated correctness benefit in this round.

Global source pagination never supplies a target tenant. Each row derives its organization or seller user from stored authority, and membership copying derives the organization from that membership. Published pointers validate both organization and website-settings identity. The cross-tenant poison/bootstrap test proves one tenant's contact is not attributed to the other.

## Limits and evidence

These are local convex-test logical I/O and scheduling results, not cloud, OCC, provider delivery or production read/write evidence. Native transaction limits remain limits on extreme source documents or relationship fanout. Imports and dashboard edits bypassing application maintenance remain uncertified; detected inconsistencies are fenced, but arbitrary undetected out-of-band deletions are not a supported maintenance path. A persistently malformed scope stays visibly blocked until corrected, rather than retrying hot or admitting an own number.

Convex documents [cron startup on deployment](https://docs.convex.dev/scheduling/cron-jobs), [durable scheduling and status](https://docs.convex.dev/scheduling/scheduled-functions), [nested mutation rollback](https://docs.convex.dev/api/interfaces/server.GenericMutationCtx#runmutation), [transaction limits](https://docs.convex.dev/production/state/limits), and [the mock backend's scope](https://docs.convex.dev/testing/convex-test). Those sources support the design; the named tests and measured counters establish local implementation evidence.

Round 7 scope-transfer closure: replay expands both the current row scope and the retained source scope, all current/retained user memberships, and published snapshot references. It waits for every affected clear/recount phase before applying a delta. Organization replay also waits for user repair completion. User replay can proceed beside another user's retry phase, once recounts are complete; waiting for every peer fence creates a cycle on a user-to-user transfer. Two signed cases per platform reproduce the paused recipient-cursor double count and the cyclic user transfer before this fix. Scope enumeration is shared with invalidation.

The final guardrail refactor separates resumable bootstrap helpers into utils/socialOwnNumberBootstrap.ts; registered entrypoints, child transaction boundaries, phases and cursor work remain in place. The original function/handler bodies are preserved by extraction, recorded in the lane receipt. Repair scheduling/diagnostics remain in socialOwnNumberMigration.ts. Exact fixture phone-list equality proves the 33-row cursor case, including multiplicity. The membership query is named staffPhoneCounts to distinguish it from phone arrays for both readers and the native static query classifier. The two new internal maintenance mutations legitimately increase the tenant-analyzer population by two; its coverage pin is unchanged and remains a blocking discrepancy in this lane.

Bootstrap fault fences also resolve scopes through contactRowScopes and the descriptor; they no longer maintain a second orgId/sellerUserId fallback list. This preserves scope extraction for every currently supported source table and makes the failure path follow the same declaration. The extracted rebuild handler and membership bodies remain unchanged.
