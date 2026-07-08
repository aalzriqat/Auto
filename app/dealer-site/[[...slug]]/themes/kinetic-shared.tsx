import type { PublicVehicle } from "./theme-props";

export function waLink(phone: string | null | undefined, message: string) {
  const digits = (phone ?? "").replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export function telLink(phone: string | null | undefined) {
  return `tel:${(phone ?? "").replace(/\s+/g, "")}`;
}

export function vehicleTitle(v: PublicVehicle) {
  return `${v.year} ${v.make} ${v.model}${v.trim ? ` ${v.trim}` : ""}`;
}

export function KineticVehicleImage({
  vehicle,
  className,
  iconClassName,
}: {
  vehicle: PublicVehicle;
  className?: string;
  iconClassName?: string;
}) {
  if (vehicle.imageUrls[0]) {
    return <img className={className} src={vehicle.imageUrls[0]} alt={vehicleTitle(vehicle)} />;
  }
  return (
    <div className={`flex items-center justify-center bg-surface-container text-outline-variant ${className ?? ""}`}>
      <span className={`material-symbols-outlined ${iconClassName ?? "text-4xl"}`}>directions_car</span>
    </div>
  );
}
