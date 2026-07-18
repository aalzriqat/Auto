import { useLocalSearchParams } from "expo-router";

import { firstParam } from "../../../../../src/navigation/routeParams";
import { VehicleDetailScreen } from "../../../../../src/features/workspace/VehicleDetailScreen";

export default function VehicleDetailRoute() {
  const params = useLocalSearchParams<{
    vehicleId?: string | string[];
    orgId?: string | string[];
  }>();

  return (
    <VehicleDetailScreen
      vehicleId={firstParam(params.vehicleId)}
      orgId={firstParam(params.orgId)}
    />
  );
}
