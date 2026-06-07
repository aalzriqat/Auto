/**
 * Bloom Cars Permission System
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
  EDIT_VEHICLES: "edit:vehicles",
  DELETE_VEHICLES: "delete:vehicles",

  // Customers
  VIEW_CUSTOMERS: "view:customers",
  CREATE_CUSTOMERS: "create:customers",
  EDIT_CUSTOMERS: "edit:customers",
  DELETE_CUSTOMERS: "delete:customers",

  // Leads
  VIEW_LEADS: "view:leads",
  CREATE_LEADS: "create:leads",
  EDIT_LEADS: "edit:leads",
  DELETE_LEADS: "delete:leads",

  // Sales
  VIEW_SALES: "view:sales",
  CREATE_SALES: "create:sales",
  EDIT_SALES: "edit:sales",
  DELETE_SALES: "delete:sales",

  // Expenses
  VIEW_EXPENSES: "view:expenses",
  CREATE_EXPENSES: "create:expenses",
  EDIT_EXPENSES: "edit:expenses",
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
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** All defined permission values as an array — useful for the OWNER role. */
export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/**
 * Default role templates seeded when a new organization is created.
 * Each org gets its own copy in the database so they can be customized later.
 */
export const DEFAULT_ROLE_TEMPLATES: { name: string; permissions: Permission[] }[] = [
  {
    name: "OWNER",
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
      PERMISSIONS.VIEW_SETTINGS,
      PERMISSIONS.MANAGE_SETTINGS,
    ],
  },
  {
    name: "SALES",
    permissions: [
      PERMISSIONS.VIEW_ORG,
      PERMISSIONS.VIEW_USERS,
      PERMISSIONS.VIEW_VEHICLES,
      PERMISSIONS.VIEW_CUSTOMERS,
      PERMISSIONS.CREATE_CUSTOMERS,
      PERMISSIONS.EDIT_CUSTOMERS,
      PERMISSIONS.VIEW_LEADS,
      PERMISSIONS.CREATE_LEADS,
      PERMISSIONS.EDIT_LEADS,
      PERMISSIONS.VIEW_SALES,
      PERMISSIONS.CREATE_SALES,
      PERMISSIONS.VIEW_TASKS,
      PERMISSIONS.CREATE_TASKS,
      PERMISSIONS.EDIT_TASKS,
    ],
  },
  {
    name: "RECEPTION",
    permissions: [
      PERMISSIONS.VIEW_ORG,
      PERMISSIONS.VIEW_USERS,
      PERMISSIONS.VIEW_VEHICLES,
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
      PERMISSIONS.VIEW_CUSTOMERS,
      PERMISSIONS.VIEW_SALES,
      PERMISSIONS.VIEW_EXPENSES,
      PERMISSIONS.VIEW_REPORTS,
    ],
  },
];
