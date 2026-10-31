/**
 * SCRUM-811 (tenant-reference ownership), read enrichments.
 *
 * Invariant: a query that joins a STORED reference into its result returns the
 * joined document's fields only when that document provably belongs to the
 * caller's org (a vehicle or finance company by its own `orgId`; a user by a
 * membership row in the org). Otherwise it returns the neutral fallback it
 * already uses for a missing document. A stale or planted cross-org link must
 * not turn a tenant-scoped list into a read of another tenant's document.
 *
 * The reader here belongs to org A ONLY. Every org A row below carries a link
 * into org B; org B fields are unique marker strings, so any appearance of a
 * marker anywhere in a result is a leak. A same-org link is the positive
 * control for every join, so a query that returned nothing would also fail.
 *
 * User attribution policy (explicit, per review): a user's name is shown when a
 * membership row of any status exists in this org (an offboarding member keeps
 * their attribution). Memberships are hard-deleted when a member is removed, so a
 * removed member can no longer be proven to belong to the org and reads as the
 * existing fallback ("Unknown" / "Unassigned" / no name), the same as a user row
 * that no longer exists. That is the cost of not trusting an unproven link.
 */
import { expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const B = {
  vin: "ORGB-SECRET-VIN-0001",
  make: "OrgBMake",
  model: "OrgBModel",
  notes: "ORGB-PRIVATE-NOTE",
  price: 777_777,
  user: "OrgB Person",
  email: "orgb-person@example.test",
  company: "OrgB Finance Co",
};
const MARKERS = [B.vin, B.make, B.model, B.notes, String(B.price), B.user, B.email, B.company];

async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const mk = (clerkId: string, name: string, email: string) =>
    t.run((ctx) => ctx.db.insert("users", { clerkId, name, email }));
  const readerId = await mk("read-owner-reader", "Org A Reader", "reader@example.test");
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "QA TEST read reference A", createdAt: Date.now() }));
  const orgBId = await t.run((ctx) => ctx.db.insert("organizations", { name: "QA TEST read reference B", createdAt: Date.now() }));
  const roleA = await t.run((ctx) => ctx.db.insert("roles", {
    orgId, name: "READER", permissions: ["view:customers", "view:sales", "view:expenses", "view:vehicles", "view:users"],
  }));
  const roleB = await t.run((ctx) => ctx.db.insert("roles", { orgId: orgBId, name: "READER", permissions: ["view:customers"] }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: readerId, roleId: roleA }));
  const reader = t.withIdentity({ subject: "read-owner-reader" });

  const vehicleIn = (org: Id<"organizations">, tag: string, extra: Record<string, unknown> = {}) =>
    t.run((ctx) => ctx.db.insert("vehicles", {
      orgId: org, vin: tag === "B" ? B.vin : `ORGA-VIN-${tag}`, make: tag === "B" ? B.make : "OrgAMake",
      model: tag === "B" ? B.model : "OrgAModel", year: 2024, mileage: 10, color: "White", fuelType: "Gasoline",
      transmission: "Automatic", sourceType: "STOCK", purchasePrice: tag === "B" ? B.price : 10_000, sellingPrice: 12_500,
      status: "AVAILABLE", ...(tag === "B" ? { notes: B.notes } : {}), ...extra,
    } as never));
  const userIn = async (org: Id<"organizations"> | null, name: string, email: string, role: Id<"roles">, offboarding = false) => {
    const id = await mk(`ref-${name}-${email}`, name, email);
    if (org) await t.run((ctx) => ctx.db.insert("memberships", {
      orgId: org, userId: id, roleId: role, ...(offboarding ? { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" as const } : {}),
    }));
    return id;
  };

  const bVehicle = await vehicleIn(orgBId, "B");
  const bUser = await userIn(orgBId, B.user, B.email, roleB);
  const bCompany = await t.run((ctx) => ctx.db.insert("financeCompanies", {
    orgId: orgBId, name: B.company, profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, isActive: true, adminFees: 0,
  }));
  const aVehicle = await vehicleIn(orgId, "A1");
  const aUser = await userIn(orgId, "OrgA Member", "orga-member@example.test", roleA);
  const aCompany = await t.run((ctx) => ctx.db.insert("financeCompanies", {
    orgId, name: "OrgA Finance Co", profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, isActive: true, adminFees: 0,
  }));
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "QA", lastName: "Customer", createdBy: bUser }));
  const aCustomerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "QA", lastName: "Own creator", createdBy: aUser }));

  /** Every join the screens read, once pointing into org B and once into org A. */
  const link = async (who: "A" | "B") => {
    const v = who === "B" ? bVehicle : aVehicle;
    const u = who === "B" ? bUser : aUser;
    const c = who === "B" ? bCompany : aCompany;
    await t.run(async (ctx) => {
      await ctx.db.insert("sales", { orgId, vehicleId: v, customerId, salespersonId: u, salePrice: 1000, saleDate: Date.now(), status: "COMPLETED" });
      await ctx.db.insert("leads", { orgId, customerId, source: "walk-in", stage: "NEW", vehicleId: v, assignedUserId: u });
      await ctx.db.insert("tasks", { orgId, customerId, assignedTo: u, title: "Call", dueDate: Date.now(), status: "PENDING" });
      await ctx.db.insert("quotes", {
        orgId, customerId, vehicleId: v, companyId: c, vehiclePrice: 1000, downPayment: 100, termMonths: 12,
        status: "DRAFT", createdBy: u, createdAt: Date.now(),
      } as never);
      await ctx.db.insert("expenses", {
        orgId, title: "Linked expense", amount: 10, date: Date.now(), category: "OFFICE", status: "PAID", vehicleId: v, payerId: u,
      });
    });
  };
  return { t, reader, orgId, customerId, aCustomerId, link, aUser, mk, roleA };
}

