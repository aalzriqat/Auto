/**
 * AutoFlow Permission System
 *
 * Permissions are fine-grained strings following the pattern "action:resource".
 * Roles are database records containing an array of these permission strings.
 * This decoupling means roles can be customized per-organization without code changes.
 */

export const PERMISSIONS = {
  // Organizations
  VIEW_ORG: "view:org",
  EDIT_ORG: "edit:org",

  // Users & Memberships
  VIEW_USERS: "view:users",
  MANAGE_USERS: "manage:users",
  MANAGE_ROLES: "manage:roles",

  // Vehicles
  VIEW_VEHICLES: "view:vehicles",
  CREATE_VEHICLES: "create:vehicles",
  CREATE_VEHICLES_REQUEST: "create:vehicles:request",
  EDIT_VEHICLES: "edit:vehicles",
  EDIT_VEHICLES_REQUEST: "edit:vehicles:request",
  DELETE_VEHICLES: "delete:vehicles",

  // Vehicle Sub-tabs
  VIEW_VEHICLE_INFO: "view:vehicle_info",
  VIEW_VEHICLE_LEADS: "view:vehicle_leads",
  VIEW_VEHICLE_EXPENSES: "view:vehicle_expenses",
  VIEW_VEHICLE_TASKS: "view:vehicle_tasks",
  VIEW_VEHICLE_TEST_DRIVES: "view:vehicle_test_drives",
  VIEW_VEHICLE_WORK_ORDERS: "view:vehicle_work_orders",
  VIEW_VEHICLE_VALUATIONS: "view:vehicle_valuations",
  // Writing a finance-company valuation is deliberately separate from
  // `edit:vehicles`. A valuation is an external figure the finance company
  // quotes, not dealership-owned data like price or cost, so SALES is trusted
  // to keep it current without going through the vehicle-edit approval flow.
  EDIT_VEHICLE_VALUATIONS: "edit:vehicle_valuations",

  // Customers
  VIEW_CUSTOMERS: "view:customers",
  CREATE_CUSTOMERS: "create:customers",
  CREATE_CUSTOMERS_REQUEST: "create:customers:request",
  EDIT_CUSTOMERS: "edit:customers",
  EDIT_CUSTOMERS_REQUEST: "edit:customers:request",
  DELETE_CUSTOMERS: "delete:customers",

  // Leads
  VIEW_LEADS: "view:leads",
  CREATE_LEADS: "create:leads",
  CREATE_LEADS_REQUEST: "create:leads:request",
  EDIT_LEADS: "edit:leads",
  EDIT_LEADS_REQUEST: "edit:leads:request",
  DELETE_LEADS: "delete:leads",

  // Sales
  VIEW_SALES: "view:sales",
  CREATE_SALES: "create:sales",
  CREATE_SALES_REQUEST: "create:sales:request",
  EDIT_SALES: "edit:sales",
  EDIT_SALES_REQUEST: "edit:sales:request",
  DELETE_SALES: "delete:sales",

  // Expenses
  VIEW_EXPENSES: "view:expenses",
  CREATE_EXPENSES: "create:expenses",
  CREATE_EXPENSES_REQUEST: "create:expenses:request",
  EDIT_EXPENSES: "edit:expenses",
  EDIT_EXPENSES_REQUEST: "edit:expenses:request",
  DELETE_EXPENSES: "delete:expenses",

  // Tasks
  VIEW_TASKS: "view:tasks",
  CREATE_TASKS: "create:tasks",
  EDIT_TASKS: "edit:tasks",
  DELETE_TASKS: "delete:tasks",

  // Reports
  VIEW_REPORTS: "view:reports",

  // Settings
  VIEW_SETTINGS: "view:settings",
  MANAGE_SETTINGS: "manage:settings",

  // Dealer Website
  WEBSITE_VIEW: "website.view",
  WEBSITE_MANAGE: "website.manage",
  WEBSITE_PUBLISH: "website.publish",
  WEBSITE_DOMAIN_MANAGE: "website.domain.manage",
  WEBSITE_LEADS_MANAGE: "website.leads.manage",
  WEBSITE_ANALYTICS_VIEW: "website.analytics.view",

  // Finance / Accounting
  VIEW_FINANCE: "view:finance",
  MANAGE_FINANCE: "manage:finance",
  // Reopening a closed period undoes every one of the close's own protections
  // (pending events, AR/subledger reconciliation, unmatched bank lines all
  // stop blocking anything) — deliberately narrower than MANAGE_FINANCE, not
  // granted to the default ACCOUNTANT template. An org grants it to a
  // controller role explicitly; the owner always has it via ALL_PERMISSIONS.
  REOPEN_PERIODS: "reopen:accounting_periods",

  // Financial — sensitive field visibility
  VIEW_COST_PRICE: "view:cost_price",

  // Commissions
  VIEW_COMMISSIONS: "view:commissions",
  MANAGE_COMMISSIONS: "manage:commissions",

  // Payroll (employee compensation, salary advances, monthly payroll runs)
  VIEW_PAYROLL: "view:payroll",
  MANAGE_PAYROLL: "manage:payroll",

  // Approvals (profit approvals, finance application approvals, document verification)
  APPROVE_REQUESTS: "approve:requests", // Cache buster 1
  VIEW_FINANCE_APPLICATIONS: "view:finance_applications",
  CREATE_FINANCE_APPLICATION: "create:finance_application",
  REVIEW_FINANCE_APPLICATION: "review:finance_application",
  APPROVE_FINANCE_APPLICATION: "approve:finance_application",
  FINALIZE_FINANCED_DEAL: "finalize:financed_deal",
  // SCRUM-413 (owner ruling 2026-09-28): the two authorities split out of
  // FINALIZE_FINANCED_DEAL. Recording where the finance company pays the
  // supplier on a financed deal, and reversing a financed deal that has
  // already closed — the latter deliberately stronger. Neither is granted to
  // SALES. Until the cutover (PR-B) no door checks them; they exist first so
  // stored roles can be given them BEFORE the doors move (see
  // `transitionalDealGrants`).
  MANAGE_SUPPLIER_SETTLEMENT: "manage:supplier_settlement",
  CANCEL_CLOSED_DEAL: "cancel:closed_deal",
  CONFIRM_FINANCE_DISBURSEMENT: "confirm:finance_disbursement",
  VERIFY_FINANCE_DOCUMENTS: "verify:finance_documents",
  REGISTER_VEHICLE_HANDOVER: "register:vehicle_handover",
  REGISTER_EXPECTED_PAYMENT: "register:expected_payment",

  // Dealer Network Marketplace
  MARKETPLACE_SETTINGS: "marketplace:settings",
  MARKETPLACE_RESPOND: "marketplace:respond",
  MARKETPLACE_ANALYTICS: "marketplace:analytics",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** All defined permission values as an array — useful for the OWNER role. */
export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);
const ALL_PERMISSION_VALUES = new Set<string>(ALL_PERMISSIONS);

