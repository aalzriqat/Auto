import type { convexTestWithComponents } from "./convexTest";
import type { Id } from "../convex/_generated/dataModel";

type TestConvex = ReturnType<typeof convexTestWithComponents>;

/** An AVAILABLE stock vehicle in `orgId`. */
export async function seedVehicle(t: TestConvex, orgId: Id<"organizations">, vin: string) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin,
      make: "Toyota",
      model: "RAV4",
      year: 2025,
      mileage: 100,
      color: "Silver",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 18000,
      sellingPrice: 22000,
      status: "AVAILABLE",
    })
  );
}

/** An active finance company in `orgId`. */
export async function seedCompany(t: TestConvex, orgId: Id<"organizations">, name: string) {
  return await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name,
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      adminFees: 0,
    })
  );
}
