import type { Infer } from "convex/values";
import type { wizardDraftDataValidator } from "../../../convex/wizardDraftData";

export type VehicleLineItem = NonNullable<Infer<typeof wizardDraftDataValidator>["vehicleItems"]>[number];

export type WizardData = Infer<typeof wizardDraftDataValidator>;

export interface WizardLaunchSeed {
  /** Seeds the vehicle picker's "source a vehicle" form when launched via a SOLD vehicle's "Source another like this" action. */
  sourceLikeVehicle?: {
    make: string;
    model: string;
    year: number;
    trim?: string;
    color: string;
    fuelType: string;
    transmission: string;
  };
}
export type PaymentType = "CASH" | "INSTALLMENT";

/** Sentinel selectedCompanyId for the "Others" manual-entry financing card. */
export const OTHER_COMPANY_ID = "OTHER";

