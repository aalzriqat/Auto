import { describe, it, expect, vi, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { requireTenantAuth, requireAuth, requireSuperAdmin, requireSupportAgent } from "./tenancy";
import * as envModule from "./env";

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

      const ctx = createMockCtx(mockIdentity, {
        get: { "org1": { _id: "org1" }, "r1": mockRole },
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
      const t = convexTest(schema, import.meta.glob("./../**/*.*s"));
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
