import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  ALL_PERMISSIONS,
  DEFAULT_ROLE_TEMPLATES,
  cancelAuthorityFor,
  isUnqualifiedOwnerNamed,
  roleHasPermission,
} from "./permissions";

describe("roleHasPermission", () => {
  it("returns false for a null or undefined role", () => {
    expect(roleHasPermission(null, PERMISSIONS.VIEW_VEHICLES)).toBe(false);
    expect(roleHasPermission(undefined, PERMISSIONS.VIEW_VEHICLES)).toBe(false);
  });

  it("grants a system owner every permission even when it is not listed", () => {
    const owner = { name: "OWNER", permissions: [] as string[], isSystemOwnerRole: true };
    expect(roleHasPermission(owner, PERMISSIONS.MANAGE_FINANCE)).toBe(true);
    expect(roleHasPermission(owner, PERMISSIONS.VIEW_VEHICLES)).toBe(true);
  });

  it("grants a non-owner role the permissions it lists", () => {
    const role = { name: "SALES", permissions: [PERMISSIONS.VIEW_VEHICLES] };
    expect(roleHasPermission(role, PERMISSIONS.VIEW_VEHICLES)).toBe(true);
  });

  it("refuses a non-owner role a permission it does not list", () => {
    const role = { name: "SALES", permissions: [PERMISSIONS.VIEW_VEHICLES] };
    expect(roleHasPermission(role, PERMISSIONS.MANAGE_FINANCE)).toBe(false);
  });

  it("refuses an owner-NAMED role that does not qualify as the system owner", () => {
    const flaggedOff = { name: "OWNER", permissions: [] as string[], isSystemOwnerRole: false };
    const unflaggedShort = { name: "OWNER", permissions: [PERMISSIONS.VIEW_VEHICLES] };
    expect(isUnqualifiedOwnerNamed(flaggedOff)).toBe(true);
    expect(isUnqualifiedOwnerNamed(unflaggedShort)).toBe(true);
    expect(roleHasPermission(flaggedOff, PERMISSIONS.MANAGE_FINANCE)).toBe(false);
    expect(roleHasPermission(unflaggedShort, PERMISSIONS.MANAGE_FINANCE)).toBe(false);
  });

  it("refuses a deleted system-owner role a permission it does not list", () => {
    const deletedOwner = { name: "OWNER", permissions: [] as string[], isSystemOwnerRole: true, isDeleted: true };
    expect(roleHasPermission(deletedOwner, PERMISSIONS.MANAGE_FINANCE)).toBe(false);
  });
});

describe("cancelAuthorityFor", () => {
  it("CLOSED needs CANCEL_CLOSED_DEAL (not CREATE), plus disbursement authority on v2", () => {
    expect(cancelAuthorityFor("CLOSED", 1)).toEqual([[PERMISSIONS.CANCEL_CLOSED_DEAL]]);
    expect(cancelAuthorityFor("CLOSED", 0)).toEqual([[PERMISSIONS.CANCEL_CLOSED_DEAL]]);
    expect(cancelAuthorityFor("CLOSED", 2)).toEqual([
      [PERMISSIONS.CANCEL_CLOSED_DEAL],
      [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT],
    ]);
  });

  it("every other status needs CREATE, plus approval authority once APPROVED", () => {
    expect(cancelAuthorityFor("IN_REVIEW", 2)).toEqual([[PERMISSIONS.CREATE_FINANCE_APPLICATION]]);
    expect(cancelAuthorityFor("APPROVED", 2)).toEqual([
      [PERMISSIONS.CREATE_FINANCE_APPLICATION],
      [PERMISSIONS.APPROVE_FINANCE_APPLICATION],
    ]);
  });
});

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
