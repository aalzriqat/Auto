import { describe, it, expect, vi } from "vitest";
import { requireTenantAuth, requireAuth } from "./tenancy";

// Helper to create a mock Context for testing
function createMockCtx(identity: any = null, dbReturns: any = {}) {
  return {
    auth: {
      getUserIdentity: vi.fn().mockResolvedValue(identity),
    },
    db: {
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
    },
  } as any;
}

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
  });
});
