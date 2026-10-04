/**
 * SCRUM-413 PR-B (decision D-32) - the deal doors move off finalize:financed_deal.
 *
 * Invariant: only ROUTE (manage:supplier_settlement) holders record a financed
 * application's supplier route, and only CANCEL_CLOSED (cancel:closed_deal)
 * holders reverse a CLOSED financed deal, through any door. No default template
 * grants either to SALES, and the retired finalize:financed_deal never mints
 * an active authority. Owner status is unchanged.
 *
 * Role x status x door matrix. Each cell is an OUTCOME (ALLOWED / REFUSED), so a
 * failure prints the whole row rather than the first wrong cell.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime and not production data.
 */
import {
  C, H, approved, downgradeToV1, finalizeAsOwner, readyDeal, refusalMessageOf, seedFinancedDealership, underReview,
} from "../test-utils/financedDealFixture";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const ROUTE = PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT;
const CANCEL_CLOSED = PERMISSIONS.CANCEL_CLOSED_DEAL;
const CREATE = PERMISSIONS.CREATE_FINANCE_APPLICATION;
const CONFIRM = PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT;
/** A literal on purpose: the retired permission is no longer in PERMISSIONS. */
const LEGACY_FINALIZE = "finalize:financed_deal";

const template = (name: string): string[] =>
  [...(DEFAULT_ROLE_TEMPLATES.find((r) => r.name === name)?.permissions ?? [])];

/** What every door needs before it ever reaches the permission under test. */
const DOOR_BASE = [
  "view:finance_applications", "view:sales", "edit:sales", "approve:requests", "view:vehicles", "view:customers",
];

type RoleKey =
  | "SALES" | "MANAGER" | "ACCOUNTANT" | "ROUTE_ONLY" | "CANCEL_ONLY" | "CANCEL_PLUS_CONFIRM"
  | "FINALIZE_ONLY" | "OWNER";

/**
 * ROUTE_ONLY and FINALIZE_ONLY deliberately hold CREATE and CONFIRM as well:
 * they would pass every OTHER gate, so a refusal is about the authority under
 * test and nothing else. CANCEL_ONLY holds no CREATE - the point of D-32.
 */
const ROLE_PERMS: Record<Exclude<RoleKey, "OWNER">, string[]> = {
  SALES: template("SALES"),
  MANAGER: template("MANAGER"),
  ACCOUNTANT: template("ACCOUNTANT"),
  ROUTE_ONLY: [ROUTE, CREATE, CONFIRM, "view:finance"],
  CANCEL_ONLY: [CANCEL_CLOSED],
  CANCEL_PLUS_CONFIRM: [CANCEL_CLOSED, CONFIRM],
  FINALIZE_ONLY: [LEGACY_FINALIZE, CREATE, CONFIRM],
};
const ROLE_KEYS = [...Object.keys(ROLE_PERMS), "OWNER"] as RoleKey[];

/** Non-owner actors get DOOR_BASE on top of the permissions under test. */
const ACTOR_PERMS = Object.fromEntries(
  Object.entries(ROLE_PERMS).map(([key, perms]) => [key, [...new Set([...perms, ...DOOR_BASE])]])
) as Record<Exclude<RoleKey, "OWNER">, string[]>;

async function seed(tag: string, opts: { sourced?: boolean } = {}) {
  // `owner` drives the deal; `approver` is a SECOND owner-status identity (the
  // OWNER matrix row), because sale cancellation refuses the sale's own salesperson.
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMISSIONS, actors: ACTOR_PERMS,
    label: "S413b", vinPrefix: "VIN413B", sourced: opts.sourced,
  });
  return { ...s, actors: { ...s.actors, OWNER: s.approver } as Record<RoleKey, (typeof s.approver)> };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Approved, with a held deposit H and a dealership contribution C, finalized. */
async function finalizedDeal(tag: string, version: 1 | 2 = 2) {
  const s = await seed(tag);
  const { applicationId } = await readyDeal(s);
  await finalizeAsOwner(s, applicationId);
  if (version === 1) await downgradeToV1(s, applicationId);
  return { s, applicationId };
}

const refusalOf = refusalMessageOf;

