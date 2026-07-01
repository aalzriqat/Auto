import { v, ConvexError } from "convex/values";
import { action, mutation, query, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOwner, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { getValidatedEnv } from "./utils/env";
import { DEFAULT_SETTINGS } from "./orgSettings";
import { requireFeature } from "./subscriptions";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FACEBOOK_GRAPH_VERSION = "v25.0";

// Facebook Login for Pages: authenticates a person, who may manage several
// Pages. Unlike Instagram Login (whose token exchange returns the IG
// Business Account directly), this requires a follow-up /me/accounts call
// to list the person's Pages and their individual Page Access Tokens.
//
// pages_manage_metadata is required for Page "feed" webhooks (comments) to
// be delivered at all — confirmed via Meta's Page Webhooks docs 2026-06-22,
// distinct from pages_manage_engagement (which only covers replying to/
// moderating comments, not receiving the webhook events themselves). This
// is the Facebook-side equivalent of the missing-scope webhook silent-
// failure already hit once on the Instagram integration.
// business_management is required for /me/accounts to list Pages whose
// access comes from a Business Manager assignment rather than a classic
// personal Page role — without it, /me/accounts silently returns an empty
// list for Business-owned Pages even when the user has Full Access there.
const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_manage_posts",
  "pages_manage_engagement",
  "pages_messaging",
  "pages_read_engagement",
  "pages_read_user_content",
  "business_management",
].join(",");

// ─── Public ───────────────────────────────────────────────────────────────────

/**
 * Generates a CSRF state token and returns the Facebook OAuth dialog URL the
 * client redirects the browser to. Owner-only — only the org owner can
 * connect a social account.
 */
export const createConnectUrl = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    await requireFeature(ctx, args.orgId, "socialInbox");

    const env = getValidatedEnv();
    if (!env.FACEBOOK_APP_ID) {
      throw new ConvexError("Facebook integration is not configured for this deployment.");
    }
    if (!env.CONVEX_SITE_URL) {
      throw new ConvexError("CONVEX_SITE_URL is unavailable — cannot build the OAuth redirect URI.");
    }

    const state = crypto.randomUUID();
    const now = Date.now();
    await ctx.db.insert("oauthStates", {
      orgId: args.orgId,
      state,
      provider: "facebook",
      createdAt: now,
      expiresAt: now + OAUTH_STATE_TTL_MS,
    });

    const redirectUri = `${env.CONVEX_SITE_URL}/facebook-oauth-callback`;
    const url = new URL(`https://www.facebook.com/${FACEBOOK_GRAPH_VERSION}/dialog/oauth`);
    url.searchParams.set("client_id", env.FACEBOOK_APP_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", FACEBOOK_SCOPES);
    url.searchParams.set("response_type", "code");

    return url.toString();
  },
});

/**
 * Connection status for the Integrations settings page. Never exposes the
 * raw Page access token to the client.
 */
export const getConnectionStatus = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SETTINGS]);
    await requireFeature(ctx, args.orgId, "socialInbox");

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    return {
      facebookConnected: Boolean(settings?.facebookPageAccessToken && settings?.facebookPageId),
      facebookPageName: settings?.facebookPageName,
      facebookAvailablePages: settings?.facebookAvailablePages ?? [],
      facebookAutoReplyEnabled: settings?.facebookAutoReplyEnabled ?? false,
      facebookAutoReplyForDmsEnabled: settings?.facebookAutoReplyForDmsEnabled ?? settings?.facebookAutoReplyEnabled ?? false,
      facebookAutoReplyForCommentsEnabled: settings?.facebookAutoReplyForCommentsEnabled ?? settings?.facebookAutoReplyEnabled ?? false,
      facebookAutoReplyMessages: settings?.facebookAutoReplyMessages ?? [],
      facebookAutoReplyMobileReceivedMessage: settings?.facebookAutoReplyMobileReceivedMessage,
      facebookLeadFromCommentsEnabled: settings?.facebookLeadFromCommentsEnabled !== false,
      facebookLeadFromDmsEnabled: settings?.facebookLeadFromDmsEnabled !== false,
      facebookLeadFromDmsRequiresMobile: settings?.facebookLeadFromDmsRequiresMobile ?? false,
      facebookSmartReplyEnabled: settings?.facebookSmartReplyEnabled ?? false,
      facebookSmartReplyForDmsEnabled: settings?.facebookSmartReplyForDmsEnabled ?? settings?.facebookSmartReplyEnabled ?? false,
      facebookSmartReplyForCommentsEnabled: settings?.facebookSmartReplyForCommentsEnabled ?? settings?.facebookSmartReplyEnabled ?? false,
      smartReplyFinancingMode: settings?.smartReplyFinancingMode ?? "generic",
      smartReplyDefaultDownPaymentPercent: settings?.smartReplyDefaultDownPaymentPercent,
      smartReplyDefaultFinanceCompanyId: settings?.smartReplyDefaultFinanceCompanyId,
      smartReplyVisibility: settings?.smartReplyVisibility ?? "public",
      smartReplyCustomTemplatesEn: settings?.smartReplyCustomTemplatesEn,
      smartReplyCustomTemplatesAr: settings?.smartReplyCustomTemplatesAr,
    };
  },
});

