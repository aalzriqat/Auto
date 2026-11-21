import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

const MAX_GUARANTOR_RECORDS = 100;

export async function readFinanceUnderwritingSnapshot(
  ctx: QueryCtx,
  customer: Doc<"customers">,
  quote: Doc<"quotes">,
  companyId: Id<"financeCompanies">,
) {
  const { orgId } = customer;
  const pricing = quote.customerQuotePricingSnapshot;
  if (!pricing) throw new ConvexError("The replacement quote needs finalized financing terms.");
  const [guarantors, valuation] = await Promise.all([
    ctx.db.query("guarantors")
      .withIndex("by_customer", (q) => q.eq("customerId", customer._id))
      .take(MAX_GUARANTOR_RECORDS + 1),
    ctx.db.query("vehicleValuations")
      .withIndex("by_org_vehicle_company", (q) =>
        q.eq("orgId", orgId).eq("vehicleId", quote.vehicleId).eq("companyId", companyId))
      .first(),
  ]);
  if (guarantors.length > MAX_GUARANTOR_RECORDS) {
    throw new ConvexError("There are too many guarantor records to refresh the financing evidence.");
  }
  const { monthlyInstallment, totalFinancedAmount } = pricing;
  const salary = customer.employment?.salary;
  const existingMonthlyDebt = customer.financials?.totalMonthlyDebt;
  const vehicleValuation = valuation?.valuationAmount;

  return {
    salaryAtSubmission: salary,
    employerAtSubmission: customer.employment?.employer,
    jobTitleAtSubmission: customer.employment?.title,
    totalMonthlyDebtAtSubmission: existingMonthlyDebt,
    proposedMonthlyInstallment: monthlyInstallment,
    dbrAtSubmission: salary && salary > 0 ? ((existingMonthlyDebt ?? 0) + monthlyInstallment) / salary : undefined,
    guarantorsAtSubmission: guarantors.filter((row) =>
      row.orgId === orgId && row.isDeleted !== true,
    ).map((row) => ({
      guarantorId: row._id,
      firstName: row.firstName,
      lastName: row.lastName,
      nationalIdLastFour: row.nationalId.slice(-4),
      phone: row.phone,
      income: row.income,
      relationship: row.relationship,
    })),
    vehicleValuationAtSubmission: vehicleValuation,
    ltvAtSubmission: vehicleValuation ? (totalFinancedAmount / vehicleValuation) * 100 : undefined,
  } satisfies NonNullable<Doc<"financeApplications">["underwritingSnapshot"]>;
}
