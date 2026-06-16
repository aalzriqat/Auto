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
import type * as approvals from "../approvals.js";
import type * as branches from "../branches.js";
import type * as claims from "../claims.js";
import type * as constants from "../constants.js";
import type * as crons from "../crons.js";
import type * as customers from "../customers.js";
import type * as dashboard from "../dashboard.js";
import type * as documents from "../documents.js";
import type * as email from "../email.js";
import type * as expenses from "../expenses.js";
import type * as feedback from "../feedback.js";
import type * as finance from "../finance.js";
import type * as fixedAssets from "../fixedAssets.js";
import type * as guarantors from "../guarantors.js";
import type * as http from "../http.js";
import type * as leads from "../leads.js";
import type * as memberships from "../memberships.js";
import type * as migrateRoles from "../migrateRoles.js";
import type * as migrations from "../migrations.js";
import type * as notifications from "../notifications.js";
import type * as orgCustomFields from "../orgCustomFields.js";
import type * as orgLeadSources from "../orgLeadSources.js";
import type * as orgPipelineStages from "../orgPipelineStages.js";
import type * as orgSettings from "../orgSettings.js";
import type * as orgValuationCompanies from "../orgValuationCompanies.js";
import type * as organizations from "../organizations.js";
import type * as partnerEquity from "../partnerEquity.js";
import type * as quotes from "../quotes.js";
import type * as rateLimit from "../rateLimit.js";
import type * as reports from "../reports.js";
import type * as roles from "../roles.js";
import type * as sales from "../sales.js";
import type * as seedDocuments from "../seedDocuments.js";
import type * as tasks from "../tasks.js";
import type * as test_drives from "../test_drives.js";
import type * as transactions from "../transactions.js";
import type * as users from "../users.js";
import type * as utils_commission from "../utils/commission.js";
import type * as utils_env from "../utils/env.js";
import type * as utils_errors from "../utils/errors.js";
import type * as utils_notifications from "../utils/notifications.js";
import type * as utils_permissions from "../utils/permissions.js";
import type * as utils_saleHelpers from "../utils/saleHelpers.js";
import type * as utils_tenancy from "../utils/tenancy.js";
import type * as utils_validation from "../utils/validation.js";
import type * as validations_customers from "../validations/customers.js";
import type * as validations_expenses from "../validations/expenses.js";
import type * as validations_sales from "../validations/sales.js";
import type * as validations_vehicles from "../validations/vehicles.js";
import type * as vehicleEdits from "../vehicleEdits.js";
import type * as vehicleRequests from "../vehicleRequests.js";
import type * as vehicles from "../vehicles.js";
import type * as whatsapp from "../whatsapp.js";
import type * as wizardDrafts from "../wizardDrafts.js";
import type * as workOrders from "../workOrders.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  applications: typeof applications;
  approvals: typeof approvals;
  branches: typeof branches;
  claims: typeof claims;
  constants: typeof constants;
  crons: typeof crons;
  customers: typeof customers;
  dashboard: typeof dashboard;
  documents: typeof documents;
  email: typeof email;
  expenses: typeof expenses;
  feedback: typeof feedback;
  finance: typeof finance;
  fixedAssets: typeof fixedAssets;
  guarantors: typeof guarantors;
  http: typeof http;
  leads: typeof leads;
  memberships: typeof memberships;
  migrateRoles: typeof migrateRoles;
  migrations: typeof migrations;
  notifications: typeof notifications;
  orgCustomFields: typeof orgCustomFields;
  orgLeadSources: typeof orgLeadSources;
  orgPipelineStages: typeof orgPipelineStages;
  orgSettings: typeof orgSettings;
  orgValuationCompanies: typeof orgValuationCompanies;
  organizations: typeof organizations;
  partnerEquity: typeof partnerEquity;
  quotes: typeof quotes;
  rateLimit: typeof rateLimit;
  reports: typeof reports;
  roles: typeof roles;
  sales: typeof sales;
  seedDocuments: typeof seedDocuments;
  tasks: typeof tasks;
  test_drives: typeof test_drives;
  transactions: typeof transactions;
  users: typeof users;
  "utils/commission": typeof utils_commission;
  "utils/env": typeof utils_env;
  "utils/errors": typeof utils_errors;
  "utils/notifications": typeof utils_notifications;
  "utils/permissions": typeof utils_permissions;
  "utils/saleHelpers": typeof utils_saleHelpers;
  "utils/tenancy": typeof utils_tenancy;
  "utils/validation": typeof utils_validation;
  "validations/customers": typeof validations_customers;
  "validations/expenses": typeof validations_expenses;
  "validations/sales": typeof validations_sales;
  "validations/vehicles": typeof validations_vehicles;
  vehicleEdits: typeof vehicleEdits;
  vehicleRequests: typeof vehicleRequests;
  vehicles: typeof vehicles;
  whatsapp: typeof whatsapp;
  wizardDrafts: typeof wizardDrafts;
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