type Outcome = "ALLOWED" | "REFUSED";
/** Runs `attempt` as each role in order and returns the outcome row. */
async function row(
  roles: RoleKey[],
  attempt: (role: RoleKey) => Promise<unknown>
): Promise<Partial<Record<RoleKey, Outcome>>> {
  const out: Partial<Record<RoleKey, Outcome>> = {};
  for (const role of roles) out[role] = (await refusalOf(attempt(role))) === null ? "ALLOWED" : "REFUSED";
  return out;
}

const cancelAs = (
  s: Seeded, applicationId: Id<"financeApplications">, role: RoleKey, idempotencyKey: string = crypto.randomUUID()
) =>
  s.actors[role].as.mutation(api.applications.cancelApplication, {
    orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey,
  });

describe("SCRUM-413 PR-B D-a - setSupplierSettlementRoute takes ROUTE", () => {
  test("only ROUTE holders (and the owner) record the route; SALES, CANCEL_CLOSED and legacy FINALIZE are refused", async () => {
    const s = await seed("route", { sourced: true });
    const applicationId = await approved(s);
    const outcomes = await row(ROLE_KEYS, (role) =>
      s.actors[role].as.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "THROUGH_DEALERSHIP",
      })
    );
    expect(outcomes).toEqual({
      SALES: "REFUSED",
      MANAGER: "ALLOWED",
      ACCOUNTANT: "ALLOWED",
      ROUTE_ONLY: "ALLOWED",
      CANCEL_ONLY: "REFUSED",
      CANCEL_PLUS_CONFIRM: "REFUSED",
      FINALIZE_ONLY: "REFUSED",
      OWNER: "ALLOWED",
    });
  });

  test("the refusal names the missing authority", async () => {
    const s = await seed("routemsg", { sourced: true });
    const applicationId = await approved(s);
    const refusal = await refusalOf(
      s.actors.FINALIZE_ONLY.as.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "THROUGH_DEALERSHIP",
      })
    );
    expect(refusal).toMatch(/manage:supplier_settlement/);
  });
});

