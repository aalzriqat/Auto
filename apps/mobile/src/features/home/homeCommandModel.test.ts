/// <reference types="jest" />

import type { MobileOrgSummary } from "../../convexApi";
import {
  canOpenHomeWorkflowAction,
  filterWorkspaces,
  getHomeWorkflowActions,
  getPrimaryWorkspace,
  getSafeWorkspaces,
  getVisibleHomeWorkflowActions,
  type HomeWorkflowAction,
  workspaceInitials,
  workspaceSearchText,
} from "./homeCommandModel";

function org(overrides: Partial<MobileOrgSummary>): MobileOrgSummary {
  return {
    _id: "org-default",
    createdAt: 1,
    membershipId: "membership-default",
    name: "Bloom Cars",
    roleName: "OWNER",
    permissions: ["view:vehicles", "view:leads", "view:sales"],
    ...overrides,
  };
}

describe("home command model", () => {
  test("builds stable workspace initials", () => {
    expect(workspaceInitials("Bloom Cars")).toBe("BC");
    expect(workspaceInitials("Solo")).toBe("SO");
    expect(workspaceInitials(" ")).toBe("AF");
    expect(workspaceInitials(undefined)).toBe("AF");
  });

  test("filters safe workspaces by name, role, and id", () => {
    const bloom = org({ _id: "dealer-1", name: "Bloom Cars", roleName: "OWNER" });
    const wadi = org({ _id: "fleet-9", name: "Wadi Saqra", roleName: "SALES" });
    const workspaces = [
      bloom,
      null,
      wadi,
    ];

    expect(getSafeWorkspaces(workspaces)).toHaveLength(2);
    expect(workspaceSearchText(bloom)).toBe("bloom cars owner dealer-1");
    expect(filterWorkspaces(workspaces, "")).toHaveLength(2);
    expect(filterWorkspaces(workspaces, " sales ")).toEqual([wadi]);
    expect(filterWorkspaces(workspaces, "dealer-1")).toEqual([bloom]);
    expect(filterWorkspaces(undefined, "anything")).toEqual([]);
  });

  test("chooses a primary workspace from filtered results or falls back to all", () => {
    const first = org({ _id: "first", name: "First Cars" });
    const second = org({ _id: "second", name: "Second Cars" });

    expect(getPrimaryWorkspace([second], [first, second])).toBe(second);
    expect(getPrimaryWorkspace([], [first, second])).toBe(first);
    expect(getPrimaryWorkspace([], [])).toBeNull();
  });

  test("returns bilingual mobile workflow actions", () => {
    const englishActions = getHomeWorkflowActions("en");
    const arabicActions = getHomeWorkflowActions("ar");

    expect(englishActions).toHaveLength(6);
    expect(englishActions[0]).toMatchObject({
      target: "dashboard",
      title: "Open dashboard",
      tone: "dark",
    });
    expect(englishActions.find((action) => action.target === "sales")?.moduleId).toBe("sales");
    expect(arabicActions.find((action) => action.target === "marketplace")?.title).toBe("تصفح السوق");
    expect(arabicActions.every((action) => action.title.length > 0 && action.subtitle.length > 0)).toBe(true);
  });

  test("filters workflow actions by selected workspace permissions", () => {
    const actions = getHomeWorkflowActions("en");
    const sales = org({
      roleName: "SALES",
      permissions: ["view:vehicles", "view:sales"],
    });
    const visibleTargets = getVisibleHomeWorkflowActions(actions, sales).map((action) => action.target);

    expect(visibleTargets).toEqual(["dashboard", "vehicles", "sales", "messages", "marketplace"]);
    expect(canOpenHomeWorkflowAction(actions.find((action) => action.target === "leads")!, sales)).toBe(false);
    expect(canOpenHomeWorkflowAction(actions.find((action) => action.target === "marketplace")!, null)).toBe(true);
    expect(getVisibleHomeWorkflowActions(actions, null)).toHaveLength(actions.length);

    const missingModule = { ...actions[1], moduleId: undefined };
    const unknownModule = { ...actions[1], moduleId: "unknown" } as unknown as HomeWorkflowAction;
    expect(canOpenHomeWorkflowAction(missingModule, sales)).toBe(false);
    expect(canOpenHomeWorkflowAction(unknownModule, sales)).toBe(false);
  });
});
