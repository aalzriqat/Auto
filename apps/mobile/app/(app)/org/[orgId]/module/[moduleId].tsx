import { useLocalSearchParams } from "expo-router";

import { WorkspaceModuleScreen } from "../../../../../src/features/workspace/WorkspaceModuleScreen";

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export default function WorkspaceModuleRoute() {
  const params = useLocalSearchParams<{
    moduleId?: string | string[];
    orgId?: string | string[];
  }>();

  return (
    <WorkspaceModuleScreen
      moduleId={firstParam(params.moduleId)}
      orgId={firstParam(params.orgId)}
    />
  );
}
