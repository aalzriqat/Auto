import type { TestConvex } from "convex-test";
import type { api as ApiRef } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type schema from "../convex/schema";

type AsIdentity = ReturnType<TestConvex<typeof schema>["withIdentity"]>;

/** Supplies the receipt evidence for a positive handover fixture. Tests of
 * authorization or missing evidence call registerHandover without this setup. */
export async function recordFirstPaymentForHandover({ verifier, api, orgId, applicationId }: {
  verifier: AsIdentity;
  api: typeof ApiRef;
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
}): Promise<void> {
  const target = { orgId, applicationId };
  const { proof } = await verifier.query(api.customerFinanceCompanyPayments.firstPayment, target);
  if (proof.status === "UNAVAILABLE") throw new Error("The fixture first-payment evidence could not be verified.");
  if (proof.status !== "BLOCKED") return;
  await verifier.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...target,
    amountMinor: proof.requiredMinor - proof.heldMinor - proof.directMinor,
    paidAt: Date.now(),
    kind: "CONFIRMATION",
    reference: `Fixture confirmation ${applicationId}`,
    idempotencyKey: `fixture-first-payment-${applicationId}`,
  });
}
