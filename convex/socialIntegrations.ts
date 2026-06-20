import { v, ConvexError } from "convex/values";
import { mutation, query, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOwner, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { getValidatedEnv } from "./utils/env";
import { DEFAULT_SETTINGS } from "./orgSettings";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const META_GRAPH_VERSION = "v21.0";

const INSTAGRAM_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
].join(",");

// ─── Public ───────────────────────────────────────────────────────────────────

/**
 * Generates a CSRF state token and returns the Meta OAuth dialog URL the
 * client redirects the browser to. Owner-only — only the org owner can
 * connect a social account.
 */
export const createConnectUrl = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const env = getValidatedEnv();
    if (!env.INSTAGRAM_APP_ID) {
      throw new ConvexError("Instagram integration is not configured for this deployment.");
    }
    if (!env.CONVEX_SITE_URL) {
      throw new ConvexError("CONVEX_SITE_URL is unavailable — cannot build the OAuth redirect URI.");
    }

    const state = crypto.randomUUID();
    const now = Date.now();
    await ctx.db.insert("oauthStates", {
      orgId: args.orgId,
      state,
      provider: "instagram",
      createdAt: now,
      expiresAt: now + OAUTH_STATE_TTL_MS,
    });

    const redirectUri = `${env.CONVEX_SITE_URL}/instagram-oauth-callback`;
    const url = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
    url.searchParams.set("client_id", env.INSTAGRAM_APP_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", INSTAGRAM_SCOPES);
    url.searchParams.set("response_type", "code");

    return url.toString();
  },
});

/**
 * Connection status for the Integrations settings page. Never exposes the
 * raw access token to the client.
 */
export const getConnectionStatus = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SETTINGS]);

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    return {
      instagramConnected: Boolean(settings?.instagramAccessToken && settings?.instagramBusinessAccountId),
      instagramPageName: settings?.instagramPageName,
      socialAutoPostEnabled: settings?.socialAutoPostEnabled ?? false,
    };
  },
});

/** Disconnects Instagram/Facebook for the org. Owner-only. */
export const disconnect = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (!settings) return;

    await ctx.db.patch(settings._id, {
      instagramBusinessAccountId: undefined,
      instagramAccessToken: undefined,
      instagramTokenExpiresAt: undefined,
      instagramPageName: undefined,
      facebookPageId: undefined,
      facebookPageAccessToken: undefined,
      socialAutoPostEnabled: false,
    });
  },
});

/** Toggles auto-posting on vehicle status → AVAILABLE. Owner-only, requires an active connection. */
export const setAutoPostEnabled = mutation({
  args: { orgId: v.id("organizations"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    if (args.enabled && !settings?.instagramAccessToken) {
      throw new ConvexError("Connect Instagram before enabling auto-post.");
    }
    if (!settings) return;

    await ctx.db.patch(settings._id, { socialAutoPostEnabled: args.enabled });
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

    if (!record || record.provider !== "instagram" || record.expiresAt < Date.now()) {
      return null;
    }

    await ctx.db.delete(record._id);
    return { orgId: record.orgId };
  },
});

export const saveInstagramCredentials = internalMutation({
  args: {
    orgId: v.id("organizations"),
    instagramBusinessAccountId: v.string(),
    instagramAccessToken: v.string(),
    instagramTokenExpiresAt: v.optional(v.number()),
    instagramPageName: v.optional(v.string()),
    facebookPageId: v.string(),
    facebookPageAccessToken: v.string(),
  },
  handler: async (ctx, args) => {
    const { orgId, ...fields } = args;
    const existing = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, fields);
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
    if (!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET || !env.CONVEX_SITE_URL) {
      throw new ConvexError("Instagram integration is not fully configured for this deployment.");
    }
    return {
      appId: env.INSTAGRAM_APP_ID,
      appSecret: env.INSTAGRAM_APP_SECRET,
      redirectUri: `${env.CONVEX_SITE_URL}/instagram-oauth-callback`,
    };
  },
});

/**
 * Exchanges the OAuth `code` for a long-lived Page access token, resolves
 * the linked Instagram Business Account, and persists everything. Runs as
 * a Node action since it needs `fetch` to Meta's Graph API.
 */
export const exchangeCodeForToken = internalAction({
  args: { orgId: v.id("organizations"), code: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const { appId, appSecret, redirectUri } = await ctx.runQuery(internal.socialIntegrations.getEnvForExchange, {});

    // 1. Exchange the authorization code for a short-lived user access token.
    const tokenUrl = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", appId);
    tokenUrl.searchParams.set("client_secret", appSecret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", args.code);

    const tokenRes = await fetch(tokenUrl.toString());
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      throw new ConvexError(`Instagram token exchange failed: ${tokenJson?.error?.message ?? tokenRes.statusText}`);
    }
    const shortLivedToken: string = tokenJson.access_token;

    // 2. Exchange for a long-lived user access token (~60 days).
    const longLivedUrl = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`);
    longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
    longLivedUrl.searchParams.set("client_id", appId);
    longLivedUrl.searchParams.set("client_secret", appSecret);
    longLivedUrl.searchParams.set("fb_exchange_token", shortLivedToken);

    const longLivedRes = await fetch(longLivedUrl.toString());
    const longLivedJson = await longLivedRes.json();
    if (!longLivedRes.ok || !longLivedJson.access_token) {
      throw new ConvexError(`Instagram long-lived token exchange failed: ${longLivedJson?.error?.message ?? longLivedRes.statusText}`);
    }
    const longLivedUserToken: string = longLivedJson.access_token;
    const expiresInSeconds: number | undefined = longLivedJson.expires_in;

    // 3. Find the Facebook Page(s) this user manages.
    const pagesUrl = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/me/accounts`);
    pagesUrl.searchParams.set("access_token", longLivedUserToken);
    const pagesRes = await fetch(pagesUrl.toString());
    const pagesJson = await pagesRes.json();
    const page = pagesJson?.data?.[0];
    if (!pagesRes.ok || !page) {
      throw new ConvexError("No Facebook Page found for this account — link a Page to your Instagram Business account first.");
    }

    // 4. Resolve the Instagram Business Account linked to that Page.
    const igLookupUrl = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/${page.id}`);
    igLookupUrl.searchParams.set("fields", "instagram_business_account");
    igLookupUrl.searchParams.set("access_token", page.access_token);
    const igRes = await fetch(igLookupUrl.toString());
    const igJson = await igRes.json();
    const igAccountId: string | undefined = igJson?.instagram_business_account?.id;
    if (!igRes.ok || !igAccountId) {
      throw new ConvexError("This Facebook Page has no linked Instagram Business account.");
    }

    await ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
      orgId: args.orgId,
      instagramBusinessAccountId: igAccountId,
      instagramAccessToken: page.access_token,
      instagramTokenExpiresAt: expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : undefined,
      instagramPageName: page.name,
      facebookPageId: page.id,
      facebookPageAccessToken: page.access_token,
    });
  },
});
