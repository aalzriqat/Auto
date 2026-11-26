# Keep the deal after a full showroom cash refund before handover

An eligible open financed deal can change the buyer or vehicle on the existing deal number before handover after the dealership receives and returns the entire showroom cash deposit. The replacement quote must name an eligible dealership vehicle at the same branch. The showroom-only path applies when credit and the dealer purchase amount are approved, the posted refund uses the deal currency, and the refund is within the recorded first payment. Direct lender and split payment paths retain their existing proof requirements. [SCRUM-966](https://autoflowdealer.atlassian.net/browse/SCRUM-966)

An approver other than the application salesperson needs the existing identity correction permissions and payment verification authority. The system owner can verify the payment. Impersonating users are refused. The server verifies tenant ownership, the observed deal revision and payment proof, the replacement quote, and the original posted cash receipt and refund. It refuses reversed, ambiguous, stale or already applied evidence.

The correction preserves the original deposit, payment, event and journal records and creates or reverses no accounting postings. It archives the prior approval and agreement, retires the original commitment, and applies the replacement quote in the same mutation. Exact command retries reuse the original result. A changed request needs fresh proof. [Convex mutation transactions](https://docs.convex.dev/functions/mutation-functions#transactions)

The replacement agreement follows normal approval and evidence review. Handover requires fresh first-payment evidence tied to the replacement.
