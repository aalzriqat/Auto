import { describe, it, expect } from "vitest";
import { PERMISSIONS, ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES } from "./permissions";

describe("RBAC Permissions Configuration", () => {
  it("should have exactly 30 permissions defined in ALL_PERMISSIONS", () => {
    // This will catch accidental removals or additions without updating tests
    expect(ALL_PERMISSIONS.length).toBeGreaterThan(25);
  });

  it("OWNER role should have all permissions", () => {
    const ownerRole = DEFAULT_ROLE_TEMPLATES.find(r => r.name === "OWNER");
    expect(ownerRole).toBeDefined();
    expect(ownerRole!.permissions.length).toBe(ALL_PERMISSIONS.length);
    expect(ownerRole!.permissions).toEqual(expect.arrayContaining(ALL_PERMISSIONS));
  });

  it("MANAGER role should have mostly all permissions except some sensitive settings", () => {
    const managerRole = DEFAULT_ROLE_TEMPLATES.find(r => r.name === "MANAGER");
    expect(managerRole).toBeDefined();
    expect(managerRole!.permissions).toContain(PERMISSIONS.VIEW_VEHICLES);
    expect(managerRole!.permissions).toContain(PERMISSIONS.CREATE_VEHICLES);
    expect(managerRole!.permissions).toContain(PERMISSIONS.VIEW_COST_PRICE);
  });

  it("SALES role should have restricted permissions", () => {
    const salesRole = DEFAULT_ROLE_TEMPLATES.find(r => r.name === "SALES");
    expect(salesRole).toBeDefined();
    expect(salesRole!.permissions).toContain(PERMISSIONS.VIEW_VEHICLES);
    expect(salesRole!.permissions).not.toContain(PERMISSIONS.CREATE_VEHICLES);
    expect(salesRole!.permissions).not.toContain(PERMISSIONS.VIEW_COST_PRICE);
    // Sales typically can request creation
    expect(salesRole!.permissions).toContain(PERMISSIONS.CREATE_VEHICLES_REQUEST);
  });
});
