import { describe, it, expect, vi, beforeEach } from "vitest";
import { convexTestWithComponents } from "../../test-utils/convexTest";
import schema from "../schema";
import { requireTenantAuth, requireAuth, requireSuperAdmin, requireSupportAgent } from "./tenancy";
import * as envModule from "./env";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// getValidatedEnv reads process.env at call time inside a module transformed
// separately from this test file, and mutating process.env directly here
// does not reliably propagate to it under this project's vitest/esbuild
// pipeline — mocking the module's return value instead is deterministic.
vi.mock("./env", () => ({
  getValidatedEnv: vi.fn(() => ({ SUPER_ADMIN_EMAILS: undefined })),
}));

// Helper to create a mock Context for testing
function createMockCtx(identity: any = null, dbReturns: any = {}, opts: { asMutationCtx?: boolean } = {}) {
  const db: any = {
    get: vi.fn().mockImplementation((id) => {
      if (dbReturns.get && dbReturns.get[id]) return Promise.resolve(dbReturns.get[id]);
      return Promise.resolve(null);
    }),
    query: vi.fn().mockReturnValue({
      withIndex: vi.fn().mockReturnThis(),
      filter: vi.fn().mockReturnThis(),
      unique: vi.fn().mockImplementation(() => Promise.resolve(dbReturns.unique || null)),
      collect: vi.fn().mockImplementation(() => Promise.resolve(dbReturns.collect || [])),
    }),
  };
  if (opts.asMutationCtx) {
    db.insert = vi.fn().mockResolvedValue("audit1");
  }
  return {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue(identity),
    },
    db,
  } as any;
}

beforeEach(() => {
  vi.mocked(envModule.getValidatedEnv).mockReturnValue({ SUPER_ADMIN_EMAILS: undefined } as any);
});

