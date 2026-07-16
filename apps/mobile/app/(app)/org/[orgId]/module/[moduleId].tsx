import { useLocalSearchParams } from "expo-router";

import { firstParam } from "../../../../../src/navigation/routeParams";
import { WorkspaceModuleScreen } from "../../../../../src/features/workspace/WorkspaceModuleScreen";

export default function WorkspaceModuleRoute() {
  const params = useLocalSearchParams<{
    highlightId?: string | string[];
    moduleId?: string | string[];
    orgId?: string | string[];
  }>();

  return (
    <WorkspaceModuleScreen
      highlightId={firstParam(params.highlightId) ?? undefined}
      moduleId={firstParam(params.moduleId)}
      orgId={firstParam(params.orgId)}
    />
  );
}
