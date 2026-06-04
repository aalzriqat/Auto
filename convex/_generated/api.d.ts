/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as customers from "../customers.js";
import type * as dashboard from "../dashboard.js";
import type * as expenses from "../expenses.js";
import type * as http from "../http.js";
import type * as leads from "../leads.js";
import type * as memberships from "../memberships.js";
import type * as migrations from "../migrations.js";
import type * as organizations from "../organizations.js";
import type * as roles from "../roles.js";
import type * as sales from "../sales.js";
import type * as tasks from "../tasks.js";
import type * as users from "../users.js";
import type * as utils_permissions from "../utils/permissions.js";
import type * as utils_tenancy from "../utils/tenancy.js";
import type * as vehicles from "../vehicles.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  customers: typeof customers;
  dashboard: typeof dashboard;
  expenses: typeof expenses;
  http: typeof http;
  leads: typeof leads;
  memberships: typeof memberships;
  migrations: typeof migrations;
  organizations: typeof organizations;
  roles: typeof roles;
  sales: typeof sales;
  tasks: typeof tasks;
  users: typeof users;
  "utils/permissions": typeof utils_permissions;
  "utils/tenancy": typeof utils_tenancy;
  vehicles: typeof vehicles;
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

export declare const components: {};
