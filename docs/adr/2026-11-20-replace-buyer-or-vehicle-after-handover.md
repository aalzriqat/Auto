# Correct the buyer or vehicle on the same open deal

The commercial deal number and application ID survive an approved substitution. The original handover keeps its buyer, vehicle, timestamp, actor and notes. The replacement must earn its own approvals and physical handover before the deal can close. [SCRUM-966 owner ruling](https://autoflowdealer.atlassian.net/browse/SCRUM-966?focusedCommentId=25472)

The first supported path uses an accepted quote that changes one dimension at a time for a single dealer-owned vehicle on an open, configured-finance deal. It retains the lender, agreed price and currency. It requires a zero first payment and refuses existing invoices, payments, forwards, fees, custody, unwind or competing correction evidence. Those records belong to their original parties and must reconcile through their existing workflows.

The requester records the proposed quote and the observed agreement revision. An independent finance approver verifies the actual return of the original vehicle, with its date and a reference, before applying the request. The pending request suspends closing proof. Withdrawal leaves the current agreement and commitment in place.

Approval rechecks current authority, tenancy, quote eligibility and financial dependencies. In one transaction it preserves historical evidence, retires the exact original vehicle commitment, uses canonical acquisition for the replacement, and adopts its quote under the same commercial deal. An existing commitment to another deal prevents substitution. A returned vehicle that leaves the deal goes to inspection. [Convex atomicity](https://docs.convex.dev/database/advanced/occ)

Prior approved purchase, underwriting and handover evidence and the old documents remain attributable to the original agreement. Current document and handover authorizations restart through the usual finance route. Historical documents cannot fulfill a current requirement or be edited through an old document ID. New handover uses the normal server timestamp and approved economics stamp.

The correction itself posts no money. Finalization and cancellation work against the current commitment while preserving the return and the original handover for audit. Transaction retries reuse their command identities, and financial reset and organization deletion account for the new references.
