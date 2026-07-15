/// <reference types="jest" />

import type { MobileOrgSummary } from "../../convexApi";
import {
  filterWorkspaces,
  getSafeWorkspaces,
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
});