export const SYSTEM_OWNER_ROLE_NAME = "OWNER";

type RoleLike = {
  name: string;
  permissions: string[];
  isDeleted?: boolean;
  isSystemOwnerRole?: boolean;
};

export function normalizeRoleName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

export function isReservedRoleName(name: string): boolean {
  return normalizeRoleName(name) === SYSTEM_OWNER_ROLE_NAME;
}

export function getInvalidPermissions(permissions: readonly string[]): string[] {
  return permissions.filter((permission) => !ALL_PERMISSION_VALUES.has(permission));
}

export function dedupePermissions<T extends string>(permissions: readonly T[]): T[] {
  return Array.from(new Set(permissions));
}

/**
 * The permission set an unflagged legacy OWNER row must hold to be recognised
 * as the owner — FROZEN at the values `PERMISSIONS` held immediately before
 * SCRUM-413, and never edited again.
 *
 * It used to be "every currently-defined permission", which made every new
 * permission silently de-owner every unflagged OWNER row until a backfill ran
 * — and retiring one would have silently promoted rows that never held it.
 * Frozen, neither can happen: the rows that qualified before still qualify,
 * and no row starts qualifying. `permissions.test.ts` pins this list.
 */
export const PRE_413_OWNER_FALLBACK_PERMISSIONS: readonly string[] = Object.freeze([
  "view:org", "edit:org", "view:users", "manage:users", "manage:roles",
  "view:vehicles", "create:vehicles", "create:vehicles:request", "edit:vehicles", "edit:vehicles:request",
  "delete:vehicles", "view:vehicle_info", "view:vehicle_leads", "view:vehicle_expenses", "view:vehicle_tasks",
  "view:vehicle_test_drives", "view:vehicle_work_orders", "view:vehicle_valuations", "edit:vehicle_valuations",
  "view:customers", "create:customers", "create:customers:request", "edit:customers", "edit:customers:request",
  "delete:customers", "view:leads", "create:leads", "create:leads:request", "edit:leads", "edit:leads:request",
  "delete:leads", "view:sales", "create:sales", "create:sales:request", "edit:sales", "edit:sales:request",
  "delete:sales", "view:expenses", "create:expenses", "create:expenses:request", "edit:expenses",
  "edit:expenses:request", "delete:expenses", "view:tasks", "create:tasks", "edit:tasks", "delete:tasks",
  "view:reports", "view:settings", "manage:settings", "website.view", "website.manage", "website.publish",
  "website.domain.manage", "website.leads.manage", "website.analytics.view", "view:finance", "manage:finance",
  "reopen:accounting_periods", "view:cost_price", "view:commissions", "manage:commissions", "view:payroll",
  "manage:payroll", "approve:requests", "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application", "finalize:financed_deal",
  "confirm:finance_disbursement", "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment", "marketplace:settings", "marketplace:respond", "marketplace:analytics",
]);

