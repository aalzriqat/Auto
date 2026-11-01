/**
 * SCRUM-886 (OWASP API3:2023, Broken Object Property Level Authorization): a vehicle's cost and
 * margin fields must reach only a caller who may read vehicle cost (the system owner, or a role
 * holding `view:cost_price`).
 *
 * Before this change `vehicles.get` and `vehicles.list` withheld only `purchasePrice`, and
 * `vehicles.listAll` withheld `purchasePrice` and `sourceCost`. `sourceCost`, `landedCostTotal` and
 * `minimumProfit` reached the default SALES and RECEPTION roles, and four more readers returned the
 * whole stored document.
 *
 * Method: the car carries a distinct sentinel number in each cost field. For every reader and every
 * role without cost permission the serialized response is searched for each sentinel, so a field
 * that moves under a new name still fails. A second assertion checks the reverse: every non-cost
 * field of the stored row is still served, so the allowlist cannot silently drop a display field.
 */
import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES, SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";
import { projectVehicleForRole } from "./utils/vehicleCostVisibility";
import { projectSaleRow } from "./utils/saleRowProjection";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

/** One distinct number per cost-bearing field, so a leak names the field it came through. */
const SENTINEL = {
  purchasePrice: 7_100_001,
  landedCostTotal: 7_100_002,
  minimumProfit: 7_100_003,
  sourceCost: 7_100_004,
  landedCostLine: 7_100_005,
  editedPurchasePrice: 7_100_006,
  editedSourceCost: 7_100_007,
  editedMinimumProfit: 7_100_008,
  // Frozen onto the sale row at completion. The entitlement IS the supplier cost; the margin is the
  // sale price minus it. The concession is the finance-tier sibling.
  saleSupplierEntitlement: 7_100_009,
  saleConsignedMargin: 7_100_010,
  saleSupplierConcession: 7_100_011,
} as const;
type SentinelName = keyof typeof SENTINEL;

const VEHICLE_COST_KEYS = ["purchasePrice", "landedCostTotal", "minimumProfit", "sourceCost"] as const;
const SALE_COST_KEYS = ["consignedSupplierEntitlementMinor", "consignedMarginMinor"] as const;
const VIN = "VIN886SENTINEL01";

type RoleName = "SALES" | "RECEPTION" | "ACCOUNTANT" | "EDITOR" | "MANAGER" | "OWNER";
const WITHOUT_COST: RoleName[] = ["SALES", "RECEPTION", "ACCOUNTANT", "EDITOR"];
const WITH_COST: RoleName[] = ["MANAGER", "OWNER"];

function permissionsFor(role: RoleName): string[] {
  if (role === "OWNER") return [...ALL_PERMISSIONS];
  // Not a shipped template: the narrowest role that can open the approval queue without holding cost.
  if (role === "EDITOR") return ["view:vehicles", "edit:vehicles"];
  const template = DEFAULT_ROLE_TEMPLATES.find((candidate) => candidate.name === role);
  if (!template) throw new Error(`No default role template named ${role}`);
  return [...template.permissions];
}

