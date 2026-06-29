/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountingLedger from "../accountingLedger.js";
import type * as accountingPeriods from "../accountingPeriods.js";
import type * as accountingReports from "../accountingReports.js";
import type * as accounting_postingEngine from "../accounting/postingEngine.js";
import type * as accounting_postingRules from "../accounting/postingRules.js";
import type * as accounting_reversals from "../accounting/reversals.js";
import type * as accounting_workflowHooks from "../accounting/workflowHooks.js";
import type * as adminAudit from "../adminAudit.js";
import type * as adminAuth from "../adminAuth.js";
import type * as adminBroadcasts from "../adminBroadcasts.js";
import type * as adminData from "../adminData.js";
import type * as adminImpersonation from "../adminImpersonation.js";
import type * as adminOrgs from "../adminOrgs.js";
import type * as adminSupportAgents from "../adminSupportAgents.js";
import type * as adminSystem from "../adminSystem.js";
import type * as adminUsers from "../adminUsers.js";
import type * as applications from "../applications.js";
import type * as approvals from "../approvals.js";
import type * as branches from "../branches.js";
import type * as chartOfAccounts from "../chartOfAccounts.js";
import type * as claims from "../claims.js";
import type * as collectionReminderActions from "../collectionReminderActions.js";
import type * as collections from "../collections.js";
import type * as constants from "../constants.js";
import type * as crons from "../crons.js";
import type * as customers from "../customers.js";
import type * as dashboard from "../dashboard.js";
import type * as deposits from "../deposits.js";
import type * as directMessages from "../directMessages.js";
import type * as documents from "../documents.js";
import type * as domainRegistrar from "../domainRegistrar.js";
import type * as email from "../email.js";
import type * as expenses from "../expenses.js";
import type * as facebookEngagement from "../facebookEngagement.js";
import type * as facebookIntegrations from "../facebookIntegrations.js";
import type * as facebookPosting from "../facebookPosting.js";
import type * as feedback from "../feedback.js";
import type * as finance from "../finance.js";
import type * as fixedAssets from "../fixedAssets.js";
import type * as guarantors from "../guarantors.js";
import type * as http from "../http.js";
import type * as importMappings from "../importMappings.js";
import type * as instagramEngagement from "../instagramEngagement.js";
import type * as leads from "../leads.js";
import type * as liveChat from "../liveChat.js";
import type * as memberships from "../memberships.js";
import type * as migrateRoles from "../migrateRoles.js";
import type * as migrations from "../migrations.js";
import type * as notificationPreferences from "../notificationPreferences.js";
import type * as notifications from "../notifications.js";
import type * as orgCustomFields from "../orgCustomFields.js";
import type * as orgCustomerStatuses from "../orgCustomerStatuses.js";
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
import type * as search from "../search.js";
import type * as seedDocuments from "../seedDocuments.js";
import type * as smartReply from "../smartReply.js";
import type * as socialEngagement from "../socialEngagement.js";
import type * as socialInbox from "../socialInbox.js";
import type * as socialInboxBackfill from "../socialInboxBackfill.js";
import type * as socialIntegrations from "../socialIntegrations.js";
import type * as socialPosting from "../socialPosting.js";
import type * as socialPostingData from "../socialPostingData.js";
import type * as subledger from "../subledger.js";
import type * as subscriptions from "../subscriptions.js";
import type * as support from "../support.js";
import type * as supportAgentAuth from "../supportAgentAuth.js";
import type * as tasks from "../tasks.js";
import type * as test_drives from "../test_drives.js";
import type * as transactions from "../transactions.js";
import type * as users from "../users.js";
import type * as utils_auditLog from "../utils/auditLog.js";
import type * as utils_commission from "../utils/commission.js";
import type * as utils_dedup from "../utils/dedup.js";
import type * as utils_defaultChart from "../utils/defaultChart.js";
import type * as utils_depositHelpers from "../utils/depositHelpers.js";
import type * as utils_env from "../utils/env.js";
import type * as utils_errors from "../utils/errors.js";
import type * as utils_facebookApi from "../utils/facebookApi.js";
import type * as utils_financialGuards from "../utils/financialGuards.js";
import type * as utils_idempotency from "../utils/idempotency.js";
import type * as utils_instagramApi from "../utils/instagramApi.js";
import type * as utils_leadAssignment from "../utils/leadAssignment.js";
import type * as utils_leadStageHelpers from "../utils/leadStageHelpers.js";
import type * as utils_mergeHelpers from "../utils/mergeHelpers.js";
import type * as utils_money from "../utils/money.js";
import type * as utils_notifications from "../utils/notifications.js";
import type * as utils_permissions from "../utils/permissions.js";
import type * as utils_saleCompletion from "../utils/saleCompletion.js";
import type * as utils_saleHelpers from "../utils/saleHelpers.js";
import type * as utils_smartReplyBuilder from "../utils/smartReplyBuilder.js";
import type * as utils_smartReplyIntent from "../utils/smartReplyIntent.js";
import type * as utils_socialAutoPost from "../utils/socialAutoPost.js";
import type * as utils_socialMobile from "../utils/socialMobile.js";
import type * as utils_socialMobileReply from "../utils/socialMobileReply.js";
import type * as utils_tenancy from "../utils/tenancy.js";
import type * as utils_validation from "../utils/validation.js";
import type * as utils_vehicleTextMatch from "../utils/vehicleTextMatch.js";
import type * as validations_customers from "../validations/customers.js";
import type * as validations_expenses from "../validations/expenses.js";
import type * as validations_sales from "../validations/sales.js";
import type * as validations_vehicles from "../validations/vehicles.js";
import type * as vehicleEdits from "../vehicleEdits.js";
import type * as vehicleRequests from "../vehicleRequests.js";
import type * as vehicles from "../vehicles.js";
import type * as websiteConfig from "../websiteConfig.js";
import type * as websiteProjection from "../websiteProjection.js";
import type * as websites from "../websites.js";
import type * as whatsapp from "../whatsapp.js";
import type * as whatsappSend from "../whatsappSend.js";
import type * as wizardDrafts from "../wizardDrafts.js";
import type * as workOrders from "../workOrders.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountingLedger: typeof accountingLedger;
  accountingPeriods: typeof accountingPeriods;
  accountingReports: typeof accountingReports;
  "accounting/postingEngine": typeof accounting_postingEngine;
  "accounting/postingRules": typeof accounting_postingRules;
  "accounting/reversals": typeof accounting_reversals;
  "accounting/workflowHooks": typeof accounting_workflowHooks;
  adminAudit: typeof adminAudit;
  adminAuth: typeof adminAuth;
  adminBroadcasts: typeof adminBroadcasts;
  adminData: typeof adminData;
  adminImpersonation: typeof adminImpersonation;
  adminOrgs: typeof adminOrgs;
  adminSupportAgents: typeof adminSupportAgents;
  adminSystem: typeof adminSystem;
  adminUsers: typeof adminUsers;
  applications: typeof applications;
  approvals: typeof approvals;
  branches: typeof branches;
  chartOfAccounts: typeof chartOfAccounts;
  claims: typeof claims;
  collectionReminderActions: typeof collectionReminderActions;
  collections: typeof collections;
  constants: typeof constants;
  crons: typeof crons;
  customers: typeof customers;
  dashboard: typeof dashboard;
  deposits: typeof deposits;
  directMessages: typeof directMessages;
  documents: typeof documents;
  domainRegistrar: typeof domainRegistrar;
  email: typeof email;
  expenses: typeof expenses;
  facebookEngagement: typeof facebookEngagement;
  facebookIntegrations: typeof facebookIntegrations;
  facebookPosting: typeof facebookPosting;
  feedback: typeof feedback;
  finance: typeof finance;
  fixedAssets: typeof fixedAssets;
  guarantors: typeof guarantors;
  http: typeof http;
  importMappings: typeof importMappings;
  instagramEngagement: typeof instagramEngagement;
  leads: typeof leads;
  liveChat: typeof liveChat;
  memberships: typeof memberships;
  migrateRoles: typeof migrateRoles;
  migrations: typeof migrations;
  notificationPreferences: typeof notificationPreferences;
  notifications: typeof notifications;
  orgCustomFields: typeof orgCustomFields;
  orgCustomerStatuses: typeof orgCustomerStatuses;
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
  search: typeof search;
  seedDocuments: typeof seedDocuments;
  smartReply: typeof smartReply;
  socialEngagement: typeof socialEngagement;
  socialInbox: typeof socialInbox;
  socialInboxBackfill: typeof socialInboxBackfill;
  socialIntegrations: typeof socialIntegrations;
  socialPosting: typeof socialPosting;
  socialPostingData: typeof socialPostingData;
  subledger: typeof subledger;
  subscriptions: typeof subscriptions;
  support: typeof support;
  supportAgentAuth: typeof supportAgentAuth;
  tasks: typeof tasks;
  test_drives: typeof test_drives;
  transactions: typeof transactions;
  users: typeof users;
  "utils/auditLog": typeof utils_auditLog;
  "utils/commission": typeof utils_commission;
  "utils/dedup": typeof utils_dedup;
  "utils/defaultChart": typeof utils_defaultChart;
  "utils/depositHelpers": typeof utils_depositHelpers;
  "utils/env": typeof utils_env;
  "utils/errors": typeof utils_errors;
  "utils/facebookApi": typeof utils_facebookApi;
  "utils/financialGuards": typeof utils_financialGuards;
  "utils/idempotency": typeof utils_idempotency;
  "utils/instagramApi": typeof utils_instagramApi;
  "utils/leadAssignment": typeof utils_leadAssignment;
  "utils/leadStageHelpers": typeof utils_leadStageHelpers;
  "utils/mergeHelpers": typeof utils_mergeHelpers;
  "utils/money": typeof utils_money;
  "utils/notifications": typeof utils_notifications;
  "utils/permissions": typeof utils_permissions;
  "utils/saleCompletion": typeof utils_saleCompletion;
  "utils/saleHelpers": typeof utils_saleHelpers;
  "utils/smartReplyBuilder": typeof utils_smartReplyBuilder;
  "utils/smartReplyIntent": typeof utils_smartReplyIntent;
  "utils/socialAutoPost": typeof utils_socialAutoPost;
  "utils/socialMobile": typeof utils_socialMobile;
  "utils/socialMobileReply": typeof utils_socialMobileReply;
  "utils/tenancy": typeof utils_tenancy;
  "utils/validation": typeof utils_validation;
  "utils/vehicleTextMatch": typeof utils_vehicleTextMatch;
  "validations/customers": typeof validations_customers;
  "validations/expenses": typeof validations_expenses;
  "validations/sales": typeof validations_sales;
  "validations/vehicles": typeof validations_vehicles;
  vehicleEdits: typeof vehicleEdits;
  vehicleRequests: typeof vehicleRequests;
  vehicles: typeof vehicles;
  websiteConfig: typeof websiteConfig;
  websiteProjection: typeof websiteProjection;
  websites: typeof websites;
  whatsapp: typeof whatsapp;
  whatsappSend: typeof whatsappSend;
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
