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

  // Customers
  VIEW_CUSTOMERS: "view:customers",
  CREATE_CUSTOMERS: "create:customers",
  CREATE_CUSTOMERS_REQUEST: "create:customers:request",
  EDIT_CUSTOMERS: "edit:customers",
  EDIT_CUSTOMERS_REQUEST: "edit:customers:request",
  DELETE_CUSTOMERS: "delete:customers",
  MERGE_CUSTOMERS: "merge:customers",

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

  // Finance / Accounting
  VIEW_FINANCE: "view:finance",
  MANAGE_FINANCE: "manage:finance",

  // Financial — sensitive field visibility
  VIEW_COST_PRICE: "view:cost_price",

  // Commissions
  VIEW_COMMISSIONS: "view:commissions",
  MANAGE_COMMISSIONS: "manage:commissions",

  // Approvals (profit approvals, finance application approvals, document verification)
  APPROVE_REQUESTS: "approve:requests", // Cache buster 1
  VIEW_FINANCE_APPLICATIONS: "view:finance_applications",
  CREATE_FINANCE_APPLICATION: "create:finance_application",
  REVIEW_FINANCE_APPLICATION: "review:finance_application",
  APPROVE_FINANCE_APPLICATION: "approve:finance_application",
  FINALIZE_FINANCED_DEAL: "finalize:financed_deal",
  CONFIRM_FINANCE_DISBURSEMENT: "confirm:finance_disbursement",
  VERIFY_FINANCE_DOCUMENTS: "verify:finance_documents",
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

function hasEveryDefinedPermission(permissions: readonly string[]): boolean {
  const permissionSet = new Set(permissions);
  return ALL_PERMISSIONS.every((permission) => permissionSet.has(permission));
}

/**
 * OWNER is a system role, not a mutable display-name convention. The fallback
 * keeps old seeded OWNER rows working until the backfill marks them explicitly.
 */
export function isSystemOwnerRole(role: RoleLike | null | undefined): boolean {
  if (!role || role.isDeleted) return false;
  if (role.isSystemOwnerRole === true) return true;
  if (role.isSystemOwnerRole === false) return false;
  return role.name === SYSTEM_OWNER_ROLE_NAME && hasEveryDefinedPermission(role.permissions);
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
      PERMISSIONS.VIEW_CUSTOMERS,
      PERMISSIONS.CREATE_CUSTOMERS,
      PERMISSIONS.EDIT_CUSTOMERS,
      PERMISSIONS.DELETE_CUSTOMERS,
      PERMISSIONS.MERGE_CUSTOMERS,
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
      PERMISSIONS.VIEW_COST_PRICE,
      PERMISSIONS.VIEW_COMMISSIONS,
      PERMISSIONS.MANAGE_COMMISSIONS,
      PERMISSIONS.APPROVE_REQUESTS,
      PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
      PERMISSIONS.CREATE_FINANCE_APPLICATION,
      PERMISSIONS.REVIEW_FINANCE_APPLICATION,
      PERMISSIONS.APPROVE_FINANCE_APPLICATION,
      PERMISSIONS.FINALIZE_FINANCED_DEAL,
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
      PERMISSIONS.VERIFY_FINANCE_DOCUMENTS,
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
      PERMISSIONS.VIEW_REPORTS,
      PERMISSIONS.VIEW_FINANCE,
      PERMISSIONS.MANAGE_FINANCE,
      PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ],
  },
];
