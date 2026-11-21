# Correct a buyer or vehicle after finance terms were recorded

An open, configured-finance deal for a dealer-owned vehicle may adopt an accepted replacement quote before handover. If a quotation was sent or a purchase amount was approved, an independent finance approver records the financing company's withdrawal confirmation before applying the correction. The approver has the existing finance visibility and approval permissions and is independent of the deal's salesperson. [SCRUM-966](https://autoflowdealer.atlassian.net/browse/SCRUM-966)

The existing correction transaction keeps the commercial deal number and stores the original quotation, approval, appraisal state and confirmation reference in the correction history. It replaces the vehicle commitment and clears the superseded buyer, vehicle and financing evidence from the active agreement. Once it withdraws recorded terms, handover and closing readiness require a quotation and purchase approval recorded after the correction. A further correction keeps that requirement. The reference records an external confirmation supplied by the approver. [Convex transaction atomicity](https://docs.convex.dev/database/advanced/occ)

Recorded money, invoices, issued or planned custody, an active unwind, an earlier handover and ineligible quotes still prevent this path. The correction creates no payment or journal entry.
