# Correct the buyer or vehicle on a pending cash sale

A standalone pending cash draft can change its buyer or vehicle through the existing correction action. The sale ID, commercial deal ID and deal number survive. The save checks the draft revision, the linked accounting history and the replacement references in one transaction. It records the old and new identities with the reason. [SCRUM-966](https://autoflowdealer.atlassian.net/browse/SCRUM-966)

The selected buyer belongs to the dealership. A replacement vehicle has to be available at the draft's branch and retain the same ownership type. The selector permissions apply to both the picker and its update. The cash completion path still verifies the current draft revision, stock authority and accepted payment evidence. [Convex transactions](https://docs.convex.dev/database/advanced/occ)

An existing posting, lead, trade-in, down payment or held deposit assigned to the original buyer and vehicle requires review before either identity can change. This includes opening deposits reserved for refund, direct receipts and active shares of split deposits. Unallocated customer credit remains with its original customer. The correction creates no payment, hold, refund or delivery record. Cash sales currently derive delivery from completion. A separate cash handover is outside this pending-draft correction.
