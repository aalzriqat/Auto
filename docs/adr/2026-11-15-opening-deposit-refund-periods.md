# Record opening-deposit payouts across period boundaries

## Context

SCRUM-956 allows an approver to reserve an unused named opening deposit before paying a refund. The reservation excludes the deposit from sale application. An external transfer can settle in a later period while the hold is still active. The original period identifies when custody began.

## Decision

- Reserve, record, and cancel remain tenant-scoped accounting actions. The existing approval, actor separation, and external payment evidence requirements apply. Cancellation requires confirmed nonpayment.
- Derive the ledger period from the verified payout date and require that period to accept posting. A payout cannot precede reservation. On the reservation day, the ledger timestamp must also follow the reservation. Keep the exact recorded payout day with payment history.
- Keep the reservation and its audit history through payout. Post one liability settlement and one payment, then release the hold in the same mutation. A retry reuses the original result. A rejected call leaves the hold active.
- A held refund can settle in any open period that ends at or after the reservation time. Block close and lock of those periods until the reservation settles or is cancelled. Use an organization and reservation-time index so the check reads only the first matching reservation. Periods ending before the reservation remain outside this check.
- A returned bank transfer keeps the original payout and books the compensating entry through the separately verified return command. A closed-period snapshot remains immutable.

## Alternatives

A transfer of period custody before paying would require a second command and would leave an already paid refund without a recording path. The payout-date check uses the project's existing `assertPostingAllowed` boundary and the reservation close guard supplies the counterpart before and during settlement.

## Evidence

The failing-first scenario reserves on the last day of a year, opens the next period, and records the actual payout day. It checks the open-period journal, payment date, refund status, and idempotent retry. The close check protects the next period while the refund is outstanding. [Convex indexes](https://docs.convex.dev/database/reading-data/indexes/) · [Convex transaction semantics](https://docs.convex.dev/database/advanced/occ) · [SCRUM-956](https://autoflowdealer.atlassian.net/browse/SCRUM-956)

## Recover a returned refund for an archived customer

Recording a verified bank return restores the liability even if the customer was archived after the original payout. Staff can reissue the returned refund from the matched statement line. The archived record stays archived, and sale application still refuses it.

The matched statement line identifies the posted return event. The finance query checks ownership of the statement, event, deposit, and customer and matches the event to the current refund attempt. It exposes only the deposit identifier, amount, currency, and reservation state. Reserve, settle, and cancel still use the existing commands and verify current permission. An archived counterparty requires finance management and refund approval, an opening deposit, and a verified return. Any different or missing event leaves the recovery action unavailable.

If an archived refund custodian loses either required permission, the existing owner recovery command can transfer custody after independent confirmation of control over external payment. The new owner receives a new reservation key, and the hold continues to exclude sale application. Reopening the customer would restore unrelated CRM access, so the refund workflow keeps the archived status.