function holdsTheFrozenOwnerSet(permissions: readonly string[]): boolean {
  const permissionSet = new Set(permissions);
  return PRE_413_OWNER_FALLBACK_PERMISSIONS.every((permission) => permissionSet.has(permission));
}

/**
 * OWNER is a system role, not a mutable display-name convention. The fallback
 * keeps old seeded OWNER rows working until the backfill marks them explicitly.
 */
export function isSystemOwnerRole(role: RoleLike | null | undefined): boolean {
  if (!role || role.isDeleted) return false;
  if (role.isSystemOwnerRole === true) return true;
  if (role.isSystemOwnerRole === false) return false;
  return role.name === SYSTEM_OWNER_ROLE_NAME && holdsTheFrozenOwnerSet(role.permissions);
}

/**
 * SCRUM-413 transition: the new deal authorities a stored role is owed so
 * that moving the doors off `finalize:financed_deal` denies no one who could
 * act before. It PRESERVES authority and never adds any:
 *
 * - an owner (already bypasses every check) gets both;
 * - a role stored as exactly "MANAGER" gets each one only where it already
 *   held the matching old authority — the route door took FINALIZE alone,
 *   the closed-cancel door took FINALIZE plus CREATE_FINANCE_APPLICATION;
 * - every other role gets nothing. A name is not provenance (a custom role
 *   can be called "manager"), so no other name earns a grant here; the
 *   ACCOUNTANT route grant the owner ruled is applied only by the owner.
 *
 * Pure. The migration and every role writer call this same function, so
 * they cannot drift apart. Returns the permissions to ADD.
 */
export function transitionalDealGrants(role: RoleLike): Permission[] {
  if (role.isDeleted) return [];
  const owed: Permission[] = [];
  if (isSystemOwnerRole(role)) {
    owed.push(PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT, PERMISSIONS.CANCEL_CLOSED_DEAL);
  } else if (role.name === "MANAGER") {
    const held = new Set(role.permissions);
    if (held.has(PERMISSIONS.FINALIZE_FINANCED_DEAL)) {
      owed.push(PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT);
      if (held.has(PERMISSIONS.CREATE_FINANCE_APPLICATION)) owed.push(PERMISSIONS.CANCEL_CLOSED_DEAL);
    }
  }
  return owed.filter((permission) => !role.permissions.includes(permission));
}