/**
 * Saves the dealer's static auto-reply config for incoming Facebook Page
 * comments/Messenger DMs (up to 5 canned messages, sent round-robin).
 * Owner-only, same gating as the Instagram equivalent.
 */
export const setFacebookAutoReplyConfig = mutation({
  args: {
    orgId: v.id("organizations"),
    enabledForDms: v.boolean(),
    enabledForComments: v.boolean(),
    messages: v.array(v.string()),
    mobileReceivedMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    await requireFeature(ctx, args.orgId, "socialInbox");

    const cleaned = args.messages.map((m) => m.trim()).filter(Boolean);
    if (cleaned.length > 5) {
      throw new ConvexError("Up to 5 auto-reply messages are allowed.");
    }
    const eitherEnabled = args.enabledForDms || args.enabledForComments;
    if (eitherEnabled && cleaned.length === 0) {
      throw new ConvexError("Add at least one auto-reply message before enabling.");
    }

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (!settings) {
      throw new ConvexError("Connect Facebook before configuring auto-replies.");
    }

    await ctx.db.patch(settings._id, {
      facebookAutoReplyForDmsEnabled: args.enabledForDms,
      facebookAutoReplyForCommentsEnabled: args.enabledForComments,
      facebookAutoReplyEnabled: eitherEnabled,
      facebookAutoReplyMessages: cleaned,
      facebookAutoReplyMobileReceivedMessage: args.mobileReceivedMessage?.trim() || undefined,
    });
  },
});

/**
 * Sets whether inbound Facebook comments/Messenger DMs create a CRM lead.
 * Off doesn't mean ignored — the interaction is still captured in the
 * Social Inbox and still eligible for auto-reply either way; this only
 * gates whether it also produces a Lead in the pipeline + notification.
 * Owner-only.
 */
export const setFacebookLeadCreationConfig = mutation({
  args: {
    orgId: v.id("organizations"),
    leadFromCommentsEnabled: v.boolean(),
    leadFromDmsEnabled: v.boolean(),
    leadFromDmsRequiresMobile: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    await requireFeature(ctx, args.orgId, "socialInbox");

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (!settings) {
      throw new ConvexError("Connect Facebook before configuring lead creation.");
    }

    await ctx.db.patch(settings._id, {
      facebookLeadFromCommentsEnabled: args.leadFromCommentsEnabled,
      facebookLeadFromDmsEnabled: args.leadFromDmsEnabled,
      ...(args.leadFromDmsRequiresMobile !== undefined
        ? { facebookLeadFromDmsRequiresMobile: args.leadFromDmsRequiresMobile }
        : {}),
    });
  },
});

/**
 * Clears stored Facebook credentials by the connecting user's Facebook ID
 * rather than orgId — used by the deauthorize and data-deletion HTTP
 * callbacks Meta requires for every Facebook Login app. Those callbacks'
 * signed_request payloads only carry the connecting user's ID (not the Page
 * ID), so `facebookConnectedByUserId` — captured at connect time — is the
 * only way to resolve which org's connection to clear.
 */
export const disconnectByFacebookConnectedUserId = internalMutation({
  args: { facebookConnectedByUserId: v.string() },
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_facebook_connected_user_id", (q) =>
        q.eq("facebookConnectedByUserId", args.facebookConnectedByUserId)
      )
      .first();
    if (!settings) return;

    await ctx.db.patch(settings._id, {
      facebookPageId: undefined,
      facebookPageAccessToken: undefined,
      facebookTokenExpiresAt: undefined,
      facebookPageName: undefined,
      facebookConnectedByUserId: undefined,
      facebookAutoReplyEnabled: false,
    });
  },
});

