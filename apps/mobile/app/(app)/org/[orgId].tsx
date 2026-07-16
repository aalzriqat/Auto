import { nativeRoutes } from "@autoflow/shared";
import { Redirect, useLocalSearchParams } from "expo-router";

import { firstParam } from "../../../src/navigation/routeParams";

export default function OrgDashboardRoute() {
  const params = useLocalSearchParams<{ orgId?: string | string[] }>();
  const orgId = firstParam(params.orgId);

  if (!orgId) {
    return <Redirect href={nativeRoutes.home} />;
  }

  return (
    <Redirect
      href={{
        pathname: nativeRoutes.orgHome,
        params: { orgId },
      }}
    />
  );
}