describe("SCRUM-413 PR-B D-b - cancelApplication, CLOSED v2", () => {
  test("refused: SALES, ACCOUNTANT, ROUTE_ONLY, FINALIZE_ONLY, and CANCEL_CLOSED without CONFIRM names the manager", async () => {
    const { s, applicationId } = await finalizedDeal("b2r");
    const outcomes = await row(["SALES", "ACCOUNTANT", "ROUTE_ONLY", "FINALIZE_ONLY", "CANCEL_ONLY"], (role) =>
      cancelAs(s, applicationId, role)
    );
    expect(outcomes).toEqual({
      SALES: "REFUSED", ACCOUNTANT: "REFUSED", ROUTE_ONLY: "REFUSED", FINALIZE_ONLY: "REFUSED", CANCEL_ONLY: "REFUSED",
    });
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY"))).toBe("A manager cancels a finalized deal.");
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });

  test("CANCEL_CLOSED + CONFIRM cancels WITHOUT create:finance_application", async () => {
    const { s, applicationId } = await finalizedDeal("b2c");
    expect(s.actors.CANCEL_PLUS_CONFIRM.as).toBeDefined();
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_PLUS_CONFIRM"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });

  test("the default MANAGER cancels", async () => {
    const { s, applicationId } = await finalizedDeal("b2m");
    expect(await refusalOf(cancelAs(s, applicationId, "MANAGER"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });

  test("the owner cancels", async () => {
    const { s, applicationId } = await finalizedDeal("b2o");
    expect(await refusalOf(cancelAs(s, applicationId, "OWNER"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });
});

describe("SCRUM-413 PR-B D-b - cancelApplication, CLOSED v1, replay and non-CLOSED", () => {
  test("CLOSED v1: SALES, ROUTE_ONLY and FINALIZE_ONLY are refused; CANCEL_CLOSED alone cancels without CREATE", async () => {
    const { s, applicationId } = await finalizedDeal("b1", 1);
    const refused = await row(["SALES", "ACCOUNTANT", "ROUTE_ONLY", "FINALIZE_ONLY"], (role) =>
      cancelAs(s, applicationId, role)
    );
    expect(refused).toEqual({ SALES: "REFUSED", ACCOUNTANT: "REFUSED", ROUTE_ONLY: "REFUSED", FINALIZE_ONLY: "REFUSED" });
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");

    const key = crypto.randomUUID();
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY", key))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");

    // Certified cancel-replay rule: the matching replay is served ...
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY", key))).toBeNull();
    // ... a FRESH key on an already-CANCELLED application needs CREATE, which CANCEL_ONLY does not hold ...
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY"))).not.toBeNull();
    // ... a CREATE holder is still served the idempotent already-cancelled path ...
    expect(await refusalOf(cancelAs(s, applicationId, "SALES"))).toBeNull();
    // ... and a caller holding neither authority cannot ride the stored key.
    expect(await refusalOf(cancelAs(s, applicationId, "ACCOUNTANT", key))).not.toBeNull();
  });

  test("non-CLOSED keeps CREATE: a CREATE holder cancels, CANCEL_CLOSED alone cannot", async () => {
    const s = await seed("nc");
    const applicationId = await underReview(s);
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_PLUS_CONFIRM"))).not.toBeNull();
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY"))).not.toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("UNDER_REVIEW");
    expect(await refusalOf(cancelAs(s, applicationId, "SALES"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });
});

describe("SCRUM-413 PR-B D-c - sales.update cancel of a linked sale", () => {
  test("a v2 sale cancel is gated on CANCEL_CLOSED + CONFIRM, never FINALIZE", async () => {
    const { s, applicationId } = await finalizedDeal("c2");
    const saleId = (await s.t.run((ctx) => ctx.db.get(applicationId)))!.finalizedSaleId!;
    const attempt = (role: RoleKey) =>
      s.actors[role].as.mutation(api.sales.update, { orgId: s.orgId, saleId, status: "CANCELLED" });
    const gate = "A manager cancels a finalized deal.";
    const passes = /cancel this deal from the deal screen/;

    // Roles refused AT the manager gate.
    for (const role of ["SALES", "ACCOUNTANT", "ROUTE_ONLY", "FINALIZE_ONLY", "CANCEL_ONLY"] as RoleKey[]) {
      expect(await refusalOf(attempt(role)), role).toBe(gate);
    }
    // Roles that clear it reach the standing "cancel from the deal screen" refusal.
    for (const role of ["CANCEL_PLUS_CONFIRM", "MANAGER", "OWNER"] as RoleKey[]) {
      expect(await refusalOf(attempt(role)), role).toMatch(passes);
    }
  });
});

describe("SCRUM-413 PR-B D-d - the cockpit projection mirrors the door", () => {
  const mayCancel = async (s: Seeded, applicationId: Id<"financeApplications">, role: RoleKey) => {
    const cockpit = await s.actors[role].as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    return cockpit?.forward.mayCancelFinalized;
  };

  test("CLOSED v2: CANCEL_CLOSED + CONFIRM (no CREATE) is offered; FINALIZE-only, SALES, ROUTE-only are not", async () => {
    const { s, applicationId } = await finalizedDeal("d2");
    const out: Partial<Record<RoleKey, boolean | undefined>> = {};
    for (const role of ROLE_KEYS) out[role] = await mayCancel(s, applicationId, role);
    expect(out).toEqual({
      SALES: false, MANAGER: true, ACCOUNTANT: false, ROUTE_ONLY: false,
      CANCEL_ONLY: false, CANCEL_PLUS_CONFIRM: true, FINALIZE_ONLY: false, OWNER: true,
    });
  });

  test("CLOSED v1: CANCEL_CLOSED alone is offered, without CREATE or CONFIRM", async () => {
    const { s, applicationId } = await finalizedDeal("d1", 1);
    const out: Partial<Record<RoleKey, boolean | undefined>> = {};
    for (const role of ROLE_KEYS) out[role] = await mayCancel(s, applicationId, role);
    expect(out.CANCEL_ONLY).toBe(true);
    expect(out.CANCEL_PLUS_CONFIRM).toBe(true);
    expect(out.MANAGER).toBe(true);
    expect(out.OWNER).toBe(true);
    expect(out.FINALIZE_ONLY).toBe(false);
    expect(out.ROUTE_ONLY).toBe(false);
    expect(out.SALES).toBe(false);
  });

  test("non-CLOSED: CREATE is what offers the cancel", async () => {
    const s = await seed("dnc");
    const applicationId = await underReview(s);
    expect(await mayCancel(s, applicationId, "SALES")).toBe(true);
    expect(await mayCancel(s, applicationId, "CANCEL_ONLY")).toBe(false);
    expect(await mayCancel(s, applicationId, "OWNER")).toBe(true);
  });
});

describe("SCRUM-413 PR-B D-b - the entry gate and replay across actors (non-CLOSED)", () => {
  /** Every row a cancel could touch, as comparable JSON. */
  async function snapshot(s: Seeded, applicationId: Id<"financeApplications">) {
    return await s.t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      return JSON.stringify({
        application: app,
        vehicle: await ctx.db.get(s.vehicleId),
        quote: app?.quoteId ? await ctx.db.get(app.quoteId) : null,
        sales: await ctx.db.query("sales").collect(),
        deposits: await ctx.db.query("deposits").collect(),
        journalEntries: await ctx.db.query("journalEntries").collect(),
        idempotency: await ctx.db.query("commandIdempotency").collect(),
      });
    });
  }

  test("a CANCEL_CLOSED-only holder replaying a CREATE holder's key is served the stored outcome and changes nothing", async () => {
    const s = await seed("replay");
    const applicationId = await underReview(s);
    const key = crypto.randomUUID();

    // A CREATE holder cancels with key K.
    expect(await refusalOf(cancelAs(s, applicationId, "SALES", key))).toBeNull();
    const afterFirst = await snapshot(s, applicationId);
    expect(JSON.parse(afterFirst).application.status).toBe("CANCELLED");

    // A CANCEL_CLOSED-only holder (no CREATE) replays K with the same args.
    const replay = await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY", key));
    expect(replay).toBeNull();
    // Served from the stored record: no new mutation of any kind, not even a new record.
    expect(await snapshot(s, applicationId)).toBe(afterFirst);
  });

  test("the same CANCEL_CLOSED-only holder with a FRESH key on a non-CLOSED application is refused and nothing changes", async () => {
    const s = await seed("fresh");
    const applicationId = await underReview(s);
    const before = await snapshot(s, applicationId);

    const refusal = await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY"));
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/create:finance_application/);
    expect(await snapshot(s, applicationId)).toBe(before);
    expect(JSON.parse(before).application.status).toBe("UNDER_REVIEW");
  });
});

/**
 * SCRUM-413 PR-B D-37 (Codex F-01): the cockpit offers Cancel on a CLOSED deal
 * only when `cancelApplication` would accept a fresh command on the SAME
 * snapshot - the forward gate included. Each scenario reads the projection,
 * then issues a fresh cancel as the same actor; the two must agree, and a
 * refusal must write nothing.
 */
describe("SCRUM-413 PR-B D-37 - the cockpit's cancel offer equals what a fresh cancel does, forward gate included", () => {
  const FORWARD = H + C;
  const record = (s: Seeded, applicationId: Id<"financeApplications">) =>
    s.actors.OWNER.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER", paidAt: Date.now(),
      expectedAmountMinor: FORWARD, idempotencyKey: crypto.randomUUID(),
    });
  const reverse = (s: Seeded, applicationId: Id<"financeApplications">, forwardId: Id<"financeCompanyForwards">) =>
    s.actors.OWNER.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
      orgId: s.orgId, applicationId, forwardId, reason: "Recorded in error.", idempotencyKey: crypto.randomUUID(),
    });
  const reportReturned = (s: Seeded, applicationId: Id<"financeApplications">, forwardId: Id<"financeCompanyForwards">) =>
    s.actors.OWNER.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
      orgId: s.orgId, applicationId, forwardId, reason: "The company sent it back.", idempotencyKey: crypto.randomUUID(),
    });
  const patchOriginalEvent = (s: Seeded, patch: Record<string, unknown>) =>
    s.t.run(async (ctx) => {
      const original = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).find(
        (e) => e.eventType === "FINANCE_COMPANY_FORWARD_PAID"
      )!;
      await ctx.db.patch(original._id, patch as never);
    });

  /** Rows a cancel could touch, as comparable JSON. */
  const snapshot = (s: Seeded, applicationId: Id<"financeApplications">) =>
    s.t.run(async (ctx) =>
      JSON.stringify({
        application: await ctx.db.get(applicationId),
        forwards: await ctx.db.query("financeCompanyForwards").collect(),
        events: await ctx.db.query("accountingEvents").collect(),
        pending: await ctx.db.query("pendingAccountingEvents").collect(),
        journalEntries: await ctx.db.query("journalEntries").collect(),
        sales: await ctx.db.query("sales").collect(),
        vehicle: await ctx.db.get(s.vehicleId),
      })
    );

  const SCENARIOS: Array<{
    name: string; expected: boolean; version?: 1 | 2;
    arrange: (s: Seeded, applicationId: Id<"financeApplications">) => Promise<void>;
  }> = [
    { name: "DUE (nothing paid yet)", expected: true, arrange: async () => {} },
    { name: "v1 deal (the forward gate does not apply)", expected: true, version: 1, arrange: async () => {} },
    { name: "ON_BOOKS", expected: false, arrange: async (s, a) => { await record(s, a); } },
    {
      name: "POSTING_PENDING", expected: false,
      arrange: async (s, a) => { await record(s, a); await patchOriginalEvent(s, { status: "PENDING" }); },
    },
    {
      name: "POSTING_FAILED", expected: false,
      arrange: async (s, a) => { await record(s, a); await patchOriginalEvent(s, { status: "FAILED" }); },
    },
    {
      name: "REVERSAL_PENDING", expected: false,
      arrange: async (s, a) => {
        const forwardId = await record(s, a);
        await s.t.run(async (ctx) => {
          const row = (await ctx.db.get(forwardId))!;
          const key = `finance_company_forward_reversal_${row.applicationId}_v${row.version}`;
          await ctx.db.patch(forwardId, {
            reversalRequestedAt: Date.now(), reversalKind: "VOID", reverseReason: "x", reversalIdempotencyKey: key,
          });
          await ctx.db.insert("pendingAccountingEvents", {
            orgId: s.orgId, kind: "REVERSE", status: "PENDING", idempotencyKey: key, accountingDate: Date.now(),
            actorId: row.actorId, attempts: 0, createdAt: Date.now(), sourceType: "FINANCE_COMPANY_FORWARD", sourceId: String(row._id),
          } as never);
        });
      },
    },
    {
      name: "completed RETURNED (reported, reversal posted)", expected: true,
      arrange: async (s, a) => { await reportReturned(s, a, await record(s, a)); },
    },
    {
      name: "completed REVERSED (voided before the transfer)", expected: true,
      arrange: async (s, a) => { await reverse(s, a, await record(s, a)); },
    },
    {
      name: "NEEDS_REPAIR (reversed but the reversal link is missing)", expected: false,
      arrange: async (s, a) => {
        await reverse(s, a, await record(s, a));
        await patchOriginalEvent(s, { reversedByEventId: undefined });
      },
    },
    {
      name: "over-limit (more versions than the proof reads) fails CLOSED", expected: false,
      arrange: async (s, a) => {
        const forwardId = await record(s, a);
        await s.t.run(async (ctx) => {
          const { _id, _creationTime, ...row } = (await ctx.db.get(forwardId))!;
          void _id; void _creationTime;
          for (let version = row.version + 1; version <= row.version + 10; version += 1) {
            await ctx.db.insert("financeCompanyForwards", { ...row, version });
          }
        });
      },
    },
  ];

  for (const scenario of SCENARIOS) {
    test(`${scenario.name}: the offer equals a fresh cancel, and a refusal writes nothing`, async () => {
      const s = await seed(`par_${scenario.name.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`);
      const { applicationId } = await readyDeal(s);
      await finalizeAsOwner(s, applicationId);
      if (scenario.version === 1) await downgradeToV1(s, applicationId);
      await scenario.arrange(s, applicationId);

      for (const role of ["MANAGER", "OWNER"] as RoleKey[]) {
        const cockpit = await s.actors[role].as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
        const offered = cockpit?.forward.mayCancelFinalized;
        const before = await snapshot(s, applicationId);
        const refusal = await refusalOf(cancelAs(s, applicationId, role));
        expect(offered, `${role}: offered=${offered}, refusal=${refusal}`).toBe(refusal === null);
        expect(offered, role).toBe(scenario.expected);
        if (refusal !== null) {
          expect(await snapshot(s, applicationId), `${role}: a refusal must write nothing`).toBe(before);
        } else {
          break; // the deal is cancelled; the second actor has nothing left to compare
        }
      }
    });
  }
});