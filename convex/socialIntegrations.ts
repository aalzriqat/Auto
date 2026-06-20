import { v, ConvexError } from "convex/values";
import { mutation, query, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOwner, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { getValidatedEnv } from "./utils/env";
import { DEFAULT_SETTINGS } from "./orgSettings";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const INSTAGRAM_GRAPH_VERSION = "v21.0";

// This app is configured as "API setup with Instagram Login" in the Meta
// dashboard (confirmed live — "API setup with Facebook Login" scopes were
// rejected with "Invalid Scopes"). That flow authenticates directly against
// instagram.com — no linked Facebook Page involved — and uses the
// `instagram_business_*`-prefixed scopes, not the older `instagram_basic`/
// `pages_*` scopes used by the Facebook Login flow.
const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"].join(",");

// ─── Public ───────────────────────────────────────────────────────────────────

/**
 * Generates a CSRF state token and returns the Instagram OAuth dialog URL
 * the client redirects the browser to. Owner-only — only the org owner can
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
    const url = new URL("https://www.instagram.com/oauth/authorize");
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

/** Disconnects Instagram for the org. Owner-only. */
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
 * Exchanges the OAuth `code` for a long-lived Instagram access token and
 * persists it. Instagram Login (unlike Facebook Login) authenticates
 * directly against the Instagram account — the `user_id` returned by the
 * very first exchange *is* the Instagram Business Account ID, no Facebook
 * Page lookup involved. Runs as a Node action since it needs `fetch`.
 */
export const exchangeCodeForToken = internalAction({
  args: { orgId: v.id("organizations"), code: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const { appId, appSecret, redirectUri } = await ctx.runQuery(internal.socialIntegrations.getEnvForExchange, {});

    // 1. Exchange the authorization code for a short-lived access token.
    //    This is a POST with a form-encoded body, not a GET with query params.
    const tokenRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code: args.code,
      }).toString(),
    });
    const tokenJson = await tokenRes.json();
    const shortLivedToken: string | undefined = tokenJson.access_token;
    const igUserId: string | undefined = tokenJson.user_id?.toString();
    if (!tokenRes.ok || !shortLivedToken || !igUserId) {
      throw new ConvexError(`Instagram token exchange failed: ${tokenJson?.error_message ?? tokenJson?.error?.message ?? tokenRes.statusText}`);
    }

    // 2. Exchange for a long-lived access token (~60 days).
    const longLivedUrl = new URL("https://graph.instagram.com/access_token");
    longLivedUrl.searchParams.set("grant_type", "ig_exchange_token");
    longLivedUrl.searchParams.set("client_secret", appSecret);
    longLivedUrl.searchParams.set("access_token", shortLivedToken);

    const longLivedRes = await fetch(longLivedUrl.toString());
    const longLivedJson = await longLivedRes.json();
    if (!longLivedRes.ok || !longLivedJson.access_token) {
      throw new ConvexError(`Instagram long-lived token exchange failed: ${longLivedJson?.error?.message ?? longLivedRes.statusText}`);
    }
    const longLivedToken: string = longLivedJson.access_token;
    const expiresInSeconds: number | undefined = longLivedJson.expires_in;

    // 3. Fetch the username for display purposes ("Connected as @handle").
    let username: string | undefined;
    try {
      const profileUrl = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${igUserId}`);
      profileUrl.searchParams.set("fields", "username");
      profileUrl.searchParams.set("access_token", longLivedToken);
      const profileRes = await fetch(profileUrl.toString());
      const profileJson = await profileRes.json();
      username = profileJson.username;
    } catch {
      // Non-fatal — connection still succeeds without a display name.
    }

    await ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
      orgId: args.orgId,
      instagramBusinessAccountId: igUserId,
      instagramAccessToken: longLivedToken,
      instagramTokenExpiresAt: expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : undefined,
      instagramPageName: username,
    });
  },
});
