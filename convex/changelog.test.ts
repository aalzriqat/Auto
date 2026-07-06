import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

const ORIGINAL_SUPER_ADMIN_EMAILS = process.env.SUPER_ADMIN_EMAILS;
const ORIGINAL_CLERK_JWT_ISSUER_DOMAIN = process.env.CLERK_JWT_ISSUER_DOMAIN;
const ORIGINAL_NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

function restoreEnv(key: keyof NodeJS.ProcessEnv, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  process.env.CLERK_JWT_ISSUER_DOMAIN = "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL = "https://test.example.com";
});

afterEach(() => {
  restoreEnv("SUPER_ADMIN_EMAILS", ORIGINAL_SUPER_ADMIN_EMAILS);
  restoreEnv("CLERK_JWT_ISSUER_DOMAIN", ORIGINAL_CLERK_JWT_ISSUER_DOMAIN);
  restoreEnv("NEXT_PUBLIC_APP_URL", ORIGINAL_NEXT_PUBLIC_APP_URL);
});

async function seedUser(t: ReturnType<typeof convexTest>, clerkId: string, email: string) {
  await t.run((ctx) => ctx.db.insert("users", { clerkId, email, name: email }));
  return t.withIdentity({ subject: clerkId });
}

describe("changelog historical seed", () => {
  test("backfills the full customer-facing history without duplicating entries", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = await seedUser(t, "admin_changelog", "admin@autoflow.dev");

    const firstRun = await asAdmin.mutation(api.changelog.seedHistoricalEntries, {});

    expect(firstRun.total).toBeGreaterThan(50);
    expect(firstRun.inserted).toBe(firstRun.total);
    expect(firstRun.skipped).toBe(0);

    const secondRun = await asAdmin.mutation(api.changelog.seedHistoricalEntries, {});

    expect(secondRun.inserted).toBe(0);
    expect(secondRun.skipped).toBe(firstRun.total);

    const page = await asAdmin.query(api.changelog.list, {
      paginationOpts: { numItems: firstRun.total, cursor: null },
    });

    expect(page.page).toHaveLength(firstRun.total);

    const publishedAts = page.page.map((entry) => entry.publishedAt);
    for (const [index, publishedAt] of publishedAts.entries()) {
      if (index === 0) continue;
      expect(publishedAts[index - 1]).toBeGreaterThanOrEqual(publishedAt);
    }
  });

  test("requires super-admin access", async () => {
    const t = convexTest(schema, modules);
    const asMember = await seedUser(t, "member_changelog", "member@autoflow.dev");

    await expect(asMember.mutation(api.changelog.seedHistoricalEntries, {})).rejects.toThrow();
  });
});

describe("changelog createInternal (CLI automation, no live session)", () => {
  test("attributes the entry to the resolved SUPER_ADMIN_EMAILS user", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "admin_cli", email: "admin@autoflow.dev", name: "Admin" })
    );

    const entryId = await t.mutation(internal.changelog.createInternal, {
      type: "FEATURE",
      titleEn: "Test feature",
      titleAr: "ميزة تجريبية",
      descriptionEn: "Test description",
      descriptionAr: "وصف تجريبي",
    });

    const entry = await t.run((ctx) => ctx.db.get(entryId));
    const admin = await t.run((ctx) =>
      ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", "admin@autoflow.dev")).unique()
    );

    expect(entry?.createdBy).toEqual(admin?._id);
    expect(entry?.titleEn).toBe("Test feature");
  });

  test("throws when SUPER_ADMIN_EMAILS is not set", async () => {
    const t = convexTest(schema, modules);
    delete process.env.SUPER_ADMIN_EMAILS;

    await expect(
      t.mutation(internal.changelog.createInternal, {
        type: "FIX",
        titleEn: "x",
        titleAr: "x",
        descriptionEn: "x",
        descriptionAr: "x",
      })
    ).rejects.toThrow();
  });

  test("throws when no user matches the configured super-admin email", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(internal.changelog.createInternal, {
        type: "IMPROVEMENT",
        titleEn: "x",
        titleAr: "x",
        descriptionEn: "x",
        descriptionAr: "x",
      })
    ).rejects.toThrow();
  });
});
