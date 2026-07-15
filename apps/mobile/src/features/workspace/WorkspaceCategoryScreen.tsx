import { Screen } from "../../components/Screen";
import { WorkspaceModuleLauncher } from "./WorkspaceModuleLauncher";
import { useWorkspaceTabsData } from "./WorkspaceTabsLayout";
import type { NativeModuleCategory } from "./nativeModules";

export function WorkspaceCategoryScreen({
  category,
}: Readonly<{
  category: NativeModuleCategory;
}>) {
  const { myMembership, orgId } = useWorkspaceTabsData();

  return (
    <Screen scroll padding="lg">
      <WorkspaceModuleLauncher
        initialCategory={category}
        lockedCategory={category}
        orgId={orgId}
        permissions={myMembership.permissions}
        roleName={myMembership.roleName}
      />
    </Screen>
  );
}
