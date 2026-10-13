/**
 * Public Convex queries / mutations / actions whose OWN handler shows no
 * permission argument (SCRUM-616). Each entry says why that is acceptable
 * TODAY. This is the current state of the code, not an owner ruling about who
 * SHOULD be allowed: entries marked UNRULED are open questions, not approvals.
 *
 * Reasons say how much was actually checked. "NOT individually read" means the
 * reason is inferred from the name or file and nobody has opened the body.
 *
 * permissionMatrix.test.ts keeps every list exact: a new export with no
 * permission argument fails until it is listed here with a reason, and an entry
 * whose function gained a permission (or was deleted) must be removed.
 */
export type AllowEntry = { id: string; reason: string };

const entries = (reason: string, ids: string[]): AllowEntry[] => ids.map((id) => ({ id, reason }));

const SELF = "inferred self-scoped from the function name; body NOT individually read";
const PUBLIC = "inferred public/anonymous marketplace or website surface from the file name; body NOT individually read";
const ACTION = "action: any guard runs in the function it calls via ctx.run*; body NOT individually read";
const STUB = "retired stub that refuses before touching data (read)";
const ORG_READ = "UNRULED: org-wide read open to any active member (no permission argument)";

/** guard === "none": nothing in the function's own handler looks like an auth guard. */
export const NO_GUARD_ALLOWLIST: AllowEntry[] = [
  ...entries(STUB, [
    "convex/accountingMigration.ts:migrateUnpostedTransactions",
    "convex/transactions.ts:add",
    "convex/transactions.ts:update",
    "convex/transactions.ts:remove",
  ]),
  ...entries(PUBLIC, [
    "convex/marketplaceAffordability.ts:getAffordabilityRange",
    "convex/marketplaceBrowse.ts:search",
    "convex/marketplaceBuyerPush.ts:registerBuyerPushToken",
    "convex/marketplaceDealers.ts:listPublicDirectory",
    "convex/marketplaceRequests.ts:getStatusForBuyer",
    "convex/marketplaceRequests.ts:getStatusForBuyerByPublicId",
    "convex/marketplaceRequests.ts:getBuyerOffers",
    "convex/marketplaceRequests.ts:submitRequest",
    "convex/marketplaceTradeIns.ts:getStatusForBuyer",
    "convex/marketplaceTradeIns.ts:getStatusForBuyerByPublicId",
    "convex/marketplaceTradeIns.ts:declineOffer",
    "convex/marketplaceTradeIns.ts:acceptOfferByPublicId",
    "convex/marketplaceTradeIns.ts:declineOfferByPublicId",
    "convex/marketplaceTradeIns.ts:submitTradeInRequest",
    "convex/mobileReleases.ts:getLatestRelease",
    "convex/subscriptions.ts:getPlans",
    "convex/support.ts:submitContactMessage",
    "convex/websites.ts:resolveDomain",
    "convex/websites.ts:submitPublicLead",
  ]),
  ...entries("inferred public buyer-side live chat from the function name; body NOT individually read", [
    "convex/liveChat.ts:startOrGetLeadThread",
    "convex/liveChat.ts:getLeadThread",
    "convex/liveChat.ts:getLeadThreadMessages",
    "convex/liveChat.ts:sendLeadMessage",
    "convex/liveChat.ts:markLeadThreadRead",
    "convex/liveChat.ts:setLeadTyping",
    "convex/liveChat.ts:updateLeadPresence",
    "convex/liveChat.ts:endThreadByLead",
  ]),
  ...entries(ACTION, [
    "convex/adminUsers.ts:deleteUser",
    "convex/facebookEngagement.ts:replyToFacebookComment",
    "convex/facebookEngagement.ts:sendFacebookDirectMessage",
    "convex/facebookEngagement.ts:fetchFbConversationHistory",
    "convex/facebookIntegrations.ts:selectFacebookPage",
    "convex/instagramEngagement.ts:replyToInstagramComment",
    "convex/instagramEngagement.ts:sendInstagramDirectMessage",
    "convex/memberships.ts:remove",
    "convex/memberships.ts:createAccount",
    "convex/memberships.ts:checkEmailExists",
    "convex/socialEngagement.ts:refreshEngagement",
    "convex/socialEngagement.ts:listComments",
    "convex/socialEngagement.ts:replyToComment",
    "convex/socialEngagement.ts:setCommentHidden",
    "convex/socialInboxBackfill.ts:resyncEvents",
    "convex/socialInboxBackfill.ts:resyncContactNames",
    "convex/support.ts:sendReply",
  ]),
  { id: "convex/prepaidExpenses.ts:runAmortizationNow", reason: "action delegating to listActiveForManualRun, which requires MANAGE_FINANCE (read by the PR #512 reviewer, prepaidExpenses.ts:556)" },
  { id: "convex/subscriptions.ts:requestUpgrade", reason: "action delegating to _requireMemberOrg, which is member-only (requireTenantAuth with no permission; read by the PR #512 reviewer, subscriptions.ts:731)" },
  { id: "convex/organizations.ts:listMine", reason: SELF },
  { id: "convex/marketplaceListings.ts:getMyListings", reason: "inline ctx.auth identity check, seller-scoped (read)" },
  { id: "convex/marketplaceListings.ts:getListingById", reason: "LIVE listings are public; non-LIVE only to the owner or a super-admin (read)" },
  { id: "convex/marketplaceTradeIns.ts:acceptOffer", reason: "gated by offer id plus buyer phone, no login (read by the reviewer)" },
  { id: "convex/sales.ts:listCommissionsPaginated", reason: "delegates to commissionPage(), which calls requireTenantAuth with VIEW_COMMISSIONS (convex/sales.ts:1308, read)" },
  { id: "convex/dealWorkspace.ts:financedDealCockpit", reason: "authorization delegated to api.applications.dealCockpit through ctx.runQuery (documented at dealWorkspace.ts:124), plus its own requireOwnedRow (read)" },
  { id: "convex/subscriptions.ts:getShowPricing", reason: "no guard at all; returns a global display flag (reviewer-read). Harmless today, listed so it cannot grow silently" },
  ...entries("UNRULED: unauthenticated mutation gated by a public id (allowContact and acceptOffer also by the buyer's phone); those two create a lead in a dealer's pipeline (reviewer-read, marketplaceBuyerActions.ts:126-179)", [
    "convex/marketplaceBuyerActions.ts:shortlistOffer",
    "convex/marketplaceBuyerActions.ts:declineOffer",
    "convex/marketplaceBuyerActions.ts:allowContact",
    "convex/marketplaceBuyerActions.ts:acceptOffer",
  ]),
];

