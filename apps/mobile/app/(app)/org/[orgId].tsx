import { useLocalSearchParams } from "expo-router";

import { firstParam } from "../../../src/navigation/routeParams";
import { OrgDashboardScreen } from "../../../src/features/dashboard/OrgDashboardScreen";

export default function OrgDashboardRoute() {
  const params = useLocalSearchParams<{ orgId?: string | string[] }>();
  return <OrgDashboardScreen orgId={firstParam(params.orgId)} />;
}
