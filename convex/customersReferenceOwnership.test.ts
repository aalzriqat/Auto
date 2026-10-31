/**
 * SCRUM-811 (tenant-reference ownership), customer write doors.
 *
 * `customers.update` and `customers.softDelete` take the only foreign id the
 * customer mutations accept (`customerId`; `create` and `importBulk` take none
 * besides `orgId`). The caller owns BOTH org A and org B, so authentication
 * cannot tell an org B customer from an org A one: only the reference check
 * refuses it. Foreign, missing (hard-deleted) and soft-deleted ids must be
 * refused with every table unchanged; a live same-org id is the control.
 */
import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

type Kind = "foreign" | "missing" | "deleted";
const KINDS: Kind[] = ["foreign", "missing", "deleted"];
const REFUSAL = "Customer not found in this organization.";

async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  await t.run((ctx) => ctx.db.insert("users", {
    clerkId: "customer-reference-owner", email: "customer-reference@example.test", name: "Reference owner",
  }));
  const owner = t.withIdentity({ subject: "customer-reference-owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "QA TEST customer reference A" });
  const orgBId = await owner.mutation(api.organizations.create, { name: "QA TEST customer reference B" });
  let n = 0;
  const customerIn = (org: Id<"organizations">, extra: { isDeleted?: boolean } = {}) =>
    t.run((ctx) => ctx.db.insert("customers", { orgId: org, firstName: "QA", lastName: `Customer ${++n}`, ...extra }));
  const customer = async (kind: Kind | "live") => {
    if (kind === "foreign") return customerIn(orgBId);
    const id = await customerIn(orgId, kind === "deleted" ? { isDeleted: true } : {});
    if (kind === "missing") await t.run((ctx) => ctx.db.delete(id));
    return id;
  };
  const snapshot = () => t.run(async (ctx) => ({
    customers: await ctx.db.query("customers").collect(),
    notifications: await ctx.db.query("notifications").collect(),
    leads: await ctx.db.query("leads").collect(),
    sales: await ctx.db.query("sales").collect(),
    idempotency: await ctx.db.query("commandIdempotency").collect(),
  }));
  return { t, owner, orgId, customer, snapshot };
}

const DOORS = [
  { name: "customers.update customerId", call: (f: Awaited<ReturnType<typeof fixture>>, customerId: Id<"customers">) =>
    f.owner.mutation(api.customers.update, { orgId: f.orgId, customerId, firstName: "Renamed" }) },
  { name: "customers.softDelete customerId", call: (f: Awaited<ReturnType<typeof fixture>>, customerId: Id<"customers">) =>
    f.owner.mutation(api.customers.softDelete, { orgId: f.orgId, customerId }) },
];

describe("SCRUM-811 customer doors own the customer reference before writing", () => {
  test("every customer door refuses a foreign, missing and soft-deleted customer and writes nothing", async () => {
    const failures: string[] = [];
    for (const door of DOORS) {
      for (const kind of KINDS) {
        const f = await fixture();
        const id = await f.customer(kind);
        const before = await f.snapshot();
        let refusal: unknown;
        try {
          await door.call(f, id);
        } catch (error) {
          refusal = error;
        }
        const label = `${door.name} / ${kind}`;
        if (refusal === undefined) failures.push(`${label}: accepted the reference`);
        else if (!(refusal instanceof ConvexError) || refusal.data !== REFUSAL) failures.push(`${label}: wrong refusal`);
        if (JSON.stringify(await f.snapshot()) !== JSON.stringify(before)) failures.push(`${label}: changed stored state`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("a live same-org customer is updated and then soft-deleted (positive control)", async () => {
    const f = await fixture();
    const id = await f.customer("live");
    await f.owner.mutation(api.customers.update, { orgId: f.orgId, customerId: id, firstName: "Renamed" });
    expect((await f.snapshot()).customers.find((row) => row._id === id)?.firstName).toBe("Renamed");
    await f.owner.mutation(api.customers.softDelete, { orgId: f.orgId, customerId: id });
    expect((await f.snapshot()).customers.find((row) => row._id === id)?.isDeleted).toBe(true);
  });
});