describe("Tenancy Utilities", () => {
  describe("requireAuth", () => {
    it("throws if user is not authenticated", async () => {
      const ctx = createMockCtx(null);
      await expect(requireAuth(ctx)).rejects.toThrow(/Unauthenticated/);
    });

    it("throws if user is authenticated but not in database", async () => {
      const ctx = createMockCtx({ subject: "user_123" }, { unique: null });
      await expect(requireAuth(ctx)).rejects.toThrow(/User not found in the database/);
    });

    it("returns user if authenticated and in database", async () => {
      const mockUser = { _id: "u1", clerkId: "user_123" };
      const ctx = createMockCtx({ subject: "user_123" }, { unique: mockUser });
      const result = await requireAuth(ctx);
      expect(result).toEqual(mockUser);
    });
  });

  describe("requireTenantAuth", () => {
    const mockIdentity = { subject: "user_123" };
    const mockUser = { _id: "u1", clerkId: "user_123" };
    const mockOrgId = "org1";

    it("throws if organization does not exist", async () => {
      const ctx = createMockCtx(mockIdentity, {
        unique: mockUser, // for requireAuth
        get: { "org1": null }, // org not found
      });
      await expect(requireTenantAuth(ctx, mockOrgId as any)).rejects.toThrow(/Organization not found/);
    });

    it("throws if user is not a member of the organization", async () => {
      // The second call to query().unique() is for membership
      const ctx = createMockCtx(mockIdentity, {
        get: { "org1": { _id: "org1" } },
      });
      // Mock requireAuth to succeed, but membership to fail
      ctx.db.query = vi.fn()
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockUser) }) }) // user
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(null) }) }); // membership

      await expect(requireTenantAuth(ctx, mockOrgId as any)).rejects.toThrow(/not a member/);
    });

    it("throws if user lacks required permissions", async () => {
      const mockMembership = { _id: "m1", orgId: "org1", userId: "u1", roleId: "r1" };
      const mockRole = { _id: "r1", name: "SALES", permissions: ["view:vehicles"] };

      const ctx = createMockCtx(mockIdentity, {
        get: { "org1": { _id: "org1" }, "r1": mockRole },
      });

      ctx.db.query = vi.fn()
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockUser) }) }) // user
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockMembership) }) }); // membership

      await expect(requireTenantAuth(ctx, mockOrgId as any, ["edit:vehicles"] as any)).rejects.toThrow(/Forbidden: Missing required permissions/);
    });

    it("succeeds if user is a member and has permissions", async () => {
      const mockMembership = { _id: "m1", orgId: "org1", userId: "u1", roleId: "r1" };
      const mockRole = { _id: "r1", name: "SALES", permissions: ["view:vehicles", "edit:vehicles"] };

      const ctx = createMockCtx(mockIdentity, {
        get: { "org1": { _id: "org1" }, "r1": mockRole },
      });

      ctx.db.query = vi.fn()
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockUser) }) }) // user
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockMembership) }) }); // membership

      const result = await requireTenantAuth(ctx, mockOrgId as any, ["edit:vehicles"] as any);
      expect(result.user).toEqual(mockUser);
      expect(result.membership).toEqual(mockMembership);
      expect(result.role).toEqual(mockRole);
    });

    it("does not treat a display-name-only OWNER role as an owner", async () => {
      const mockMembership = { _id: "m1", orgId: "org1", userId: "u1", roleId: "r1" };
      const mockRole = { _id: "r1", name: "OWNER", permissions: [] };

      const ctx = createMockCtx(mockIdentity, {
        get: { "org1": { _id: "org1" }, "r1": mockRole },
      });

      ctx.db.query = vi.fn()
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockUser) }) })
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockMembership) }) });

      await expect(requireTenantAuth(ctx, mockOrgId as any, ["edit:vehicles"] as any)).rejects.toThrow(/Forbidden: Missing required permissions/);
    });

    it("allows the flagged system owner role to satisfy permission checks", async () => {
      const mockMembership = { _id: "m1", orgId: "org1", userId: "u1", roleId: "r1" };
      const mockRole = { _id: "r1", name: "OWNER", permissions: [], isSystemOwnerRole: true };

      const ctx = createMockCtx(mockIdentity, {
        get: { "org1": { _id: "org1" }, "r1": mockRole },
      });

      ctx.db.query = vi.fn()
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockUser) }) })
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockMembership) }) });

      const result = await requireTenantAuth(ctx, mockOrgId as any, ["edit:vehicles"] as any);
      expect(result.role).toEqual(mockRole);
    });

    it("throws if the membership's role is not found or corrupted", async () => {
      const mockMembership = { _id: "m1", orgId: "org1", userId: "u1", roleId: "r1" };

      const ctx = createMockCtx(mockIdentity, {
        get: { "org1": { _id: "org1" } }, // "r1" intentionally missing
      });

      ctx.db.query = vi.fn()
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockUser) }) })
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockMembership) }) });

      await expect(requireTenantAuth(ctx, mockOrgId as any)).rejects.toThrow(/Membership role not found or corrupted/);
    });

    it("audit-logs an impersonated write even when no specific permissions are required", async () => {
      const mockMembership = {
        _id: "m1",
        orgId: "org1",
        userId: "u1",
        roleId: "r1",
        impersonationGrantId: "grant1",
      };
      const mockRole = { _id: "r1", name: "SALES", permissions: [] };
      const liveGrant = { _id: "grant1", expiresAt: Date.now() + 60_000 };

      const ctx = createMockCtx(mockIdentity, {
        get: { "org1": { _id: "org1" }, "r1": mockRole, "grant1": liveGrant },
      }, { asMutationCtx: true });

      ctx.db.query = vi.fn()
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockUser) }) })
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockMembership) }) });

      const result = await requireTenantAuth(ctx, mockOrgId as any);
      expect(result.membership).toEqual(mockMembership);
      expect(ctx.db.insert).toHaveBeenCalledWith(
        "adminAuditLog",
        expect.objectContaining({ action: "impersonated-write:tenant-write" })
      );
    });

    it.each([
      ["expired", { _id: "grant1", expiresAt: Date.now() - 1 }],
      ["revoked", { _id: "grant1", expiresAt: Date.now() + 60_000, revokedAt: Date.now() - 1 }],
      ["deleted", undefined],
    ])("rejects an impersonated session whose grant is %s", async (_label, grant) => {
      // Expiry used to rest entirely on a fire-and-forget scheduled cleanup
      // with no retry, so a missed run left cross-tenant access live forever.
      // The grant itself is the authority now.
      const mockMembership = {
        _id: "m1", orgId: "org1", userId: "u1", roleId: "r1", impersonationGrantId: "grant1",
      };
      const mockRole = { _id: "r1", name: "SALES", permissions: [] };

      const ctx = createMockCtx(mockIdentity, {
        get: { "org1": { _id: "org1" }, "r1": mockRole, ...(grant ? { "grant1": grant } : {}) },
      }, { asMutationCtx: true });

      ctx.db.query = vi.fn()
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockUser) }) })
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockMembership) }) });

      await expect(requireTenantAuth(ctx, mockOrgId as any)).rejects.toThrow(
        /impersonation session has ended/i
      );
    });
  });

  describe("requireSuperAdmin", () => {
    it("throws forbidden when the allowlist env var isn't set", async () => {
      vi.mocked(envModule.getValidatedEnv).mockReturnValue({ SUPER_ADMIN_EMAILS: undefined } as any);
      const mockUser = { _id: "u1", clerkId: "user_123", email: "anyone@example.com" };
      const ctx = createMockCtx({ subject: "user_123" }, { unique: mockUser });

      await expect(requireSuperAdmin(ctx)).rejects.toThrow(/Super-admin access only/);
    });

    it("succeeds for an email on the allowlist", async () => {
      vi.mocked(envModule.getValidatedEnv).mockReturnValue({
        SUPER_ADMIN_EMAILS: "Admin@Example.com, other@example.com",
      } as any);
      const mockUser = { _id: "u1", clerkId: "user_123", email: "admin@example.com" };
      const ctx = createMockCtx({ subject: "user_123" }, { unique: mockUser });

      const result = await requireSuperAdmin(ctx);
      expect(result).toEqual(mockUser);
    });
  });

  describe("requireSupportAgent", () => {
    it("throws if the user has no support-agent row", async () => {
      const mockUser = { _id: "u1", clerkId: "user_123", email: "u@example.com" };
      const ctx = createMockCtx({ subject: "user_123" }, { unique: mockUser });

      ctx.db.query = vi.fn()
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockUser) }) }) // requireAuth
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(null) }) }); // supportAgents

      await expect(requireSupportAgent(ctx)).rejects.toThrow(/Support-agent access only/);
    });

    it("throws if the support-agent row exists but is inactive", async () => {
      const mockUser = { _id: "u1", clerkId: "user_123", email: "u@example.com" };
      const mockAgent = { _id: "a1", userId: "u1", isActive: false };
      const ctx = createMockCtx({ subject: "user_123" }, { unique: mockUser });

      ctx.db.query = vi.fn()
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockUser) }) })
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockAgent) }) });

      await expect(requireSupportAgent(ctx)).rejects.toThrow(/Support-agent access only/);
    });

    it("succeeds for an active support agent", async () => {
      const mockUser = { _id: "u1", clerkId: "user_123", email: "u@example.com" };
      const mockAgent = { _id: "a1", userId: "u1", isActive: true };
      const ctx = createMockCtx({ subject: "user_123" }, { unique: mockUser });

      ctx.db.query = vi.fn()
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockUser) }) })
        .mockReturnValueOnce({ withIndex: () => ({ unique: () => Promise.resolve(mockAgent) }) });

      const result = await requireSupportAgent(ctx);
      expect(result.user).toEqual(mockUser);
      expect(result.agent).toEqual(mockAgent);
    });

    it("succeeds for an active support agent against a real Convex query (not a mocked ctx.db)", async () => {
      // The hand-mocked ctx.db above never actually invokes the .withIndex()
      // callback it's handed, so that arrow function stays uncovered — use a
      // real convex-test backend here instead, with just ctx.auth swapped
      // out for a fixed identity.
      const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
      const userId = await t.run((ctx) =>
        ctx.db.insert("users", { clerkId: "support_1", email: "support@test.com" })
      );
      await t.run((ctx) => ctx.db.insert("supportAgents", { userId, email: "support@test.com", isActive: true }));

      const result = await t.run((ctx) =>
        requireSupportAgent({
          ...ctx,
          auth: { ...ctx.auth, getUserIdentity: async () => ({ subject: "support_1" }) as any },
        } as any)
      );
      expect(result.agent.isActive).toBe(true);
    });
  });
});

