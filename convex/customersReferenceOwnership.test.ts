/**
 * SCRUM-811 (tenant-reference ownership), customer write doors.
 *
 * `customers.update` and `customers.softDelete` take the only foreign id the
 * customer mutations accept (`customerId`; `create` and `importBulk` take none
 * besides `orgId`). The caller owns BOTH org A and org B, so authentication
 * cannot tell an org B customer from an org A one: only the reference check
 * refuses it. Foreign, missing (hard-deleted) and soft-deleted ids must be
 * refused with every table of the app schema unchanged; a live same-org id is
 * the control, and the bound regression test below runs it itself.
 *
 * "Every table" means every table of the app schema, read generically. The
 * aggregate component tables a customer write also maintains are not readable
 * through `ctx.db` and are outside that claim; Convex rolls back a throwing
 * mutation as a whole.
 */
import { expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id, TableNames } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

type Kind = "foreign" | "missing" | "deleted";
const KINDS: Kind[] = ["foreign", "missing", "deleted"];
const REFUSAL = "Customer not found in this organization.";
const TABLES = Object.keys(schema.tables) as TableNames[];

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
  // Every table of the app schema, read generically so a table a door writes
  // transitively cannot be left out of the comparison by omission.
  const snapshot = () => t.run(async (ctx) => {
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const table of TABLES) out[table] = (await ctx.db.query(table).collect()) as Array<Record<string, unknown>>;
    return out;
  });
  return { t, owner, orgId, customer, snapshot };
}

const DOORS = [
  { name: "customers.update customerId", call: (f: Awaited<ReturnType<typeof fixture>>, customerId: Id<"customers">) =>
    f.owner.mutation(api.customers.update, { orgId: f.orgId, customerId, firstName: "Renamed" }) },
  { name: "customers.softDelete customerId", call: (f: Awaited<ReturnType<typeof fixture>>, customerId: Id<"customers">) =>
    f.owner.mutation(api.customers.softDelete, { orgId: f.orgId, customerId }) },
];

// Bound by SCRUM-761 scenario `customer-doors-refuse-foreign-missing-and-deleted-customers`. It is a TOP-LEVEL
// test with its positive control inside it: the local runner anchors `^title$` against the full name
// (describe + title), so a title nested in a describe selects nothing and "executes" zero tests.
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

  // Positive control: a live same-org customer is updated and then soft-deleted by the same doors.
  const f = await fixture();
  const id = await f.customer("live");
  try {
    await f.owner.mutation(api.customers.update, { orgId: f.orgId, customerId: id, firstName: "Renamed" });
    if ((await f.snapshot()).customers.find((row) => row._id === id)?.firstName !== "Renamed")
      failures.push("customers.update / live: did not rename the customer (positive control)");
    await f.owner.mutation(api.customers.softDelete, { orgId: f.orgId, customerId: id });
    if ((await f.snapshot()).customers.find((row) => row._id === id)?.isDeleted !== true)
      failures.push("customers.softDelete / live: did not delete the customer (positive control)");
  } catch (error) {
    failures.push(`live same-org customer was refused (positive control): ${String(error)}`);
  }

  expect(failures).toEqual([]);
}, 120_000);