async function seed() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Cost Visibility", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );

  const members = {} as Record<RoleName, { userId: Id<"users">; as: ReturnType<typeof t.withIdentity> }>;
  const allRoles: RoleName[] = [...WITHOUT_COST, ...WITH_COST];
  for (const role of allRoles) {
    const clerkId = `scrum886_${role.toLowerCase()}`;
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: role })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: role === "OWNER" ? SYSTEM_OWNER_ROLE_NAME : `Role ${role}`,
        permissions: permissionsFor(role),
        ...(role === "OWNER" ? { isSystemOwnerRole: true } : {}),
      })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    members[role] = { userId, as: t.withIdentity({ subject: clerkId, clerkId }) };
  }

  const { vehicleId, customerId, saleId, leadId, applicationId } = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: VIN, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White",
      fuelType: "Gas", transmission: "Auto", sellingPrice: 25_000, status: "AVAILABLE",
      sourceType: "SOURCED", sourcedFromName: "Amman Importer Co", notes: "Fresh arrival",
      purchasePrice: SENTINEL.purchasePrice,
      landedCostTotal: SENTINEL.landedCostTotal,
      minimumProfit: SENTINEL.minimumProfit,
      sourceCost: SENTINEL.sourceCost,
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: "Synthetic" });
    const salespersonId = members.SALES.userId;
    const saleId = await ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId, salePrice: 25_000, saleDate: Date.now(), status: "COMPLETED",
      consignedSupplierEntitlementMinor: SENTINEL.saleSupplierEntitlement,
      consignedMarginMinor: SENTINEL.saleConsignedMargin,
      consignedMarginCurrency: "JOD",
      consignedSupplierConcessionMinor: SENTINEL.saleSupplierConcession,
    });
    const leadId = await ctx.db.insert("leads", { orgId, customerId, vehicleId, stage: "NEW", source: "Website" });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 25_000, downPayment: 0, termMonths: 12,
      status: "DRAFT", createdBy: salespersonId, createdAt: Date.now(),
    });
    const applicationId = await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId, status: "PENDING_DOCS",
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    await ctx.db.insert("vehicleLandedCosts", {
      vehicleId, orgId, items: [{ label: "Freight", amount: SENTINEL.landedCostLine }],
      total: SENTINEL.landedCostLine, updatedAt: Date.now(), updatedBy: salespersonId,
    });
    await ctx.db.insert("vehicleEdits", {
      orgId, vehicleId, requestedBy: salespersonId, type: "UPDATE", status: "PENDING", createdAt: Date.now(),
      payload: {
        mileage: 12_345,
        purchasePrice: SENTINEL.editedPurchasePrice,
        sourceCost: SENTINEL.editedSourceCost,
        minimumProfit: SENTINEL.editedMinimumProfit,
      },
    });
    return { vehicleId, customerId, saleId, leadId, applicationId };
  });

  return { t, orgId, vehicleId, customerId, saleId, leadId, applicationId, members };
}
type Seeded = Awaited<ReturnType<typeof seed>>;
type Actor = Seeded["members"][RoleName]["as"];

/** Names of the sentinels whose value appears anywhere in the serialized response. */
function leakedSentinels(response: unknown): SentinelName[] {
  const serialized = JSON.stringify(response) ?? "";
  return (Object.keys(SENTINEL) as SentinelName[]).filter(
    // The concession is finance-tier (view:finance), not cost-tier; it has its own assertion below.
    (name) => name !== "saleSupplierConcession" && serialized.includes(String(SENTINEL[name]))
  );
}

/** Sale-row cost keys present on any sale row the response carries. */
function saleCostKeysIn(reader: Reader, response: unknown): string[] {
  const rows = [reader.saleIn?.(response), ...(reader.salesIn?.(response) ?? [])].filter(
    (row): row is Record<string, unknown> => Boolean(row)
  );
  return rows.flatMap((row) => SALE_COST_KEYS.filter((key) => key in row));
}

interface Reader {
  name: string;
  call: (s: Seeded, as: Actor) => Promise<unknown>;
  /** The vehicle document inside the response, when the response carries one. */
  vehicleIn?: (response: unknown) => Record<string, unknown> | null | undefined;
  /** The sale row inside the response, when the response carries one. */
  saleIn?: (response: unknown) => Record<string, unknown> | null | undefined;
  /** The sale rows inside the response, when it carries several. */
  salesIn?: (response: unknown) => Array<Record<string, unknown>>;
  /** The sentinels a caller who may read cost must still receive from this reader. */
  served: SentinelName[];
}

const ALL_VEHICLE_SENTINELS: SentinelName[] = ["purchasePrice", "landedCostTotal", "minimumProfit", "sourceCost"];
// The concession is finance-tier, not cost-tier: a cost-only reader (MANAGER holds both) may not get it
// from a role that lacks view:finance. Asserted separately below.
const SALE_COST_SENTINELS: SentinelName[] = ["saleSupplierEntitlement", "saleConsignedMargin"];