it("tenant auth preserves literal stored permissions across names cardinalities and system owner", async () => {
  expect.assertions(72);
  const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
  const { orgId, userId } = await t.run(async ctx => ({
    orgId: await ctx.db.insert("organizations", { name: "Permission snapshot contract", createdAt: 1 }),
    userId: await ctx.db.insert("users", { clerkId: "permission-snapshot", email: "permission-snapshot@example.test" }),
  }));
  // Independent literal snapshots of the legacy owner set. Neither is imported
  // from production or computed from the permissions returned by the guard.
  const fullStored = [
    "view:org", "edit:org", "view:users", "manage:users", "manage:roles",
    "view:vehicles", "create:vehicles", "create:vehicles:request", "edit:vehicles", "edit:vehicles:request",
    "delete:vehicles", "view:vehicle_info", "view:vehicle_leads", "view:vehicle_expenses", "view:vehicle_tasks",
    "view:vehicle_test_drives", "view:vehicle_work_orders", "view:vehicle_valuations", "edit:vehicle_valuations",
    "view:customers", "create:customers", "create:customers:request", "edit:customers", "edit:customers:request",
    "delete:customers", "view:leads", "create:leads", "create:leads:request", "edit:leads", "edit:leads:request",
    "delete:leads", "view:sales", "create:sales", "create:sales:request", "edit:sales", "edit:sales:request",
    "delete:sales", "view:expenses", "create:expenses", "create:expenses:request", "edit:expenses",
    "edit:expenses:request", "delete:expenses", "view:tasks", "create:tasks", "edit:tasks", "delete:tasks",
    "view:reports", "view:settings", "manage:settings", "website.view", "website.manage", "website.publish",
    "website.domain.manage", "website.leads.manage", "website.analytics.view", "view:finance", "manage:finance",
    "reopen:accounting_periods", "view:cost_price", "view:commissions", "manage:commissions", "view:payroll",
    "manage:payroll", "approve:requests", "view:finance_applications", "create:finance_application",
    "review:finance_application", "approve:finance_application", "finalize:financed_deal",
    "confirm:finance_disbursement", "verify:finance_documents", "register:vehicle_handover",
    "register:expected_payment", "marketplace:settings", "marketplace:respond", "marketplace:analytics",
  ];
  const fullExpected = [
    "view:org", "edit:org", "view:users", "manage:users", "manage:roles",
    "view:vehicles", "create:vehicles", "create:vehicles:request", "edit:vehicles", "edit:vehicles:request",
    "delete:vehicles", "view:vehicle_info", "view:vehicle_leads", "view:vehicle_expenses", "view:vehicle_tasks",
    "view:vehicle_test_drives", "view:vehicle_work_orders", "view:vehicle_valuations", "edit:vehicle_valuations",
    "view:customers", "create:customers", "create:customers:request", "edit:customers", "edit:customers:request",
    "delete:customers", "view:leads", "create:leads", "create:leads:request", "edit:leads", "edit:leads:request",
    "delete:leads", "view:sales", "create:sales", "create:sales:request", "edit:sales", "edit:sales:request",
    "delete:sales", "view:expenses", "create:expenses", "create:expenses:request", "edit:expenses",
    "edit:expenses:request", "delete:expenses", "view:tasks", "create:tasks", "edit:tasks", "delete:tasks",
    "view:reports", "view:settings", "manage:settings", "website.view", "website.manage", "website.publish",
    "website.domain.manage", "website.leads.manage", "website.analytics.view", "view:finance", "manage:finance",
    "reopen:accounting_periods", "view:cost_price", "view:commissions", "manage:commissions", "view:payroll",
    "manage:payroll", "approve:requests", "view:finance_applications", "create:finance_application",
    "review:finance_application", "approve:finance_application", "finalize:financed_deal",
    "confirm:finance_disbursement", "verify:finance_documents", "register:vehicle_handover",
    "register:expected_payment", "marketplace:settings", "marketplace:respond", "marketplace:analytics",
  ];
  type AuthCell = {
    label: string; name: string; owner?: boolean; deleted?: boolean; stored: string[]; expected: string[];
    grant?: "read" | "write"; required?: Parameters<typeof requireTenantAuth>[2];
  };
  const cases: readonly (Omit<AuthCell, "label"> & { label?: string })[] = [
    { name: "Custom", owner: false, stored: [], expected: [] },
    { name: "Limited reviewer", owner: false, stored: [], expected: [] },
    { name: "Custom", owner: false, stored: ["view:finance", "view:cost_price"], expected: ["view:finance", "view:cost_price"] },
    { name: "Limited reviewer", owner: false, stored: ["view:finance", "view:cost_price"], expected: ["view:finance", "view:cost_price"] },
    { name: "Custom", owner: false, stored: ["view:finance", "view:cost_price", "view:vehicles", "view:expenses", "view:customers"], expected: ["view:finance", "view:cost_price", "view:vehicles", "view:expenses", "view:customers"] },
    { name: "Limited reviewer", owner: false, stored: ["view:finance", "view:cost_price", "view:vehicles", "view:expenses", "view:customers"], expected: ["view:finance", "view:cost_price", "view:vehicles", "view:expenses", "view:customers"] },
    { name: "Custom", owner: false, stored: ["view:finance", "view:cost_price", "view:vehicles", "view:sales", "view:expenses", "view:customers"], expected: ["view:finance", "view:cost_price", "view:vehicles", "view:sales", "view:expenses", "view:customers"] },
    { name: "Limited reviewer", owner: false, stored: ["view:finance", "view:cost_price", "view:vehicles", "view:sales", "view:expenses", "view:customers"], expected: ["view:finance", "view:cost_price", "view:vehicles", "view:sales", "view:expenses", "view:customers"] },
    { name: "OWNER", owner: true, stored: [], expected: [] },
    { name: "OWNER", owner: true, stored: ["view:finance"], expected: ["view:finance"] },
    { label: "deleted-custom", name: "Custom", owner: false, deleted: true, stored: ["view:finance", "view:cost_price"], expected: ["view:finance", "view:cost_price"] },
    { label: "deleted-owner", name: "OWNER", owner: true, deleted: true, stored: [], expected: [], required: [] },
    { label: "owner-false-full", name: "OWNER", owner: false, stored: fullStored, expected: fullExpected },
    { label: "owner-false-short", name: "OWNER", owner: false, stored: ["view:finance", "view:cost_price"], expected: ["view:finance", "view:cost_price"] },
    { label: "owner-missing-full", name: "OWNER", stored: fullStored, expected: fullExpected },
    { label: "owner-missing-short", name: "OWNER", stored: ["view:finance", "view:cost_price"], expected: ["view:finance", "view:cost_price"] },
    { label: "non-owner-missing-full", name: "Limited reviewer", stored: fullStored, expected: fullExpected },
    { label: "renamed-flagged-owner", name: "Limited reviewer", owner: true, stored: [], expected: [] },
    { label: "explicit-live-role", name: "Custom", owner: false, deleted: false, stored: ["view:finance", "view:cost_price"], expected: ["view:finance", "view:cost_price"] },
    { label: "owner-duplicate-missing-member", name: "OWNER", stored: ["view:org", ...fullStored.slice(0, -1)], expected: ["view:org", ...fullExpected.slice(0, -1)] },
    { label: "live-grant-write-empty", name: "Limited reviewer", owner: false, grant: "write", stored: ["view:finance", "view:cost_price"], expected: ["view:finance", "view:cost_price"], required: [] },
    { label: "live-grant-write-permissions", name: "Limited reviewer", owner: false, grant: "write", stored: ["view:finance", "view:cost_price"], expected: ["view:finance", "view:cost_price"] },
    { label: "live-grant-read-empty", name: "Limited reviewer", owner: false, grant: "read", stored: ["view:finance", "view:cost_price"], expected: ["view:finance", "view:cost_price"], required: [] },
    { label: "live-grant-read-permissions", name: "Limited reviewer", owner: false, grant: "read", stored: ["view:finance", "view:cost_price"], expected: ["view:finance", "view:cost_price"] },
  ];
  for (const cell of cases) {
    const { membershipId, roleId } = await t.run(async ctx => {
      const roleId = await ctx.db.insert("roles", { orgId, name: cell.name, permissions: cell.stored, isSystemOwnerRole: cell.owner, isDeleted: cell.deleted });
      const id = await ctx.db.insert("memberships", { orgId, userId, roleId });
      if (cell.grant) {
        const targetUserId = await ctx.db.insert("users", { clerkId: "target-" + cell.label, email: "target@example.test" });
        await ctx.db.insert("memberships", { orgId, userId: targetUserId, roleId });
        const grantId = await ctx.db.insert("impersonationGrants", { orgId, membershipId: id, actorUserId: userId, targetUserId,
          reason: "Synthetic permission contract", grantedAt: Date.now(), expiresAt: Date.now() + 60_000 });
        await ctx.db.patch(id, { impersonationGrantId: grantId });
      }
      return { membershipId: id, roleId };
    });
    try {
      const required: Parameters<typeof requireTenantAuth>[2] = cell.required ?? (cell.owner || cell.stored.length > 0 ? ["view:finance", "view:cost_price"] : []);
      const { role } = await t.withIdentity({ subject: "permission-snapshot" }).run(ctx => {
        const readContext: QueryCtx = { ...ctx, db: { get: ctx.db.get, query: ctx.db.query, normalizeId: ctx.db.normalizeId, system: ctx.db.system } };
        return requireTenantAuth(cell.grant === "read" ? readContext : ctx, orgId, required);
      });
      expect(role.permissions, cell.label ?? cell.name + "/" + cell.stored.length + "/owner=" + cell.owner).toStrictEqual(cell.expected);
      expect(role._id, "auth must return the caller's own stored role").toBe(roleId);
      const stored = await t.run(ctx => ctx.db.get(role._id));
      expect(stored?.permissions, "auth must not persist a widened role").toStrictEqual(cell.expected);
    } finally { await t.run(ctx => ctx.db.delete(membershipId)); }
  }
});

