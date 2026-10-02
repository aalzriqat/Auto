import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { RESET_ORG_INDEX_FOR_TEST, RESET_TABLES_FOR_TEST } from "./orgFinancialReset";

/**
 * SCRUM-555 — the reset reads every table through an orgId-leading index
 * instead of a filtered scan. These tests pin that the rewrite kept the two
 * properties that matter on a destructive tool: tenant scoping and the
 * authority preflight.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

function setup() {
  return convexTestWithComponents(schema, MODULES);
}

type T = ReturnType<typeof setup>;

describe("reset org-index map (static, against the real schema)", () => {
  test("every reset table names an index that exists with orgId as its FIRST field", () => {
    const tables = (schema as any).tables as Record<string, { indexes: { indexDescriptor: string; fields: string[] }[] }>;
    expect(Object.keys(RESET_ORG_INDEX_FOR_TEST).sort()).toEqual([...RESET_TABLES_FOR_TEST].sort());
    for (const table of RESET_TABLES_FOR_TEST) {
      const indexName = RESET_ORG_INDEX_FOR_TEST[table];
      const index = tables[table]?.indexes.find((i) => i.indexDescriptor === indexName);
      expect(index, `${table}.${indexName} must exist`).toBeDefined();
      expect(index!.fields[0], `${table}.${indexName} must lead with orgId`).toBe("orgId");
    }
  });
});

async function makeOrg(t: T, name: string) {
  return await t.run((ctx) => ctx.db.insert("organizations", { name, createdAt: Date.now() }));
}

/** One pending event for the org, plus an authority work row and an attempt. */
async function seedAuthority(t: T, orgId: Id<"organizations">, tag: string) {
  return await t.run(async (ctx: any) => {
    const userId = await ctx.db.insert("users", {
      clerkId: `idx_${tag}`,
      email: `${tag}@x.com`,
      name: "Op",
    });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, make: "Toyota", model: "Corolla", year: 2020, vin: `VIN${tag}`, mileage: 1,
      color: "White", fuelType: "PETROL", transmission: "AUTOMATIC", sellingPrice: 10000,
      status: "SOLD" as const,
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "K", lastName: tag });
    const depositId = await ctx.db.insert("deposits", {
      orgId, vehicleId, customerId, amount: 1000, status: "HELD" as const, holdActive: true,
      usesVehicleHoldRows: false, createdBy: userId, createdAt: Date.now(),
    });
    const saleId = await ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId: userId, salePrice: 10000,
      saleDate: Date.now(), status: "CANCELLED" as const,
    });
    const pendingEventId = await ctx.db.insert("pendingAccountingEvents", {
      orgId, kind: "REVERSE" as const, status: "POSTED" as const,
      idempotencyKey: `idx_${tag}`, accountingDate: Date.now(), actorId: userId, attempts: 1,
      createdAt: Date.now(), sourceType: "depositApplications", sourceId: `idx_${tag}`,
    });
    const workId = await ctx.db.insert("commitmentAuthorityWork", {
      orgId, workKey: `idx_${tag}:DIRECT:${String(depositId)}`, status: "READY" as const,
      sourceKind: "DIRECT" as const, depositId, vehicleId, saleId, pendingEventId,
      executions: 0, generation: 0, nextActionAt: Date.now(), createdAt: Date.now(),
    });
    const attemptId = await ctx.db.insert("commitmentAuthorityAttempt", {
      orgId, workId, generation: 0, attemptKey: `${String(workId)}:0`,
      status: "SCHEDULED" as const, createdAt: Date.now(),
    });
    return { pendingEventId, workId, attemptId };
  });
}

async function pendingEventFor(t: T, orgId: Id<"organizations">) {
  return await t.run((ctx: any) =>
    ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_status", (q: any) => q.eq("orgId", orgId))
      .collect()
  );
}

describe("resetOrgFinancialData tenant scoping through the org indexes", () => {
  test("resetting org A leaves org B's authority rows and pending events untouched, and B's rows do not trigger A's refusal", async () => {
    const t = setup();
    const a = await makeOrg(t, "OrgA");
    const b = await makeOrg(t, "OrgB");
    // A has a row in a `by_org_status`-read table (pendingAccountingEvents) but
    // NO authority work or attempt; B holds the full authority lifecycle.
    await t.run(async (ctx: any) => {
      const userId = await ctx.db.insert("users", { clerkId: "idx_a", email: "a@x.com", name: "A" });
      await ctx.db.insert("pendingAccountingEvents", {
        orgId: a, kind: "REVERSE" as const, status: "POSTED" as const,
        idempotencyKey: "idx_a_pending", accountingDate: Date.now(), actorId: userId, attempts: 1,
        createdAt: Date.now(), sourceType: "depositApplications", sourceId: "idx_a_pending",
      });
    });
    const bRows = await seedAuthority(t, b, "b");

    const result = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId: a,
      dryRun: false,
    });

    // The preflight is scoped: B's work/attempt must not make A refuse.
    expect(result.authorityLifecyclePresent).toBe(false);
    expect(result.perTable.pendingAccountingEvents).toBe(1);

    expect(await pendingEventFor(t, a)).toHaveLength(0);
    // B's rows, in the preflight tables and in a generic-loop table, are intact.
    expect(await pendingEventFor(t, b)).toHaveLength(1);
    await t.run(async (ctx: any) => {
      expect(await ctx.db.get(bRows.workId)).not.toBeNull();
      expect(await ctx.db.get(bRows.attemptId)).not.toBeNull();
      expect(await ctx.db.get(bRows.pendingEventId)).not.toBeNull();
    });
  });

  test("the existence check sees THIS org's attempt row on its own, and ignores another org's", async () => {
    const t = setup();
    const a = await makeOrg(t, "OrgAttemptA");
    const c = await makeOrg(t, "OrgClean");
    const b = await makeOrg(t, "OrgAttemptB");
    // Only B owns real work; A's attempt row is fabricated against B's work id so
    // the ATTEMPT existence check is exercised without any work row for A.
    const bRows = await seedAuthority(t, b, "ab");
    await t.run((ctx: any) =>
      ctx.db.insert("commitmentAuthorityAttempt", {
        orgId: a, workId: bRows.workId, generation: 1, attemptKey: `${String(bRows.workId)}:1`,
        status: "FAILED" as const, createdAt: Date.now(),
      })
    );

    const dryA = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: a });
    expect(dryA.authorityLifecyclePresent).toBe(true);
    await expect(
      t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: a, dryRun: false })
    ).rejects.toThrow(/commitment-authority/i);

    // CONTROL: an org with no authority rows is not refused just because other
    // orgs hold them.
    const dryC = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: c });
    expect(dryC.authorityLifecyclePresent).toBe(false);
  });
});