export const DEFAULT_ROLE_TEMPLATES: { name: string; permissions: Permission[] }[] = [
  {
    name: SYSTEM_OWNER_ROLE_NAME,
    permissions: [...ALL_PERMISSIONS],
  },
  {
    name: "MANAGER",
    permissions: [
      PERMISSIONS.VIEW_ORG,
      PERMISSIONS.VIEW_USERS,
      PERMISSIONS.MANAGE_USERS,
      PERMISSIONS.VIEW_VEHICLES,
      PERMISSIONS.CREATE_VEHICLES,
      PERMISSIONS.EDIT_VEHICLES,
      PERMISSIONS.DELETE_VEHICLES,
      PERMISSIONS.VIEW_VEHICLE_INFO,
      PERMISSIONS.VIEW_VEHICLE_LEADS,
      PERMISSIONS.VIEW_VEHICLE_EXPENSES,
      PERMISSIONS.VIEW_VEHICLE_TASKS,
      PERMISSIONS.VIEW_VEHICLE_TEST_DRIVES,
      PERMISSIONS.VIEW_VEHICLE_WORK_ORDERS,
      PERMISSIONS.VIEW_VEHICLE_VALUATIONS,
      PERMISSIONS.EDIT_VEHICLE_VALUATIONS,
      PERMISSIONS.VIEW_CUSTOMERS,
      PERMISSIONS.CREATE_CUSTOMERS,
      PERMISSIONS.EDIT_CUSTOMERS,
      PERMISSIONS.DELETE_CUSTOMERS,
      PERMISSIONS.VIEW_LEADS,
      PERMISSIONS.CREATE_LEADS,
      PERMISSIONS.EDIT_LEADS,
      PERMISSIONS.DELETE_LEADS,
      PERMISSIONS.VIEW_SALES,
      PERMISSIONS.CREATE_SALES,
      PERMISSIONS.EDIT_SALES,
      PERMISSIONS.VIEW_EXPENSES,
      PERMISSIONS.CREATE_EXPENSES,
      PERMISSIONS.EDIT_EXPENSES,
      PERMISSIONS.DELETE_EXPENSES,
      PERMISSIONS.VIEW_TASKS,
      PERMISSIONS.CREATE_TASKS,
      PERMISSIONS.EDIT_TASKS,
      PERMISSIONS.DELETE_TASKS,
      PERMISSIONS.VIEW_REPORTS,
      PERMISSIONS.VIEW_SETTINGS, // read-only: branch/lead-source/customer-status dropdowns, org config
      PERMISSIONS.WEBSITE_VIEW,
      PERMISSIONS.WEBSITE_MANAGE,
      PERMISSIONS.WEBSITE_PUBLISH,
      PERMISSIONS.WEBSITE_DOMAIN_MANAGE,
      PERMISSIONS.WEBSITE_LEADS_MANAGE,
      PERMISSIONS.WEBSITE_ANALYTICS_VIEW,
      PERMISSIONS.VIEW_COST_PRICE,
      PERMISSIONS.VIEW_COMMISSIONS,
      PERMISSIONS.MANAGE_COMMISSIONS,
      PERMISSIONS.VIEW_PAYROLL,
      PERMISSIONS.MANAGE_PAYROLL,
      PERMISSIONS.APPROVE_REQUESTS,
      PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
      PERMISSIONS.REVIEW_FINANCE_APPLICATION,
      PERMISSIONS.APPROVE_FINANCE_APPLICATION,
      PERMISSIONS.FINALIZE_FINANCED_DEAL,
      PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT,
      PERMISSIONS.CANCEL_CLOSED_DEAL,
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
      PERMISSIONS.VERIFY_FINANCE_DOCUMENTS,
      PERMISSIONS.REGISTER_VEHICLE_HANDOVER,
      PERMISSIONS.REGISTER_EXPECTED_PAYMENT,
      PERMISSIONS.MARKETPLACE_SETTINGS,
      PERMISSIONS.MARKETPLACE_RESPOND,
      PERMISSIONS.MARKETPLACE_ANALYTICS,
    ],
  },
  {
    name: "SALES",
    permissions: [
      PERMISSIONS.VIEW_ORG,
      PERMISSIONS.VIEW_USERS,
      PERMISSIONS.VIEW_VEHICLES,
      PERMISSIONS.VIEW_VEHICLE_INFO,
      PERMISSIONS.VIEW_VEHICLE_LEADS,
      PERMISSIONS.VIEW_VEHICLE_TEST_DRIVES,
      PERMISSIONS.VIEW_VEHICLE_VALUATIONS,
      PERMISSIONS.EDIT_VEHICLE_VALUATIONS, // Valuations only — writes directly, no approval request
      PERMISSIONS.CREATE_VEHICLES_REQUEST, // Can request creation
      PERMISSIONS.EDIT_VEHICLES_REQUEST, // Can only request edits
      PERMISSIONS.VIEW_CUSTOMERS,
      PERMISSIONS.CREATE_CUSTOMERS,
      PERMISSIONS.EDIT_CUSTOMERS,
      PERMISSIONS.VIEW_LEADS,
      PERMISSIONS.CREATE_LEADS,
      PERMISSIONS.EDIT_LEADS,
      PERMISSIONS.VIEW_SALES,
      PERMISSIONS.CREATE_SALES_REQUEST, // Cannot directly create, requires approval or just request
      PERMISSIONS.VIEW_TASKS,
      PERMISSIONS.CREATE_TASKS,
      PERMISSIONS.EDIT_TASKS,
      PERMISSIONS.VIEW_SETTINGS,
      PERMISSIONS.VIEW_COMMISSIONS,
      PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
      PERMISSIONS.FINALIZE_FINANCED_DEAL,
      PERMISSIONS.REGISTER_VEHICLE_HANDOVER,
      PERMISSIONS.REGISTER_EXPECTED_PAYMENT,
      PERMISSIONS.MARKETPLACE_RESPOND,
    ],
  },
  {
    name: "RECEPTION",
    permissions: [
      PERMISSIONS.VIEW_ORG,
      PERMISSIONS.VIEW_USERS,
      PERMISSIONS.VIEW_VEHICLES,
      PERMISSIONS.VIEW_VEHICLE_INFO,
      PERMISSIONS.VIEW_VEHICLE_TEST_DRIVES,
      PERMISSIONS.VIEW_CUSTOMERS,
      PERMISSIONS.CREATE_CUSTOMERS,
      PERMISSIONS.EDIT_CUSTOMERS,
      PERMISSIONS.VIEW_LEADS,
      PERMISSIONS.CREATE_LEADS,
      PERMISSIONS.EDIT_LEADS,
    ],
  },
  {
    name: "ACCOUNTANT",
    permissions: [
      PERMISSIONS.VIEW_ORG,
      PERMISSIONS.VIEW_USERS,
      PERMISSIONS.VIEW_VEHICLES,
      PERMISSIONS.VIEW_VEHICLE_INFO,
      PERMISSIONS.VIEW_VEHICLE_EXPENSES,
      PERMISSIONS.VIEW_CUSTOMERS,
      PERMISSIONS.VIEW_SALES,
      PERMISSIONS.VIEW_EXPENSES,
      PERMISSIONS.CREATE_EXPENSES,
      PERMISSIONS.EDIT_EXPENSES,
      PERMISSIONS.VIEW_REPORTS,
      PERMISSIONS.VIEW_FINANCE,
      PERMISSIONS.MANAGE_FINANCE,
      PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
      PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT,
      PERMISSIONS.VIEW_PAYROLL,
      PERMISSIONS.MANAGE_PAYROLL,
    ],
  },
  {
    // Everything ACCOUNTANT has, plus the day-to-day authority a lone
    // accountant needs to operate without a second person: cleaning up their
    // own unposted mistakes, and reviewing/paying commissions. Deliberately
    // still without REOPEN_PERIODS (see that permission's own comment above)
    // — that stays a separate Finance Controller grant, not bundled here.
    name: "SENIOR_ACCOUNTANT",
    permissions: [
      PERMISSIONS.VIEW_ORG,
      PERMISSIONS.VIEW_USERS,
      PERMISSIONS.VIEW_VEHICLES,
      PERMISSIONS.VIEW_VEHICLE_INFO,
      PERMISSIONS.VIEW_VEHICLE_EXPENSES,
      PERMISSIONS.VIEW_CUSTOMERS,
      PERMISSIONS.VIEW_SALES,
      PERMISSIONS.VIEW_EXPENSES,
      PERMISSIONS.CREATE_EXPENSES,
      PERMISSIONS.EDIT_EXPENSES,
      PERMISSIONS.DELETE_EXPENSES,
      PERMISSIONS.VIEW_REPORTS,
      PERMISSIONS.VIEW_FINANCE,
      PERMISSIONS.MANAGE_FINANCE,
      PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
      PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT,
      PERMISSIONS.VIEW_COST_PRICE,
      PERMISSIONS.VIEW_COMMISSIONS,
      PERMISSIONS.MANAGE_COMMISSIONS,
      PERMISSIONS.VIEW_PAYROLL,
      PERMISSIONS.MANAGE_PAYROLL,
    ],
  },
];
