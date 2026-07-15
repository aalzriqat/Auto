import { useLocalSearchParams } from "expo-router";

import { firstParam } from "../../../../../src/navigation/routeParams";
import { WorkspaceTabsLayout } from "../../../../../src/features/workspace/WorkspaceTabsLayout";

export default function OrgWorkspaceTabsRoute() {
  const params = useLocalSearchParams<{ orgId?: string | string[] }>();
  return <WorkspaceTabsLayout orgId={firstParam(params.orgId)} />;
}
