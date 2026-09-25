"use client";

import { useState } from "react";
import { CarFront, Gauge, Palette } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** The allowlisted vehicle profile the cockpit queries serve (SCRUM-372). */
export interface DealVehicleCardProfile {
  make: string;
  model: string;
  year: number;
  color: string;
  mileage: number;
  photoUrl: string | null;
}

export interface DealVehicleCardVehicle {
  label: string;
  vin?: string;
  consigned: boolean;
  /** Absent or null when the vehicle row is gone, foreign or soft-deleted. */
  profile?: DealVehicleCardProfile | null;
}

/**
 * The car the deal is about — photo, identity and ownership.
 *
 * Carries ONLY what the server allowlisted: no cost, no source price, no notes.
 * A missing profile degrades to the label and VIN the screen has always had;
 * a missing or broken photo degrades to a silhouette of the same size, so the
 * card never shifts when an image fails.
 */
export function DealVehicleCard({
  vehicle,
  t,
  children,
}: Readonly<{
  vehicle: DealVehicleCardVehicle;
  t: (key: string) => string;
  /** Rendered under the ownership badge — the settlement-route question lives beside it. */
  children?: React.ReactNode;
}>) {
  const profile = vehicle.profile ?? null;
  const [photoFailed, setPhotoFailed] = useState(false);
  const photoUrl = profile?.photoUrl && !photoFailed ? profile.photoUrl : null;
  const title = profile
    ? `${profile.make} ${profile.model} ${profile.year}`.trim()
    : vehicle.label;

  return (
    <Card data-testid="deal-vehicle-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CarFront className="h-4 w-4 text-primary" aria-hidden />
          {t("DealVehicleCardHeading")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-start gap-4">
        <div className="flex aspect-[4/3] w-28 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted sm:w-44">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Convex storage URLs have no stable dimensions; the frame fixes the size.
            <img
              src={photoUrl}
              alt={title}
              loading="lazy"
              className="h-full w-full object-cover"
              onError={() => setPhotoFailed(true)}
              data-testid="deal-vehicle-photo"
            />
          ) : (
            <div
              className="flex flex-col items-center gap-1 text-muted-foreground"
              data-testid="deal-vehicle-photo-placeholder"
            >
              <CarFront className="h-8 w-8 sm:h-10 sm:w-10" aria-hidden />
              <span className="hidden text-center text-xs sm:block">{t("DealVehicleNoPhoto")}</span>
            </div>
          )}
        </div>
        <dl className="min-w-0 flex-1 space-y-2 text-sm">
          <div className="min-w-0">
            <dt className="sr-only">{t("Vehicle")}</dt>
            <dd className="break-words text-base font-semibold">
              <bdi>{title}</bdi>
            </dd>
          </div>
          {vehicle.vin && (
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <dt className="text-xs text-muted-foreground">{t("VIN")}</dt>
              <dd className="min-w-0 break-all font-medium">
                <bdi dir="ltr">{vehicle.vin}</bdi>
              </dd>
            </div>
          )}
          {profile && (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <Palette className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <dt className="text-xs text-muted-foreground">{t("DealVehicleColor")}</dt>
                <dd className="min-w-0 break-words font-medium">
                  <bdi>{profile.color || t("FactUnavailable")}</bdi>
                </dd>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <Gauge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <dt className="text-xs text-muted-foreground">{t("DealVehicleMileage")}</dt>
                <dd className="font-medium">
                  <bdi className="tabular-nums">{profile.mileage.toLocaleString("en-US")}</bdi>{" "}
                  {t("DealVehicleMileageUnit")}
                </dd>
              </div>
            </>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* The badge text already names ownership ("Ownership: …"); the label is for assistive tech only. */}
            <dt className="sr-only">{t("DealVehicleOwnership")}</dt>
            <dd>
              <Badge variant="outline" className="font-normal">
                {vehicle.consigned ? t("OwnershipWithSupplier") : t("OwnershipWithDealership")}
              </Badge>
            </dd>
          </div>
          {children && <dd className="pt-1">{children}</dd>}
        </dl>
      </CardContent>
    </Card>
  );
}
