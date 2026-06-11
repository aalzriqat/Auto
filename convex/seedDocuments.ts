import { internalMutation } from "./_generated/server";

export const seedMutakhasisa = internalMutation({
  args: {},
  handler: async (ctx) => {
    const org = await ctx.db.query("organizations").first();
    if (!org) return;
    const orgId = org._id;

    // Check if Mutakhasisa exists
    const companies = await ctx.db.query("financeCompanies").filter(q => q.eq(q.field("orgId"), orgId)).collect();
    let mutakhasisa = companies.find(c => c.name.includes("المتخصصة"));

    if (!mutakhasisa) {
      const newId = await ctx.db.insert("financeCompanies", {
        orgId,
        name: "المتخصصة (Al-Mutakhasisa)",
        profitRate: 5,
        maxTermMonths: 84,
        gracePeriodMonths: 0,
        insuranceRate: 0,
        adminFees: 0,
        commission: 0,
        includesCommissionInDebt: true,
        maxFinancingLTV: 80,
        isActive: true,
      });
      const inserted = await ctx.db.get(newId);
      if (inserted) mutakhasisa = inserted;
    }

    if (mutakhasisa) {
      // Add rules
      const docs = [
        { name: "هوية/كفيل انثى", req: true },
        { name: "فاتورة كهرباء", req: true },
        { name: "دفتر عائلة", req: true },
        { name: "عقد ايجار", req: true, desc: "المستعمل عمر 7 سنوات او اقل" }
      ];

      for (const doc of docs) {
        await ctx.db.insert("companyDocumentRules", {
          orgId,
          companyId: mutakhasisa._id,
          documentName: doc.name,
          isRequired: doc.req,
          description: doc.desc
        });
      }
      console.log("Added Mutakhasisa and its 4 rules");
    }
  }
});