/** Disconnects Facebook for the org. Owner-only. */
export const disconnect = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    await requireFeature(ctx, args.orgId, "socialInbox");

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (!settings) return;

    await ctx.db.patch(settings._id, {
      facebookPageId: undefined,
      facebookPageAccessToken: undefined,
      facebookTokenExpiresAt: undefined,
      facebookPageName: undefined,
      facebookConnectedByUserId: undefined,
      facebookAutoReplyEnabled: false,
    });
  },
});

// ─── Internal (used by the OAuth callback HTTP action) ─────────────────────────

/**
 * Validates and one-time-consumes an OAuth state token. Returns the
 * originating orgId, or null if the state is missing/expired/already used.
 */
export const consumeOAuthState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .unique();

    if (!record || record.provider !== "facebook" || record.expiresAt < Date.now()) {
      return null;
    }

    await ctx.db.delete(record._id);
    return { orgId: record.orgId };
  },
});

export const saveFacebookCredentials = internalMutation({
  args: {
    orgId: v.id("organizations"),
    facebookPageId: v.string(),
    facebookPageAccessToken: v.string(),
    facebookTokenExpiresAt: v.optional(v.number()),
    facebookPageName: v.optional(v.string()),
    facebookConnectedByUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId, ...fields } = args;
    const existing = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique();

    if (existing) {
      // Also clear the pending page list now that a selection has been made.
      await ctx.db.patch(existing._id, { ...fields, facebookAvailablePages: undefined });
    } else {
      await ctx.db.insert("orgSettings", {
        orgId,
        currency: DEFAULT_SETTINGS.currency,
        currencySymbol: DEFAULT_SETTINGS.currencySymbol,
        enabledPaymentTypes: DEFAULT_SETTINGS.enabledPaymentTypes,
        ...fields,
      });
    }
  },
});

export const getEnvForExchange = internalQuery({
  args: {},
  handler: async () => {
    const env = getValidatedEnv();
    if (!env.FACEBOOK_APP_ID || !env.FACEBOOK_APP_SECRET || !env.CONVEX_SITE_URL) {
      throw new ConvexError("Facebook integration is not fully configured for this deployment.");
    }
    return {
      appId: env.FACEBOOK_APP_ID,
      appSecret: env.FACEBOOK_APP_SECRET,
      redirectUri: `${env.CONVEX_SITE_URL}/facebook-oauth-callback`,
    };
  },
});

/**
 * Exchanges the OAuth `code` for a long-lived user token, fetches all Pages
 * this user manages, and stores them in `facebookAvailablePages` for the org
 * admin to choose from. The frontend shows a page-picker dialog while
 * `facebookAvailablePages` is populated and `facebookPageId` is absent;
 * the org admin then calls `selectFacebookPage` to complete the connection.
 * Runs as a Node action since it needs `fetch`.
 */
