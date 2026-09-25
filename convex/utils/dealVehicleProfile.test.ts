import { describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { projectDealVehicleProfile } from "./dealVehicleProfile";

const ORG = "org_a" as Id<"organizations">;
const OTHER_ORG = "org_b" as Id<"organizations">;

function vehicle(overrides: Partial<Doc<"vehicles">> = {}): Doc<"vehicles"> {
  return {
    _id: "veh_1" as Id<"vehicles">,
    _creationTime: 0,
    orgId: ORG,
    make: "Toyota",
    model: "Corolla",
    year: 2023,
    mileage: 18450,
    color: "White",
    fuelType: "PETROL",
    transmission: "AUTOMATIC",
    sellingPrice: 10500,
    purchasePrice: 9000,
    landedCostTotal: 300,
    minimumProfit: 500,
    sourceCost: 8800,
    notes: "internal note — never on the deal card",
    status: "AVAILABLE",
    imageIds: ["img_1" as Id<"_storage">, "img_2" as Id<"_storage">],
    ...overrides,
  } as Doc<"vehicles">;
}

function ctxWith(getUrl: (id: Id<"_storage">) => Promise<string | null>): QueryCtx {
  return { storage: { getUrl: vi.fn(getUrl) } } as unknown as QueryCtx;
}

describe("projectDealVehicleProfile (SCRUM-372 vehicle card)", () => {
  it("returns ONLY the allowlisted attributes and the first photo's URL", async () => {
    const ctx = ctxWith(async (id) => `https://files.example/${id}`);
    const profile = await projectDealVehicleProfile(ctx, vehicle(), ORG, true);

    expect(profile).toEqual({
      make: "Toyota",
      model: "Corolla",
      year: 2023,
      color: "White",
      mileage: 18450,
      photoUrl: "https://files.example/img_1",
    });
    // Cost, source price, minimum profit, notes and raw storage ids never leave.
    expect(Object.keys(profile ?? {}).sort()).toEqual(
      ["color", "make", "mileage", "model", "photoUrl", "year"],
    );
    expect(ctx.storage.getUrl).toHaveBeenCalledTimes(1);
    expect(ctx.storage.getUrl).toHaveBeenCalledWith("img_1");
  });

  it("refuses a vehicle from another organization without minting a URL", async () => {
    const ctx = ctxWith(async () => "https://files.example/leak");
    expect(await projectDealVehicleProfile(ctx, vehicle({ orgId: OTHER_ORG }), ORG, true)).toBeNull();
    expect(ctx.storage.getUrl).not.toHaveBeenCalled();
  });

  it("refuses a soft-deleted vehicle and a missing one", async () => {
    const ctx = ctxWith(async () => "https://files.example/x");
    expect(await projectDealVehicleProfile(ctx, vehicle({ isDeleted: true }), ORG, true)).toBeNull();
    expect(await projectDealVehicleProfile(ctx, null, ORG, true)).toBeNull();
    expect(ctx.storage.getUrl).not.toHaveBeenCalled();
  });

  it("serves a null photo when the vehicle has no images", async () => {
    const ctx = ctxWith(async () => "https://files.example/x");
    const profile = await projectDealVehicleProfile(ctx, vehicle({ imageIds: [] }), ORG, true);
    expect(profile?.photoUrl).toBeNull();
    expect(ctx.storage.getUrl).not.toHaveBeenCalled();
  });

  it("withholds the whole card, photo included, from a caller who may not view vehicles", async () => {
    // A custom role can hold VIEW_SALES without VIEW_VEHICLES. The vehicle
    // readers refuse that caller, so the deal cockpit must not become a second
    // way to the same photo (CodeRabbit on PR #338).
    const ctx = ctxWith(async () => "https://files.example/x");
    expect(await projectDealVehicleProfile(ctx, vehicle(), ORG, false)).toBeNull();
    expect(ctx.storage.getUrl).not.toHaveBeenCalled();
  });

  it("degrades to a null photo when storage no longer resolves or throws", async () => {
    const gone = await projectDealVehicleProfile(ctxWith(async () => null), vehicle(), ORG, true);
    expect(gone?.photoUrl).toBeNull();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = await projectDealVehicleProfile(
      ctxWith(async () => {
        throw new Error("storage unavailable");
      }),
      vehicle(),
      ORG,
      true,
    );
    expect(thrown?.photoUrl).toBeNull();
    expect(thrown?.make).toBe("Toyota");
    errorSpy.mockRestore();
  });
});