const READERS: Reader[] = [
  {
    name: "vehicles.get",
    call: (s, as) => as.query(api.vehicles.get, { orgId: s.orgId, vehicleId: s.vehicleId }),
    vehicleIn: (r) => r as Record<string, unknown>,
    served: ALL_VEHICLE_SENTINELS,
  },
  {
    name: "vehicles.list",
    call: (s, as) =>
      as.query(api.vehicles.list, { orgId: s.orgId, paginationOpts: { numItems: 10, cursor: null } }),
    vehicleIn: (r) => (r as { page: Array<Record<string, unknown>> }).page[0],
    served: ALL_VEHICLE_SENTINELS,
  },
  {
    name: "vehicles.listAll",
    call: (s, as) => as.query(api.vehicles.listAll, { orgId: s.orgId }),
    vehicleIn: (r) => (r as Array<Record<string, unknown>>)[0],
    served: ALL_VEHICLE_SENTINELS,
  },
  {
    name: "vehicles.getByVin",
    call: (s, as) => as.query(api.vehicles.getByVin, { orgId: s.orgId, vin: VIN }),
    vehicleIn: (r) => r as Record<string, unknown> | null,
    served: ALL_VEHICLE_SENTINELS,
  },
  {
    name: "vehicles.exportData",
    call: (s, as) => as.query(api.vehicles.exportData, { orgId: s.orgId }),
    served: ["sourceCost"],
  },
  {
    name: "vehicles.getLandedCosts",
    call: (s, as) => as.query(api.vehicles.getLandedCosts, { orgId: s.orgId, vehicleId: s.vehicleId }),
    served: ["landedCostLine"],
  },
  {
    name: "sales.get",
    call: (s, as) => as.query(api.sales.get, { orgId: s.orgId, saleId: s.saleId }),
    vehicleIn: (r) => (r as { vehicle: Record<string, unknown> | null }).vehicle,
    saleIn: (r) => r as Record<string, unknown>,
    served: [...ALL_VEHICLE_SENTINELS, ...SALE_COST_SENTINELS],
  },
  {
    name: "sales.getSaleTrail",
    call: (s, as) => as.query(api.sales.getSaleTrail, { orgId: s.orgId, saleId: s.saleId }),
    vehicleIn: (r) => (r as { vehicle: Record<string, unknown> | null }).vehicle,
    saleIn: (r) => (r as { sale: Record<string, unknown> }).sale,
    served: [...ALL_VEHICLE_SENTINELS, ...SALE_COST_SENTINELS],
  },
  {
    // Returned the stored vehicle on every quote; the screens read only its label fields.
    name: "customers.getRelations",
    call: (s, as) => as.query(api.customers.getRelations, { orgId: s.orgId, customerId: s.customerId }),
    vehicleIn: (r) => (r as { quotes: Array<{ vehicle: Record<string, unknown> | null }> }).quotes[0]?.vehicle,
    salesIn: (r) => (r as { sales: Array<Record<string, unknown>> }).sales,
    served: [...ALL_VEHICLE_SENTINELS, ...SALE_COST_SENTINELS],
  },
  {
    name: "leads.get",
    call: (s, as) => as.query(api.leads.get, { orgId: s.orgId, leadId: s.leadId }),
    vehicleIn: (r) => (r as { vehicle: Record<string, unknown> | null }).vehicle,
    served: ALL_VEHICLE_SENTINELS,
  },
  {
    name: "applications.get",
    call: (s, as) => as.query(api.applications.get, { orgId: s.orgId, applicationId: s.applicationId }),
    vehicleIn: (r) => (r as { vehicle: Record<string, unknown> | null } | null)?.vehicle,
    served: ALL_VEHICLE_SENTINELS,
  },
  {
    name: "vehicleEdits.listPending",
    call: (s, as) => as.query(api.vehicleEdits.listPending, { orgId: s.orgId }),
    vehicleIn: (r) => (r as Array<{ vehicle: Record<string, unknown> | null }>)[0]?.vehicle,
    served: [...ALL_VEHICLE_SENTINELS, "editedPurchasePrice", "editedSourceCost", "editedMinimumProfit"],
  },
  {
    name: "vehicleEdits.getHistory",
    call: (s, as) => as.query(api.vehicleEdits.getHistory, { orgId: s.orgId, vehicleId: s.vehicleId }),
    served: ["editedPurchasePrice", "editedSourceCost", "editedMinimumProfit"],
  },
];

/** A role that may not call a reader at all is a refusal, which leaks nothing. */
async function callOrRefusal(reader: Reader, s: Seeded, role: RoleName): Promise<{ refused: true } | { refused: false; response: unknown }> {
  try {
    return { refused: false, response: await reader.call(s, s.members[role].as) };
  } catch (error) {
    const code = (error as { data?: { code?: string } }).data?.code;
    if (code === "FORBIDDEN") return { refused: true };
    throw error;
  }
}