export const exchangeCodeForToken = internalAction({
  args: { orgId: v.id("organizations"), code: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const { appId, appSecret, redirectUri } = await ctx.runQuery(internal.facebookIntegrations.getEnvForExchange, {});

    // 1. Exchange the authorization code for a short-lived user access token.
    const tokenUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", appId);
    tokenUrl.searchParams.set("client_secret", appSecret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", args.code);
    const tokenRes = await fetch(tokenUrl.toString());
    const tokenJson = await tokenRes.json();
    const shortLivedToken: string | undefined = tokenJson.access_token;
    if (!tokenRes.ok || !shortLivedToken) {
      throw new ConvexError(`Facebook token exchange failed: ${tokenJson?.error?.message ?? tokenRes.statusText}`);
    }

    // 2. Exchange for a long-lived user access token (~60 days).
    const longLivedUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/oauth/access_token`);
    longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
    longLivedUrl.searchParams.set("client_id", appId);
    longLivedUrl.searchParams.set("client_secret", appSecret);
    longLivedUrl.searchParams.set("fb_exchange_token", shortLivedToken);
    const longLivedRes = await fetch(longLivedUrl.toString());
    const longLivedJson = await longLivedRes.json();
    if (!longLivedRes.ok || !longLivedJson.access_token) {
      throw new ConvexError(`Facebook long-lived token exchange failed: ${longLivedJson?.error?.message ?? longLivedRes.statusText}`);
    }
    const longLivedUserToken: string = longLivedJson.access_token;

    // 3. Fetch the connecting user's own Facebook ID — needed because Meta's
    // deauthorize/data-deletion callbacks only identify the user, not the
    // Page, in their signed_request payload.
    let connectedByUserId: string | undefined;
    try {
      const meUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me`);
      meUrl.searchParams.set("fields", "id");
      meUrl.searchParams.set("access_token", longLivedUserToken);
      const meRes = await fetch(meUrl.toString());
      const meJson = await meRes.json();
      connectedByUserId = meJson.id;
    } catch {
      // Non-fatal — connection still succeeds; only the deauth/data-deletion
      // callbacks would be unable to resolve this org later.
    }

    // 4. List the Pages this person manages. Page Access Tokens returned
    // here (derived from a long-lived user token) are themselves
    // non-expiring — no separate refresh flow needed, unlike Instagram.
    const accountsUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me/accounts`);
    accountsUrl.searchParams.set("access_token", longLivedUserToken);
    const accountsRes = await fetch(accountsUrl.toString());
    const accountsJson = await accountsRes.json();
    const pages: Array<{ id: string; name: string; access_token: string }> = accountsJson?.data ?? [];
    if (!accountsRes.ok || pages.length === 0) {
      throw new ConvexError(
        `No Facebook Pages available to connect: ${accountsJson?.error?.message ?? "this account doesn't manage any Pages."}`
      );
    }

    // 5. Store the full page list so the admin can pick which Page to connect.
    //    selectFacebookPage finalises the connection; we do NOT auto-select here.
    await ctx.runMutation(internal.facebookIntegrations.saveFacebookPendingPages, {
      orgId: args.orgId,
      pages,
      connectedByUserId,
    });
  },
});

/** Persists the pending page list returned by the OAuth flow, clearing any
 *  previously-active connection so the frontend shows the picker. */
export const saveFacebookPendingPages = internalMutation({
  args: {
    orgId: v.id("organizations"),
    pages: v.array(v.object({ id: v.string(), name: v.string(), access_token: v.string() })),
    connectedByUserId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId, pages, connectedByUserId } = args;
    const existing = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique();

    const patch = {
      facebookAvailablePages: pages,
      // Clear the active connection until the admin explicitly picks a page.
      facebookPageId: undefined,
      facebookPageAccessToken: undefined,
      facebookPageName: undefined,
      facebookConnectedByUserId: connectedByUserId,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("orgSettings", {
        orgId,
        currency: DEFAULT_SETTINGS.currency,
        currencySymbol: DEFAULT_SETTINGS.currencySymbol,
        enabledPaymentTypes: DEFAULT_SETTINGS.enabledPaymentTypes,
        ...patch,
      });
    }
  },
});

/**
 * Completes the Facebook Page connection the admin started via OAuth.
 * Looks up the chosen page from the pending list, calls subscribed_apps,
 * saves the credentials, and clears facebookAvailablePages.
 */
export const selectFacebookPage = action({
  args: {
    orgId: v.id("organizations"),
    pageId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const { role } = await requireTenantAuth(ctx, args.orgId);
    if (!isSystemOwnerRole(role) && !role.permissions.includes(PERMISSIONS.MANAGE_SETTINGS)) {
      throw new ConvexError("Only org owners and admins can connect Facebook Pages.");
    }

    const settings = await ctx.runQuery(internal.facebookIntegrations.getOrgSettingsForPageSelect, {
      orgId: args.orgId,
    });

    const pages = settings?.facebookAvailablePages ?? [];
    const page = pages.find((p) => p.id === args.pageId);
    if (!page) {
      throw new ConvexError("The selected Facebook Page is not in the pending list. Please reconnect via OAuth.");
    }

    // Subscribe the selected Page to webhook delivery.
    try {
      const subscribeUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${page.id}/subscribed_apps`);
      subscribeUrl.searchParams.set("subscribed_fields", "feed,messages");
      subscribeUrl.searchParams.set("access_token", page.access_token);
      const subscribeRes = await fetch(subscribeUrl.toString(), { method: "POST" });
      const subscribeJson = await subscribeRes.json();
      if (!subscribeRes.ok || subscribeJson?.success !== true) {
        throw new ConvexError(subscribeJson?.error?.message ?? subscribeRes.statusText);
      }
    } catch (err) {
      // Non-fatal — save credentials anyway; only inbound webhook is affected.
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "facebook",
        status: "error",
        summary: `subscribed_apps failed for Page ${page.id}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await ctx.runMutation(internal.facebookIntegrations.saveFacebookCredentials, {
      orgId: args.orgId,
      facebookPageId: page.id,
      facebookPageAccessToken: page.access_token,
      facebookPageName: page.name,
      facebookConnectedByUserId: settings?.facebookConnectedByUserId,
    });
  },
});

export const getOrgSettingsForPageSelect = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
  },
});
