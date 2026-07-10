import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

async function seedDealer(t: ReturnType<typeof convexTest>, opts?: { name?: string; suspended?: boolean }) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: opts?.name ?? "Test Dealer", createdAt: Date.now(), suspended: opts?.suspended })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: `owner_${orgId}`, email: `owner_${orgId}@test.com`, name: "Owner" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ["marketplace:settings"],
      isSystemOwnerRole: true,
    })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId, asOwner: t.withIdentity({ subject: `owner_${orgId}` }) };
}

async function seedVehicle(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"organizations">,
  overrides?: Partial<{ status: "AVAILABLE" | "SOLD"; isDeleted: boolean }>
) {
  await t.run(async (ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Toyota",
      model: "Corolla",
      year: 2020,
      mileage: 50000,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      sellingPrice: 15000,
      status: overrides?.status ?? "AVAILABLE",
      isDeleted: overrides?.isDeleted ?? false,
    })
  );
}

describe("marketplaceDealers", () => {
  test("getMyProfile returns null when never configured", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedDealer(t);
    const profile = await asOwner.query(api.marketplaceDealers.getMyProfile, { orgId });
    expect(profile).toBeNull();
  });

  test("getMyProfile throws when unauthenticated", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedDealer(t);
    await expect(t.query(api.marketplaceDealers.getMyProfile, { orgId })).rejects.toThrow();
  });

  test("updateProfile inserts a new profile and normalizes areas/brands", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedDealer(t);

    await asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId,
      isOptedIn: true,
      areas: [" Amman ", "Amman", "", "Zarqa"],
      brandsCarried: ["Toyota", " Kia "],
      whatsappNumber: " +962700000000 ",
    });

    const profile = await asOwner.query(api.marketplaceDealers.getMyProfile, { orgId });
    expect(profile?.isOptedIn).toBe(true);
    expect(profile?.areas).toEqual(["Amman", "Zarqa"]);
    expect(profile?.brandsCarried).toEqual(["Toyota", "Kia"]);
    expect(profile?.whatsappNumber).toBe("+962700000000");
    expect(profile?.tier).toBe("FREE_FOUNDING");
  });

  test("updateProfile upserts in place rather than duplicating", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedDealer(t);

    await asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId,
      isOptedIn: true,
      areas: ["Amman"],
      brandsCarried: [],
    });
    await asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId,
      isOptedIn: false,
      areas: ["Irbid"],
      brandsCarried: [],
    });

    const rows = await t.run((ctx) => ctx.db.query("marketplaceDealerProfiles").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].isOptedIn).toBe(false);
    expect(rows[0].areas).toEqual(["Irbid"]);
  });

  test("listPublicDirectory only returns opted-in dealers with a live vehicle count", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const optedIn = await seedDealer(t, { name: "Opted In Dealer" });
    const optedOut = await seedDealer(t, { name: "Opted Out Dealer" });

    await optedIn.asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId: optedIn.orgId,
      isOptedIn: true,
      areas: ["Amman"],
      brandsCarried: ["Toyota"],
    });
    await optedOut.asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId: optedOut.orgId,
      isOptedIn: false,
      areas: ["Amman"],
      brandsCarried: [],
    });

    await seedVehicle(t, optedIn.orgId, { status: "AVAILABLE" });
    await seedVehicle(t, optedIn.orgId, { status: "AVAILABLE" });
    await seedVehicle(t, optedIn.orgId, { status: "SOLD" });
    await seedVehicle(t, optedIn.orgId, { status: "AVAILABLE", isDeleted: true });

    const directory = await t.query(api.marketplaceDealers.listPublicDirectory, {});
    expect(directory).toHaveLength(1);
    expect(directory[0].dealershipName).toBe("Opted In Dealer");
    expect(directory[0].activeVehicleCount).toBe(2);
  });

  test("listPublicDirectory excludes orgs suspended after opting in", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const dealer = await seedDealer(t, { name: "Later Suspended Dealer" });

    await dealer.asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId: dealer.orgId,
      isOptedIn: true,
      areas: [],
      brandsCarried: [],
    });
    await t.run((ctx) => ctx.db.patch(dealer.orgId, { suspended: true }));

    const directory = await t.query(api.marketplaceDealers.listPublicDirectory, {});
    expect(directory).toHaveLength(0);
  });
});