const relations = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.reader.query(api.customers.getRelations, { orgId: f.orgId, customerId: f.customerId });
const expenseList = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.reader.query(api.expenses.list, { orgId: f.orgId, paginationOpts: { numItems: 50, cursor: null } });
const customerList = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.reader.query(api.customers.list, { orgId: f.orgId, paginationOpts: { numItems: 50, cursor: null } });
const leaks = (value: unknown) => MARKERS.filter((marker) => JSON.stringify(value).includes(marker));

// Bound by SCRUM-761 scenario `relation-reads-do-not-return-foreign-documents`. Top-level, controls inside:
// the local runner anchors `^title$` against the full (describe + title) name.
test("an org A reader never receives an org B document through a stored cross-org link", async () => {
  const failures: string[] = [];
  const f = await fixture();
  await f.link("B");
  const foreign = { relations: await relations(f), expenses: await expenseList(f), customers: await customerList(f) };
  for (const [door, result] of Object.entries(foreign)) {
    const found = leaks(result);
    if (found.length) failures.push(`${door}: leaked ${found.join(", ")}`);
  }
  // The rows themselves are still returned (the reader sees their own org's records), with the neutral fallbacks.
  const rel = foreign.relations;
  if (rel.sales.length !== 1 || rel.sales[0].vehicleDesc !== "Unknown" || rel.sales[0].salespersonName !== "Unknown")
    failures.push(`sales fallback wrong: ${JSON.stringify(rel.sales.map((s) => [s.vehicleDesc, s.salespersonName]))}`);
  if (rel.leads[0]?.vehicleDesc !== "Any" || rel.leads[0]?.assignedUserName !== "Unassigned") failures.push("leads fallback wrong");
  if (rel.tasks[0]?.assignedUserName !== "Unknown") failures.push("tasks fallback wrong");
  const quote = rel.quotes[0];
  if (quote?.vehicle !== null || quote?.vehicleDesc !== "Unknown" || quote?.companyName !== "Unknown" || quote?.createdByUserName !== "Unknown")
    failures.push(`quotes fallback wrong: ${JSON.stringify([quote?.vehicle, quote?.vehicleDesc, quote?.companyName, quote?.createdByUserName])}`);
  const expense = foreign.expenses.page.find((row) => row.title === "Linked expense");
  if (!expense || expense.vehicleSummary !== null || expense.payerName !== null) failures.push("expense fallback wrong");
  if (foreign.customers.page.find((row) => row.lastName === "Customer")?.createdByName !== null) failures.push("customer creator fallback wrong");

  // Positive control: the same joins pointing into the reader's own org are returned in full.
  const g = await fixture();
  await g.link("A");
  const own = { relations: await relations(g), expenses: await expenseList(g), customers: await customerList(g) };
  if (own.relations.sales[0]?.vehicleDesc !== "2024 OrgAMake OrgAModel") failures.push("control: own sale vehicle missing");
  if (own.relations.sales[0]?.salespersonName !== "OrgA Member") failures.push("control: own salesperson missing");
  if (own.relations.leads[0]?.vehicleDesc !== "2024 OrgAMake OrgAModel" || own.relations.leads[0]?.assignedUserName !== "OrgA Member")
    failures.push("control: own lead joins missing");
  if (own.relations.tasks[0]?.assignedUserName !== "OrgA Member") failures.push("control: own task assignee missing");
  const ownQuote = own.relations.quotes[0];
  if (ownQuote?.vehicle?.vin !== "ORGA-VIN-A1" || ownQuote?.companyName !== "OrgA Finance Co" || ownQuote?.createdByUserName !== "OrgA Member")
    failures.push("control: own quote joins missing");
  const ownExpense = own.expenses.page.find((row) => row.title === "Linked expense");
  if (!ownExpense?.vehicleSummary?.includes("ORGA-VIN-A1") || ownExpense.payerName !== "OrgA Member") failures.push("control: own expense joins missing");
  if (own.customers.page.find((row) => row.lastName === "Own creator")?.createdByName !== "OrgA Member") failures.push("control: own customer creator missing");

  expect(failures).toEqual([]);
}, 120_000);

test("user attribution policy: an offboarding member keeps their name; a user with no membership in the org does not", async () => {
  const f = await fixture();
  const offboarding = await f.t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { clerkId: "off-1", name: "Leaving Member", email: "leaving@example.test" });
    await ctx.db.insert("memberships", { orgId: f.orgId, userId: id, roleId: f.roleA, offboardingStatus: "PENDING_EXTERNAL_REMOVAL" });
    return id;
  });
  const removed = await f.t.run((ctx) => ctx.db.insert("users", { clerkId: "gone-1", name: "Removed Member", email: "removed@example.test" }));
  await f.t.run(async (ctx) => {
    await ctx.db.insert("tasks", { orgId: f.orgId, customerId: f.customerId, assignedTo: offboarding, title: "Offboarding", dueDate: 1, status: "PENDING" });
    await ctx.db.insert("tasks", { orgId: f.orgId, customerId: f.customerId, assignedTo: removed, title: "Removed", dueDate: 2, status: "PENDING" });
  });
  const tasks = (await relations(f)).tasks;
  expect(tasks.find((task) => task.title === "Offboarding")?.assignedUserName).toBe("Leaving Member");
  expect(tasks.find((task) => task.title === "Removed")?.assignedUserName).toBe("Unknown");
});
