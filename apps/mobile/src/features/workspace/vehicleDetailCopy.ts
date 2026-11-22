import {
  getFuelTypeOptions,
  getTransmissionOptions,
} from "../../data/mobileOptions";

export function vehicleDetailCopy(locale: "en" | "ar", distanceUnit: string) {
  const localeCode = locale === "ar" ? "ar-JO" : "en-US";
  const fuels = getFuelTypeOptions(locale);
  const transmissions = getTransmissionOptions(locale);
  const fuelLabel = (fuel: string) =>
    fuels.find((option) => option.value === fuel)?.label ?? fuel;
  const transmissionLabel = (transmission: string) =>
    transmissions.find((option) => option.value === transmission)?.label ??
    transmission;
  return {
    formatMileage: (distance: number) =>
      `${distance.toLocaleString(localeCode)} ${distanceUnit}`,
    fuelLabel,
    transmissionLabel,
    formatSpecs: (vehicle: {
      color?: string;
      fuelType?: string;
      transmission?: string;
    }) =>
      [
        vehicle.color || "-",
        vehicle.fuelType ? fuelLabel(vehicle.fuelType) : "-",
        vehicle.transmission ? transmissionLabel(vehicle.transmission) : "-",
      ].join(" · "),
  };
}
