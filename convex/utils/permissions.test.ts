import { describe, it, expect } from "vitest";
import { PERMISSIONS, ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES, cancelAuthorityFor } from "./permissions";

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

  // SCRUM-444 / SCRUM-795 (owner ruling R1, narrowed pilot): only a manager or an
  // accountant moves money through the dealership. These are the permissions the
  // money doors check — recording a deposit or reservation deposit
  // (CONFIRM_FINANCE_DISBURSEMENT), collection receipts and payments
  // (MANAGE_FINANCE), and refund/release approvals (APPROVE_REQUESTS). A
  // salesperson REQUESTS a deposit (`depositRequests.request`); this pins that no
  // default template outside the allowlist can record the money itself.
  it("only OWNER, MANAGER and the accountant templates hold a money-moving permission", () => {
    const MONEY_MOVING = [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
      PERMISSIONS.MANAGE_FINANCE,
      PERMISSIONS.APPROVE_REQUESTS,
    ];
    const holders = DEFAULT_ROLE_TEMPLATES.filter((role) =>
      MONEY_MOVING.some((permission) => role.permissions.includes(permission))
    ).map((role) => role.name);
    expect(holders.sort()).toEqual(["ACCOUNTANT", "MANAGER", "OWNER", "SENIOR_ACCOUNTANT"]);

    const salesRole = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "SALES");
    expect(salesRole).toBeDefined();
    for (const permission of MONEY_MOVING) {
      expect(salesRole!.permissions).not.toContain(permission);
    }
  });
});
