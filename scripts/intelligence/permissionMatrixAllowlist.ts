/**
 * Public Convex queries/mutations whose source shows NO permission argument
 * (SCRUM-616). Each entry says why that is acceptable TODAY. This is the
 * current state of the code, not an owner ruling about who SHOULD be allowed:
 * entries marked UNRULED are open questions, not approvals.
 *
 * The ratchet in permissionMatrix.test.ts keeps this list exact: a new export
 * with no permission argument fails until it is listed here with a reason, and
 * an entry whose function gained a permission (or was deleted) must be removed.
 * The list may only shrink in meaning, never grow silently.
 */
export type AllowEntry = { id: string; reason: string };

const SELF = "inferred self-scoped from the function name; body NOT individually read";
const PUBLIC = "inferred public/anonymous marketplace surface from the file name; body NOT individually read";
const STUB = "retired stub that throws/refuses before touching data";
const ORG_READ = "UNRULED: org-wide read open to any active member (no permission argument)";

/** guard === "none": nothing in the function text looks like an auth guard. */
export const NO_GUARD_ALLOWLIST: AllowEntry[] = [
  { id: "convex/accountingMigration.ts:migrateUnpostedTransactions", reason: STUB },
  { id: "convex/marketplaceAffordability.ts:getAffordabilityRange", reason: PUBLIC },
  { id: "convex/marketplaceBrowse.ts:search", reason: PUBLIC },
  { id: "convex/marketplaceBuyerPush.ts:registerBuyerPushToken", reason: PUBLIC },
  { id: "convex/marketplaceDealers.ts:listPublicDirectory", reason: PUBLIC },
  { id: "convex/marketplaceListings.ts:getMyListings", reason: "inline ctx.auth identity check, seller-scoped (read in body)" },
  { id: "convex/marketplaceListings.ts:getListingById", reason: "LIVE listings are public; non-LIVE only to owner/super-admin (read in body)" },
  { id: "convex/marketplaceRequests.ts:getStatusForBuyer", reason: PUBLIC },
  { id: "convex/marketplaceRequests.ts:getStatusForBuyerByPublicId", reason: PUBLIC },
  { id: "convex/marketplaceRequests.ts:getBuyerOffers", reason: PUBLIC },
  { id: "convex/marketplaceTradeIns.ts:getStatusForBuyer", reason: PUBLIC },
  { id: "convex/marketplaceTradeIns.ts:getStatusForBuyerByPublicId", reason: PUBLIC },
  { id: "convex/marketplaceTradeIns.ts:acceptOffer", reason: PUBLIC },
  { id: "convex/marketplaceTradeIns.ts:declineOffer", reason: PUBLIC },
  { id: "convex/marketplaceTradeIns.ts:acceptOfferByPublicId", reason: PUBLIC },
  { id: "convex/marketplaceTradeIns.ts:declineOfferByPublicId", reason: PUBLIC },
  { id: "convex/mobileReleases.ts:getLatestRelease", reason: PUBLIC },
  { id: "convex/organizations.ts:listMine", reason: SELF },
  { id: "convex/sales.ts:listCommissionsPaginated", reason: "delegates to commissionPage(), which calls requireTenantAuth with VIEW_COMMISSIONS (convex/sales.ts:1308)" },
  { id: "convex/subscriptions.ts:getPlans", reason: PUBLIC },
  { id: "convex/support.ts:submitContactMessage", reason: PUBLIC },
  { id: "convex/transactions.ts:add", reason: STUB },
  { id: "convex/transactions.ts:update", reason: STUB },
  { id: "convex/transactions.ts:remove", reason: STUB },
  { id: "convex/websites.ts:resolveDomain", reason: PUBLIC },
];

