import { useLocalSearchParams } from "expo-router";

import { OrgDashboardScreen } from "../../../src/features/dashboard/OrgDashboardScreen";

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export default function OrgDashboardRoute() {
  const params = useLocalSearchParams<{ orgId?: string | string[] }>();
  return <OrgDashboardScreen orgId={firstParam(params.orgId)} />;
}