// Bound by SCRUM-761 records. Each is one top-level test so the record can name it exactly.
test("scenario vehicle-readers-withhold-cost: SALES, RECEPTION, ACCOUNTANT and EDITOR receive no cost or margin value from any vehicle reader", async () => {
  const s = await seed();
  const reached: string[] = [];
  for (const role of WITHOUT_COST) {
    for (const reader of READERS) {
      const outcome = await callOrRefusal(reader, s, role);
      if (outcome.refused) continue;
      reached.push(`${role}:${reader.name}`);
      expect(leakedSentinels(outcome.response), `${role} via ${reader.name}`).toEqual([]);
      expect(saleCostKeysIn(reader, outcome.response), `${role} via ${reader.name} sale row`).toEqual([]);
      const vehicle = reader.vehicleIn?.(outcome.response);
      if (vehicle) for (const key of VEHICLE_COST_KEYS) expect(vehicle).not.toHaveProperty(key);
    }
  }
  // The sweep must have reached the readers the defect lived in, or it proved nothing.
  expect(reached).toEqual(
    expect.arrayContaining([
      "SALES:vehicles.get", "SALES:vehicles.list", "SALES:vehicles.listAll", "RECEPTION:vehicles.get",
      "SALES:vehicles.getByVin", "SALES:vehicles.getLandedCosts", "SALES:sales.get", "SALES:leads.get",
      "SALES:sales.getSaleTrail", "SALES:customers.getRelations", "RECEPTION:customers.getRelations",
      "SALES:applications.get", "EDITOR:vehicleEdits.listPending", "SALES:vehicleEdits.getHistory",
    ])
  );
});

test("scenario vehicle-readers-serve-cost: MANAGER and OWNER still receive the cost each reader served before", async () => {
  const s = await seed();
  for (const role of WITH_COST) {
    for (const reader of READERS) {
      const outcome = await callOrRefusal(reader, s, role);
      expect(outcome.refused, `${role} via ${reader.name}`).toBe(false);
      if (outcome.refused) continue;
      expect(leakedSentinels(outcome.response), `${role} via ${reader.name}`).toEqual(expect.arrayContaining(reader.served));
    }
  }
});

test("scenario sale-concession-finance-tier: only a caller with view:finance receives the supplier concession, and only a caller with view:cost_price receives the entitlement and margin", async () => {
  const s = await seed();
  const expected: Array<[RoleName, { concession: boolean; cost: boolean }]> = [
    ["SALES", { concession: false, cost: false }],
    ["RECEPTION", { concession: false, cost: false }],
    ["EDITOR", { concession: false, cost: false }],
    ["ACCOUNTANT", { concession: true, cost: false }],
    ["MANAGER", { concession: false, cost: true }],
    ["OWNER", { concession: true, cost: true }],
  ];
  const saleReaders = READERS.filter((reader) => reader.saleIn || reader.salesIn);
  expect(saleReaders.map((reader) => reader.name)).toEqual(["sales.get", "sales.getSaleTrail", "customers.getRelations"]);
  for (const [role, may] of expected) {
    for (const reader of saleReaders) {
      const outcome = await callOrRefusal(reader, s, role);
      if (outcome.refused) continue;
      const serialized = JSON.stringify(outcome.response);
      expect(serialized.includes(String(SENTINEL.saleSupplierConcession)), `${role} concession via ${reader.name}`).toBe(may.concession);
      expect(serialized.includes(String(SENTINEL.saleSupplierEntitlement)), `${role} entitlement via ${reader.name}`).toBe(may.cost);
      expect(serialized.includes(String(SENTINEL.saleConsignedMargin)), `${role} margin via ${reader.name}`).toBe(may.cost);
    }
  }
});

