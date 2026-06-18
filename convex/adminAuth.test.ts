import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev, Other@Admin.com";
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

async function seedUser(t: ReturnType<typeof convexTest>, clerkId: string, email: string) {
  await t.run(async (ctx) => ctx.db.insert("users", { clerkId, email }));
  return t.withIdentity({ subject: clerkId });
}

describe("adminAuth.isSuperAdmin", () => {
  test("returns false for an unauthenticated caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    expect(await t.query(api.adminAuth.isSuperAdmin, {})).toBe(false);
  });

  test("returns false for an authenticated user not on the allowlist", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asMember = await seedUser(t, "user_1", "member@dealership.com");
    expect(await asMember.query(api.adminAuth.isSuperAdmin, {})).toBe(false);
  });

  test("returns true for an allowlisted email, matched case-insensitively", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asAdmin = await seedUser(t, "user_2", "OTHER@admin.com");
    expect(await asAdmin.query(api.adminAuth.isSuperAdmin, {})).toBe(true);
  });
});
