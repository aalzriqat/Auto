import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = ["view:customers", "manage:customers"];

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Primary Dealership", createdAt: Date.now() })
  );
  const otherOrgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Rival Dealership", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "clerk_cust_user", email: "cust_op@test.com", name: "Customer Operator" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES_ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "clerk_cust_user" });
  return { t, orgId, otherOrgId, userId, asUser };
}

describe("customers.search and customers.selectorOptions — full inventory reachability", () => {
  test("1-10: Invariant proof across >1000 records, all identifiers, soft deletion, tenant isolation, and bounded limits", async () => {
    const { t, orgId, otherOrgId, asUser } = await setup();

    // 1. Insert target customer first (the oldest customer, far outside the 200 recent window)
    const targetCustomerId = await t.run(async (ctx) => {
      return await ctx.db.insert("customers", {
        orgId,
        firstName: "Tareq",
        lastName: "AlZobaidi",
        phone: "+962791112233",
        email: "tareq.early@dealersoft.jo",
        nationalId: "9951010101",
        createdAt: 1000,
      });
    });

    // Also insert a soft-deleted customer that matches the search term
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        orgId,
        firstName: "TareqDeleted",
        lastName: "AlZobaidi",
        phone: "+962791112233",
        email: "deleted.tareq@dealersoft.jo",
        nationalId: "9951010101",
        isDeleted: true,
        deletedAt: Date.now(),
        createdAt: 1001,
      });
    });

    // Also insert a customer belonging to another tenant with the same phone/email/nationalId
    await t.run(async (ctx) => {
      await ctx.db.insert("customers", {
        orgId: otherOrgId,
        firstName: "TareqOtherOrg",
        lastName: "AlZobaidi",
        phone: "+962791112233",
        email: "tareq.early@dealersoft.jo",
        nationalId: "9951010101",
        createdAt: 1002,
      });
    });

    // 2. Insert >1000 newer customers to bury the target record deep past any recent window
    await t.run(async (ctx) => {
      for (let i = 0; i < 1050; i++) {
        await ctx.db.insert("customers", {
          orgId,
          firstName: `GenericFirst${i}`,
          lastName: `GenericLast${i}`,
          phone: `+96278000${String(i).padStart(4, "0")}`,
          email: `generic${i}@autoflowcorp.com`,
          nationalId: `900000${String(i).padStart(4, "0")}`,
          createdAt: 2000 + i,
        });
      }
    });

    // 3. Find target by first name ("Tareq")
    const byFirstName = await asUser.query(api.customers.selectorOptions, {
      orgId,
      search: "Tareq",
    });
    expect(byFirstName.some((c) => c._id === targetCustomerId)).toBe(true);

    // 4. Find target by last name ("AlZobaidi")
    const byLastName = await asUser.query(api.customers.selectorOptions, {
      orgId,
      search: "AlZobaidi",
    });
    expect(byLastName.some((c) => c._id === targetCustomerId)).toBe(true);

    // 5. Find target by exact phone and normalized phone
    const byExactPhone = await asUser.query(api.customers.selectorOptions, {
      orgId,
      search: "+962791112233",
    });
    expect(byExactPhone.some((c) => c._id === targetCustomerId)).toBe(true);

    const byLocalPhone = await asUser.query(api.customers.selectorOptions, {
      orgId,
      search: "0791112233",
    });
    expect(byLocalPhone.some((c) => c._id === targetCustomerId)).toBe(true);

    const bySpacedPhone = await asUser.query(api.customers.selectorOptions, {
      orgId,
      search: "+962 79 111 2233",
    });
    expect(bySpacedPhone.some((c) => c._id === targetCustomerId)).toBe(true);

    // 6. Find target by email ("tareq.early@dealersoft.jo")
    const byEmail = await asUser.query(api.customers.selectorOptions, {
      orgId,
      search: "tareq.early@dealersoft.jo",
    });
    expect(byEmail.some((c) => c._id === targetCustomerId)).toBe(true);

    // Also with upper/mixed case
    const byMixedEmail = await asUser.query(api.customers.selectorOptions, {
      orgId,
      search: "TAREQ.EARLY@DEALERSOFT.JO",
    });
    expect(byMixedEmail.some((c) => c._id === targetCustomerId)).toBe(true);

    // 7. Find target by national ID ("9951010101")
    const byNationalId = await asUser.query(api.customers.selectorOptions, {
      orgId,
      search: "9951010101",
    });
    expect(byNationalId.some((c) => c._id === targetCustomerId)).toBe(true);

    // Also verify via full customers.search query
    const fullSearchNationalId = await asUser.query(api.customers.search, {
      orgId,
      search: "9951010101",
    });
    expect(fullSearchNationalId.some((c) => c._id === targetCustomerId)).toBe(true);
    expect(fullSearchNationalId[0].nationalId).toBe("9951010101");

    // 8. Exclude soft-deleted customer
    expect(byFirstName.some((c) => c.firstName === "TareqDeleted")).toBe(false);
    expect(byExactPhone.some((c) => c.firstName === "TareqDeleted")).toBe(false);
    expect(byNationalId.some((c) => c.firstName === "TareqDeleted")).toBe(false);

    // 9. Reject / omit another tenant's customer
    expect(byFirstName.some((c) => c.firstName === "TareqOtherOrg")).toBe(false);
    expect(byExactPhone.some((c) => c.firstName === "TareqOtherOrg")).toBe(false);
    expect(byNationalId.some((c) => c.firstName === "TareqOtherOrg")).toBe(false);

    // 10. Preserve bounded query behavior (CUSTOMER_SELECTOR_LIMIT is 50)
    const broadSearch = await asUser.query(api.customers.selectorOptions, {
      orgId,
      search: "Generic",
    });
    expect(broadSearch.length).toBeLessThanOrEqual(50);
    expect(broadSearch.length).toBe(50);
  }, 30_000);
});