/** guard === "member": requireTenantAuth(ctx, org) only — any active member passes. */
export const MEMBER_ONLY_ALLOWLIST: AllowEntry[] = [
  ...entries(SELF, [
    "convex/directMessages.ts:listConversations",
    "convex/directMessages.ts:getUnreadCount",
    "convex/directMessages.ts:getOrCreateDm",
    "convex/feedback.ts:submit",
    "convex/feedback.ts:myList",
    "convex/liveChat.ts:startOrGetMyThread",
    "convex/liveChat.ts:getMyThread",
    "convex/liveChat.ts:markThreadReadByDealer",
    "convex/liveChat.ts:setDealerTyping",
    "convex/liveChat.ts:updateDealerPresence",
    "convex/liveChat.ts:endThreadByDealer",
    "convex/liveChat.ts:getActiveOrgAccessGrant",
    "convex/memberships.ts:getMyMembership",
    "convex/memberships.ts:touchLastSeen",
    "convex/notificationPreferences.ts:getMyPreferences",
    "convex/notificationPreferences.ts:setPreference",
    "convex/notifications.ts:list",
    "convex/notifications.ts:unreadCount",
    "convex/notifications.ts:listPage",
    "convex/notifications.ts:markAsRead",
    "convex/notifications.ts:markAllAsRead",
    "convex/notifications.ts:archive",
    "convex/pushSubscriptions.ts:subscribe",
    "convex/pushSubscriptions.ts:unsubscribe",
    "convex/pushSubscriptions.ts:listMyDevices",
    "convex/pushSubscriptions.ts:disableDevice",
    "convex/wizardDrafts.ts:getMyDraft",
    "convex/wizardDrafts.ts:saveDraft",
    "convex/wizardDrafts.ts:clearDraft",
  ]),
  { id: "convex/directMessages.ts:createGroup", reason: "creator-scoped group chat (read by the reviewer)" },
  { id: "convex/liveChat.ts:sendDealerMessage", reason: "thread must belong to the caller (dealerUserId check, read)" },
  { id: "convex/memberships.ts:leave", reason: "self-service leave: member-only by design (reviewer read memberships.ts:919)" },
  ...entries(ORG_READ, [
    "convex/directMessages.ts:getOrgMembers",
    "convex/orgCustomFields.ts:list",
    "convex/orgCustomFields.ts:getValues",
    "convex/orgPipelineStages.ts:list",
    "convex/organizations.ts:get",
    "convex/subscriptions.ts:getMySubscription",
    "convex/subscriptions.ts:getUsageStats",
    "convex/vehicleEdits.ts:getHistory",
  ]),
];

