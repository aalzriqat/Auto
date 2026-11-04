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
  return { t, owner, orgId, orgBId, customerIn, customer, snapshot };
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

// ---------------------------------------------------------------------------------------------------------------------
// Direct query-id slots (SCRUM-811 c24219 follow-up, Seat 2 at 339c9cf90). `customers.get` dereferences its
// `customerId` and must refuse a foreign, missing or soft-deleted one. `customers.checkDuplicates` only COMPARES its
// `excludeCustomerId` and never reads it, so every match comes from an org-scoped index; the test proves that a foreign,
// missing or soft-deleted exclude id excludes nothing and leaks nothing, while a live same-org id does exclude. Both are
// top-level tests with their controls inside (the runner anchors `^title$` against the full name).
// ---------------------------------------------------------------------------------------------------------------------
test("customers.get customerId: a foreign, missing or soft-deleted customer is refused, a same-org customer is returned", async () => {
  const failures: string[] = [];
  for (const kind of KINDS) {
    const f = await fixture();
    const id = await f.customer(kind);
    let refusal: unknown;
    let returned: unknown;
    try {
      returned = await f.owner.query(api.customers.get, { orgId: f.orgId, customerId: id });
    } catch (error) {
      refusal = error;
    }
    if (refusal === undefined) failures.push(`customers.get / ${kind}: returned ${JSON.stringify(returned)}`);
    else if (!(refusal instanceof ConvexError) || refusal.data !== REFUSAL) failures.push(`customers.get / ${kind}: wrong refusal`);
  }

  // Positive control: a live same-org customer is returned, as stored.
  const f = await fixture();
  const live = await f.customer("live");
  try {
    const row = await f.owner.query(api.customers.get, { orgId: f.orgId, customerId: live });
    if (row._id !== live || row.orgId !== f.orgId || row.firstName !== "QA") failures.push("customers.get / live: wrong customer returned (positive control)");
  } catch (error) {
    failures.push(`customers.get / live was refused (positive control): ${String(error)}`);
  }

  expect(failures).toEqual([]);
}, 120_000);

test("customers.checkDuplicates excludeCustomerId: a foreign, missing or soft-deleted id excludes nothing and leaks nothing, a same-org id excludes that customer", async () => {
  const failures: string[] = [];
  const query = { phone: "079 111 2233", email: "DUP.OWNER@example.test", firstName: "dana", lastName: "cole" };
  const shapeOf = (result: { exactPhoneMatch: { _id: string } | null; exactEmailMatch: { _id: string } | null; possibleNameMatches: Array<{ _id: string }> }) => ({
    phone: result.exactPhoneMatch?._id ?? null,
    email: result.exactEmailMatch?._id ?? null,
    names: result.possibleNameMatches.map((row) => row._id),
  });
  for (const kind of [...KINDS, "live"] as const) {
    const f = await fixture();
    const own = await f.t.run((ctx) => ctx.db.insert("customers", {
      orgId: f.orgId, firstName: "Dana", lastName: "Cole", phone: "0791112233", email: "dup.owner@example.test",
    }));
    // Org B holds a customer with the SAME phone, email and a marker name: only an org-scoped lookup can ignore it.
    await f.t.run((ctx) => ctx.db.insert("customers", {
      orgId: f.orgBId, firstName: "Dana", lastName: "ORGB-DUP-MARKER", phone: "0791112233", email: "dup.owner@example.test",
    }));
    const excluded = kind === "live" ? own : await f.customer(kind);
    const result = await f.owner.query(api.customers.checkDuplicates, { orgId: f.orgId, ...query, excludeCustomerId: excluded });
    const text = JSON.stringify(result);
    if (text.includes("ORGB-DUP-MARKER")) failures.push(`excludeCustomerId ${kind}: org B customer leaked`);
    const shape = shapeOf(result);
    if (kind === "live") {
      // Positive control: excluding the org A match removes it from all three results.
      if (shape.phone !== null || shape.email !== null || shape.names.length !== 0) failures.push(`excludeCustomerId live: org A match not excluded ${JSON.stringify(shape)}`);
    } else if (shape.phone !== own || shape.email !== own || shape.names.join(",") !== own) {
      failures.push(`excludeCustomerId ${kind}: expected the org A match ${own} in all three results, got ${JSON.stringify(shape)}`);
    }
  }

  expect(failures).toEqual([]);
}, 120_000);