type AuthRefusalState = "disabled-user" | "suspended-org" | "offboarded-member" | "missing-grant" | "revoked-grant" | "expired-grant" | "expiry-boundary";
async function seedAuthRefusal(state: AuthRefusalState) {
  const t = convexTestWithComponents(schema, import.meta.glob("./../**/*.*s"));
  const orgId = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic auth refusal", createdAt: 1, suspended: state === "suspended-org" });
    const userId = await ctx.db.insert("users", { clerkId: "auth-refusal", email: "auth-refusal@example.test", disabled: state === "disabled-user" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "Limited reviewer", permissions: ["view:finance"], isSystemOwnerRole: false });
    const membership: Omit<Doc<"memberships">, "_id" | "_creationTime"> = { orgId, userId, roleId };
    if (state === "offboarded-member") membership.offboardingStatus = "PENDING_EXTERNAL_REMOVAL";
    const membershipId = await ctx.db.insert("memberships", membership);
    const targetUserId = await ctx.db.insert("users", { clerkId: "auth-refusal-target", email: "target@example.test" });
    await ctx.db.insert("memberships", { orgId, userId: targetUserId, roleId });
    const expiresAt = state === "expired-grant" ? 999 : 2000;
    const grantId = await ctx.db.insert("impersonationGrants", {
      orgId, membershipId, actorUserId: userId, targetUserId, reason: "Synthetic refusal contract", grantedAt: 1,
      expiresAt: state === "expiry-boundary" ? 1000 : expiresAt,
      revokedAt: state === "revoked-grant" ? 900 : undefined,
    });
    await ctx.db.patch(membershipId, { impersonationGrantId: grantId });
    if (state === "missing-grant") await ctx.db.delete(grantId);
    return orgId;
  });
  return { t, orgId };
}

it("tenant auth refuses inactive callers memberships and ended impersonation grants before returning a role", async () => {
  expect.assertions(7);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  try {
    const cases: readonly { state: AuthRefusalState; error: RegExp }[] = [
      { state: "disabled-user", error: /account has been disabled/ },
      { state: "suspended-org", error: /organization has been suspended/ },
      { state: "offboarded-member", error: /membership is no longer active/ },
      { state: "missing-grant", error: /impersonation session has ended/ },
      { state: "revoked-grant", error: /impersonation session has ended/ },
      { state: "expired-grant", error: /impersonation session has ended/ },
      { state: "expiry-boundary", error: /impersonation session has ended/ },
    ];
    for (const cell of cases) {
      const { t, orgId } = await seedAuthRefusal(cell.state);
      await expect(t.withIdentity({ subject: "auth-refusal" }).run(ctx => requireTenantAuth(ctx, orgId, ["view:finance"])), cell.state).rejects.toThrow(cell.error);
    }
  } finally { vi.useRealTimers(); }
});