/** guard === "member": requireTenantAuth(ctx, org) only — any active member passes. */
export const MEMBER_ONLY_ALLOWLIST: AllowEntry[] = [
  { id: "convex/directMessages.ts:listConversations", reason: SELF },
  { id: "convex/directMessages.ts:getUnreadCount", reason: SELF },
  { id: "convex/directMessages.ts:getOrgMembers", reason: ORG_READ },
  { id: "convex/directMessages.ts:getOrCreateDm", reason: SELF },
  { id: "convex/directMessages.ts:createGroup", reason: SELF },
  { id: "convex/feedback.ts:submit", reason: SELF },
  { id: "convex/feedback.ts:myList", reason: SELF },
  { id: "convex/liveChat.ts:startOrGetMyThread", reason: SELF },
  { id: "convex/liveChat.ts:getMyThread", reason: SELF },
  { id: "convex/liveChat.ts:sendDealerMessage", reason: "thread must belong to the caller (dealerUserId check, read in body)" },
  { id: "convex/liveChat.ts:markThreadReadByDealer", reason: SELF },
  { id: "convex/liveChat.ts:setDealerTyping", reason: SELF },
  { id: "convex/liveChat.ts:updateDealerPresence", reason: SELF },
  { id: "convex/liveChat.ts:endThreadByDealer", reason: SELF },
  { id: "convex/liveChat.ts:getActiveOrgAccessGrant", reason: SELF },
  { id: "convex/liveChat.ts:getThreadMessages", reason: SELF },
  { id: "convex/memberships.ts:getMyMembership", reason: SELF },
  { id: "convex/memberships.ts:touchLastSeen", reason: SELF },
  { id: "convex/notificationPreferences.ts:getMyPreferences", reason: SELF },
  { id: "convex/notificationPreferences.ts:setPreference", reason: SELF },
  { id: "convex/notifications.ts:list", reason: SELF },
  { id: "convex/notifications.ts:unreadCount", reason: SELF },
  { id: "convex/notifications.ts:listPage", reason: SELF },
  { id: "convex/notifications.ts:markAsRead", reason: SELF },
  { id: "convex/notifications.ts:markAllAsRead", reason: SELF },
  { id: "convex/notifications.ts:archive", reason: SELF },
  { id: "convex/orgCustomFields.ts:list", reason: ORG_READ },
  { id: "convex/orgCustomFields.ts:getValues", reason: ORG_READ },
  { id: "convex/orgCustomFields.ts:setValues", reason: "UNRULED, reproduced: a view-only member can write custom-field values — SCRUM-790" },
  { id: "convex/orgPipelineStages.ts:list", reason: ORG_READ },
  { id: "convex/organizations.ts:get", reason: ORG_READ },
  { id: "convex/pushSubscriptions.ts:subscribe", reason: SELF },
  { id: "convex/pushSubscriptions.ts:unsubscribe", reason: SELF },
  { id: "convex/pushSubscriptions.ts:listMyDevices", reason: SELF },
  { id: "convex/pushSubscriptions.ts:disableDevice", reason: SELF },
  { id: "convex/subscriptions.ts:getMySubscription", reason: ORG_READ },
  { id: "convex/subscriptions.ts:getUsageStats", reason: ORG_READ },
  { id: "convex/subscriptions.ts:getShowPricing", reason: ORG_READ },
  { id: "convex/vehicleEdits.ts:getHistory", reason: ORG_READ },
  { id: "convex/wizardDrafts.ts:getMyDraft", reason: SELF },
  { id: "convex/wizardDrafts.ts:saveDraft", reason: SELF },
  { id: "convex/wizardDrafts.ts:clearDraft", reason: SELF },
];

/** guard === "inline": no permission argument, but the function names PERMISSIONS.* itself. */
export const INLINE_ALLOWLIST: AllowEntry[] = [
  { id: "convex/applications.ts:registerExpectedPayment", reason: "body references REGISTER_EXPECTED_PAYMENT / MANAGE_FINANCE (seen in a grep); the check itself NOT individually read" },
  { id: "convex/dashboard.ts:stats", reason: "PERMISSIONS.* referenced in the body; filtering NOT individually read" },
  { id: "convex/dashboard.ts:dataQualityStats", reason: "PERMISSIONS.* referenced in the body; filtering NOT individually read" },
  { id: "convex/documents.ts:listRules", reason: "PERMISSIONS.* is referenced in the body; the check itself NOT individually read" },
  { id: "convex/documents.ts:ensureApplicationDocument", reason: "PERMISSIONS.* is referenced in the body; the check itself NOT individually read" },
  { id: "convex/documents.ts:generateUploadUrl", reason: "PERMISSIONS.* is referenced in the body; the check itself NOT individually read" },
  { id: "convex/documents.ts:saveDocumentFile", reason: "PERMISSIONS.* is referenced in the body; the check itself NOT individually read" },
  { id: "convex/facebookIntegrations.ts:disconnect", reason: "PERMISSIONS.* is referenced in the body; the check itself NOT individually read" },
  { id: "convex/search.ts:globalSearch", reason: "PERMISSIONS.* referenced in the body; filtering NOT individually read" },
];