/** guard === "inline": no permission argument, but the handler reads PERMISSIONS.* itself. */
export const INLINE_ALLOWLIST: AllowEntry[] = [
  { id: "convex/applications.ts:registerExpectedPayment", reason: "reads REGISTER_EXPECTED_PAYMENT / MANAGE_FINANCE after auth (inline check at applications.ts:4160-4168, read by the reviewer)" },
  ...entries("PERMISSIONS.* is read inside the handler; the check itself NOT individually read", [
    "convex/dashboard.ts:stats",
    "convex/dashboard.ts:dataQualityStats",
    "convex/documents.ts:listRules",
    "convex/documents.ts:ensureApplicationDocument",
    "convex/documents.ts:generateUploadUrl",
    "convex/documents.ts:saveDocumentFile",
    "convex/search.ts:globalSearch",
  ]),
];

/** guard === "authed": any signed-in user of ANY organization passes (requireAuth only). */
export const AUTHED_ONLY_ALLOWLIST: AllowEntry[] = [
  ...entries("inferred public/product-wide content from the name; body NOT individually read", [
    "convex/changelog.ts:list",
    "convex/changelog.ts:getLatestPublishedAt",
  ]),
  ...entries("conversation-participant scoped per the reviewer; whether offboarding removes a user from their conversations is UNRESOLVED", [
    "convex/directMessages.ts:listMessages",
    "convex/directMessages.ts:getConversation",
    "convex/directMessages.ts:sendMessage",
    "convex/directMessages.ts:markDelivered",
    "convex/directMessages.ts:markRead",
    "convex/directMessages.ts:setTyping",
    "convex/directMessages.ts:setMuted",
  ]),
  ...entries("marketplace seller surface (not tenant data); seller-scoping inferred, body NOT individually read", [
    "convex/marketplaceListings.ts:generateListingImageUploadUrl",
    "convex/marketplaceListings.ts:confirmListingImageUpload",
    "convex/marketplaceListings.ts:createListing",
    "convex/marketplaceListings.ts:updateListing",
    "convex/marketplaceListings.ts:softDeleteListing",
    "convex/marketplaceListings.ts:markListingSold",
  ]),
  ...entries(SELF, [
    "convex/mobilePushTokens.ts:register",
    "convex/mobilePushTokens.ts:remove",
    "convex/users.ts:getMe",
    "convex/users.ts:updateMyNotificationProfile",
    "convex/memberships.ts:acceptInvitation",
    "convex/organizations.ts:create",
  ]),
  { id: "convex/users.ts:getUser", reason: "UNRULED, low: any signed-in user of any org can read any user's display name by id (read, users.ts:25-33); returns the name only" },
];