describe("SCRUM-886: vehicle cost fields reach only a caller who may read cost", () => {
  describe.each(READERS)("$name", (reader) => {
    test.each(WITHOUT_COST)("%s receives no cost or margin value", async (role) => {
      const s = await seed();
      const outcome = await callOrRefusal(reader, s, role);
      if (outcome.refused) return;
      expect(leakedSentinels(outcome.response)).toEqual([]);
      expect(saleCostKeysIn(reader, outcome.response)).toEqual([]);
      const vehicle = reader.vehicleIn?.(outcome.response);
      if (vehicle) {
        for (const key of VEHICLE_COST_KEYS) expect(vehicle).not.toHaveProperty(key);
      }
    });

    test.each(WITHOUT_COST)("%s still receives every non-cost field of the car", async (role) => {
      const s = await seed();
      const outcome = await callOrRefusal(reader, s, role);
      if (outcome.refused || !reader.vehicleIn) return;
      const stored = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
      const vehicle = reader.vehicleIn(outcome.response);
      expect(vehicle).toBeTruthy();
      for (const key of Object.keys(stored ?? {})) {
        if ((VEHICLE_COST_KEYS as readonly string[]).includes(key)) continue;
        expect(vehicle).toHaveProperty(key);
      }
    });

    test.each(WITH_COST)("%s still receives the cost this reader served before", async (role) => {
      const s = await seed();
      const outcome = await callOrRefusal(reader, s, role);
      expect(outcome.refused).toBe(false);
      if (outcome.refused) return;
      expect(leakedSentinels(outcome.response)).toEqual(expect.arrayContaining(reader.served));
    });
  });

  describe.each(READERS.filter((reader) => reader.saleIn || reader.salesIn))(
    "$name: the supplier concession stays finance-tier",
    (reader) => {
      test.each([
        ["SALES", false],
        ["RECEPTION", false],
        ["MANAGER", false],
        ["EDITOR", false],
        ["ACCOUNTANT", true],
        ["OWNER", true],
      ] as Array<[RoleName, boolean]>)("%s sees the concession: %s", async (role, mayRead) => {
        const s = await seed();
        const outcome = await callOrRefusal(reader, s, role);
        if (outcome.refused) return;
        const serialized = JSON.stringify(outcome.response);
        expect(serialized.includes(String(SENTINEL.saleSupplierConcession))).toBe(mayRead);
      });
    }
  );

  test("the sweep reaches the roles the ticket names: SALES and RECEPTION hold view:vehicles, neither holds view:cost_price", () => {
    for (const role of ["SALES", "RECEPTION"] as const) {
      const permissions = permissionsFor(role);
      expect(permissions).toContain("view:vehicles");
      expect(permissions).not.toContain("view:cost_price");
    }
  });

  test("a reader that was reachable by a restricted role is not silently refused by the harness", async () => {
    const s = await seed();
    const reachable: string[] = [];
    for (const reader of READERS) {
      const outcome = await callOrRefusal(reader, s, "SALES");
      if (!outcome.refused) reachable.push(reader.name);
    }
    // These are the doors SALES can really open. If one starts refusing, the leak sweep above
    // would pass vacuously for it, so the test fails and the change has to be argued for.
    expect(reachable).toEqual(
      expect.arrayContaining([
        "vehicles.get", "vehicles.list", "vehicles.listAll", "vehicles.getByVin", "vehicles.getLandedCosts",
        "sales.get", "sales.getSaleTrail", "customers.getRelations", "leads.get", "applications.get",
        "vehicleEdits.getHistory",
      ])
    );
  });

  test("a caller without cost still sees the non-cost fields of an edit request, and the cost keys are absent rather than zero", async () => {
    const s = await seed();
    const history = (await s.members.SALES.as.query(api.vehicleEdits.getHistory, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
    })) as Array<{ payload: Record<string, unknown> }>;
    expect(history[0].payload).toEqual({ mileage: 12_345 });
  });

  test("the sale projection withholds COST-tier fields by view:cost_price and FINANCE-tier fields by view:finance, independently", () => {
    const stored = {
      _id: "s1",
      salePrice: 1,
      consignedSupplierEntitlementMinor: SENTINEL.saleSupplierEntitlement,
      consignedMarginMinor: SENTINEL.saleConsignedMargin,
      consignedSupplierConcessionMinor: SENTINEL.saleSupplierConcession,
    } as unknown as Doc<"sales">;
    const role = (permissions: string[]) => ({ permissions }) as Doc<"roles">;
    expect(projectSaleRow(stored, role(["view:sales"]))).toEqual({ _id: "s1", salePrice: 1 });
    expect(projectSaleRow(stored, role(["view:sales", "view:finance"]))).toEqual({
      _id: "s1",
      salePrice: 1,
      consignedSupplierConcessionMinor: SENTINEL.saleSupplierConcession,
    });
    expect(projectSaleRow(stored, role(["view:sales", "view:cost_price"]))).toEqual({
      _id: "s1",
      salePrice: 1,
      consignedSupplierEntitlementMinor: SENTINEL.saleSupplierEntitlement,
      consignedMarginMinor: SENTINEL.saleConsignedMargin,
    });
    expect(projectSaleRow(stored, role(["view:sales", "view:finance", "view:cost_price"]))).toBe(stored);
  });

  test("the restricted projection is an allowlist: a field nobody classified is withheld", () => {
    const stored = { _id: "v1", make: "Toyota", purchasePrice: 1, newlyAddedUnclassifiedField: "x" } as unknown as Doc<"vehicles">;
    const restricted = projectVehicleForRole(stored, { permissions: ["view:vehicles"] } as Doc<"roles">);
    expect(restricted).toEqual({ _id: "v1", make: "Toyota" });
    const allowed = projectVehicleForRole(stored, { permissions: ["view:cost_price"] } as Doc<"roles">);
    expect(allowed).toBe(stored);
  });
});
