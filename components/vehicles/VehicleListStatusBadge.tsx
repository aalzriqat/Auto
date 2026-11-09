"use client";

import { Badge } from "@/components/ui/badge";
import { translateVehicleStatus, type Translate } from "@/lib/i18n/statusLabels";

export function StatusBadge({ status, t }: Readonly<{ status: string; t: Translate }>) {
  const label = translateVehicleStatus(status, t);
  switch (status) {
    case "AVAILABLE":
      return <Badge variant="default" className="bg-green-600">{label}</Badge>;
    case "RESERVED":
      return <Badge variant="secondary" className="bg-yellow-500 text-white">{label}</Badge>;
    case "SOLD":
      return <Badge variant="secondary" className="bg-blue-600 text-white">{label}</Badge>;
    case "IN_INSPECTION":
      return <Badge variant="outline" className="text-orange-500 border-orange-500">{label}</Badge>;
    case "IN_REPAIR":
      return <Badge variant="outline" className="text-red-500 border-red-500">{label}</Badge>;
    case "SOURCING":
      return <Badge variant="outline" className="text-purple-600 border-purple-600">{label}</Badge>;
    case "ARCHIVED":
      return <Badge variant="secondary">{label}</Badge>;
    default:
      return <Badge variant="outline">{label}</Badge>;
  }
}
