import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;
beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
});
afterEach(() => {
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.SUPER_ADMIN_EMAILS;
  else process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

async function asSuperAdmin(t: ReturnType<typeof convexTest>) {
  await t.run((ctx) => ctx.db.insert("users", { clerkId: "admin", email: "admin@autoflow.dev", name: "Admin" }));
  return t.withIdentity({ subject: "admin" });
}

const baseRelease = {
  platform: "ANDROID" as const,
  buildNumber: 5,
  versionName: "1.2.0",
  runtimeVersion: "1.2.0",
  apkUrl: "https://downloads.autoflow.app/autoflow-1.2.0.apk",
};

describe("mobileReleases", () => {
  test("publishRelease requires a super admin", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "joe", email: "joe@x.com", name: "Joe" }));
    const asJoe = t.withIdentity({ subject: "joe" });
    await expect(asJoe.mutation(api.mobileReleases.publishRelease, baseRelease)).rejects.toThrow();
  });

  test("getLatestRelease reports updateAvailable against the caller's build number", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const admin = await asSuperAdmin(t);
    await admin.mutation(api.mobileReleases.publishRelease, baseRelease);

    const behind = await t.query(api.mobileReleases.getLatestRelease, { platform: "ANDROID", currentBuildNumber: 4 });
    expect(behind).toMatchObject({ buildNumber: 5, versionName: "1.2.0", updateAvailable: true });

    const current = await t.query(api.mobileReleases.getLatestRelease, { platform: "ANDROID", currentBuildNumber: 5 });
    expect(current?.updateAvailable).toBe(false);
  });

  test("rejects a build number that isn't newer than the current latest", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const admin = await asSuperAdmin(t);
    await admin.mutation(api.mobileReleases.publishRelease, baseRelease);
    await expect(
      admin.mutation(api.mobileReleases.publishRelease, { ...baseRelease, buildNumber: 5 })
    ).rejects.toThrow(/greater than the current latest/);
  });

  test("rejects a non-https apk url", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const admin = await asSuperAdmin(t);
    await expect(
      admin.mutation(api.mobileReleases.publishRelease, { ...baseRelease, apkUrl: "http://insecure.example/app.apk" })
    ).rejects.toThrow(/https/);
  });

  test("returns null when no release is published for the platform", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const result = await t.query(api.mobileReleases.getLatestRelease, { platform: "ANDROID" });
    expect(result).toBeNull();
  });
});
