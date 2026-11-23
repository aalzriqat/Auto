# Keep the deal after a full lender refund before handover

An eligible open financed deal with a dealership-owned vehicle can change the buyer or vehicle on its existing deal number before handover. If the finance company received the full first payment directly, a finance approver verifies the lender's confirmation that it returned the entire payment to the original payer. The confirmation names the original receipt, refund reference, amount and date in the deal currency. [SCRUM-966](https://autoflowdealer.atlassian.net/browse/SCRUM-966) · [First-payment evidence ruling](https://autoflowdealer.atlassian.net/browse/SCRUM-635?focusedCommentId=25433)

The approver needs the existing identity-correction permissions plus authority to confirm lender payments. The application salesperson and impersonating users are refused. The mutation verifies tenant ownership, the current agreement, the observed receipt and replacement quote, the full amount, and the refund chronology. It retains the original proof, reserves both references, retires the refunded receipt, and applies the replacement quote and commitment in the same transaction. [Convex transaction atomicity](https://docs.convex.dev/database/advanced/occ)

The refund evidence describes a transfer handled by the lender. The dealership ledger has no posting for it. A routine revocation of a confirmation releases its reference under the existing first-payment rule. A receipt retired through the funded correction retains its original receipt and refund references as evidence of the completed return.

The replacement agreement follows the existing evidence review. Handover requires a fresh receipt or confirmation tied to the replacement agreement. Its evidence uses the actual time, including when a verifier corrects it after handover.

After a funded correction is recorded, rollback may withdraw the newly offered action while retaining the additive schema, archived receipt and refund references, correction history, and replacement-evidence guards. Redeploying the prior backend wholesale would remove those guards and is unsafe for a deal carrying funded correction history.
