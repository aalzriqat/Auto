/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as applications from "../applications.js";
import type * as branches from "../branches.js";
import type * as claims from "../claims.js";
import type * as crons from "../crons.js";
import type * as customers from "../customers.js";
import type * as dashboard from "../dashboard.js";
import type * as debug from "../debug.js";
import type * as documents from "../documents.js";
import type * as email from "../email.js";
import type * as expenses from "../expenses.js";
import type * as finance from "../finance.js";
import type * as fixedAssets from "../fixedAssets.js";
import type * as guarantors from "../guarantors.js";
import type * as http from "../http.js";
import type * as leads from "../leads.js";
import type * as memberships from "../memberships.js";
import type * as migrateRoles from "../migrateRoles.js";
import type * as migrations from "../migrations.js";
import type * as notifications from "../notifications.js";
import type * as organizations from "../organizations.js";
import type * as partnerEquity from "../partnerEquity.js";
import type * as quotes from "../quotes.js";
import type * as rateLimit from "../rateLimit.js";
import type * as reports from "../reports.js";
import type * as roles from "../roles.js";
import type * as sales from "../sales.js";
import type * as tasks from "../tasks.js";
import type * as test_drives from "../test_drives.js";
import type * as transactions from "../transactions.js";
import type * as users from "../users.js";
import type * as utils_notifications from "../utils/notifications.js";
import type * as utils_permissions from "../utils/permissions.js";
import type * as utils_tenancy from "../utils/tenancy.js";
import type * as vehicleEdits from "../vehicleEdits.js";
import type * as vehicleRequests from "../vehicleRequests.js";
import type * as vehicles from "../vehicles.js";
import type * as workOrders from "../workOrders.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  applications: typeof applications;
  branches: typeof branches;
  claims: typeof claims;
  crons: typeof crons;
  customers: typeof customers;
  dashboard: typeof dashboard;
  debug: typeof debug;
  documents: typeof documents;
  email: typeof email;
  expenses: typeof expenses;
  finance: typeof finance;
  fixedAssets: typeof fixedAssets;
  guarantors: typeof guarantors;
  http: typeof http;
  leads: typeof leads;
  memberships: typeof memberships;
  migrateRoles: typeof migrateRoles;
  migrations: typeof migrations;
  notifications: typeof notifications;
  organizations: typeof organizations;
  partnerEquity: typeof partnerEquity;
  quotes: typeof quotes;
  rateLimit: typeof rateLimit;
  reports: typeof reports;
  roles: typeof roles;
  sales: typeof sales;
  tasks: typeof tasks;
  test_drives: typeof test_drives;
  transactions: typeof transactions;
  users: typeof users;
  "utils/notifications": typeof utils_notifications;
  "utils/permissions": typeof utils_permissions;
  "utils/tenancy": typeof utils_tenancy;
  vehicleEdits: typeof vehicleEdits;
  vehicleRequests: typeof vehicleRequests;
  vehicles: typeof vehicles;
  workOrders: typeof workOrders;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
