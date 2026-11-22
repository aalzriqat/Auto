# Keep finance-application contracts and transactions at their existing entry points

[SCRUM-963](https://autoflowdealer.atlassian.net/browse/SCRUM-963) applies the [Deal domain decision](2026-11-08-domain-modules-and-golden-rules.md) to finance applications.

A request to an existing `applications` function keeps the same validators, authorization, refusal order and result. Every command uses its original wrapped mutation context. Finalization, cancellation, disbursement and reversals keep their writes, idempotency decisions and posting obligations in that transaction. The cockpit uses its original query snapshot for related rows, workflow flags and authorized amounts. [Convex query consistency](https://docs.convex.dev/functions/query-functions) · [Convex transactions](https://docs.convex.dev/functions/mutation-functions#transactions)

## Role policy

The existing tenant checks and row-ownership decisions run in their original order. Sales access permits the qualitative cockpit. Finance and vehicle-cost permissions determine the money facts a caller can receive. The handover stamp retains its own action permission. Commands use the existing approval, handover, payment, settlement and cancellation authorities, including the additional decisions made for a specific deal state. The server continues to produce the value, omission or refusal presented by the client.

## Module structure

The facade is allowed to exceed 600 physical lines because it owns 21 registered paths and their inline validators, tenant and role checks, and six command idempotency wrappers. It stays below 800. The shared read and command implementations live behind the Deal domain interface. The existing `sales.get` projection is the precedent for passing the authorized row and query context directly to a helper. The canonical payment writer is the precedent for moving a subledger helper below its registered module while retaining existing exports. [Convex shared helpers](https://docs.convex.dev/understanding/best-practices/#use-helper-functions-to-write-shared-code)

The original source pin follows the moved implementation until required behavior guards cover the protected paths. The economic census traces named exports through the Deal interface and finds the existing cheque, receipt and reversal calls. Receivable reset checks still recognize the same source kinds and writer sites at their new locations. The route comparison checks the original predicate in the settlement-routing module.

## Verification

Exercise the registered entry points for owned and sourced deals, missing and foreign records, legacy values, finance redaction, same-key replay, bank and cash receipt, cheque return and cancellation. Compare the direct and composed Cockpit result and measured read counters on identical synthetic data. A serial Convex-test witness measures its own database calls. Native transaction limits and concurrency require an isolated Convex runtime. Regenerate the shared API declaration from the integrated source before certification. [Convex transaction metrics](https://docs.convex.dev/database/writing-data#checking-transaction-headroom)
