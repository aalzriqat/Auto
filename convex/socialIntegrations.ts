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
const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_comments",
  "instagram_business_manage_messages",
].join(",");

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
      instagramAutoReplyEnabled: settings?.instagramAutoReplyEnabled ?? false,
      instagramAutoReplyMessages: settings?.instagramAutoReplyMessages ?? [],
      instagramLeadFromCommentsEnabled: settings?.instagramLeadFromCommentsEnabled !== false,
      instagramLeadFromDmsEnabled: settings?.instagramLeadFromDmsEnabled !== false,
    };
  },
});

/**
 * Saves the dealer's static auto-reply config for incoming Instagram
 * comments/DMs (up to 5 canned messages, sent round-robin). Owner-only, same
 * gating as the other Instagram connection settings.
 */
export const setInstagramAutoReplyConfig = mutation({
  args: {
    orgId: v.id("organizations"),
    enabled: v.boolean(),
    messages: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const cleaned = args.messages.map((m) => m.trim()).filter(Boolean);
    if (cleaned.length > 5) {
      throw new ConvexError("Up to 5 auto-reply messages are allowed.");
    }
    if (args.enabled && cleaned.length === 0) {
      throw new ConvexError("Add at least one auto-reply message before enabling.");
    }

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (!settings) {
      throw new ConvexError("Connect Instagram before configuring auto-replies.");
    }

    await ctx.db.patch(settings._id, {
      instagramAutoReplyEnabled: args.enabled,
      instagramAutoReplyMessages: cleaned,
    });
  },
});

/**
 * Sets whether inbound Instagram comments/DMs create a CRM lead. Off doesn't
 * mean ignored — the interaction is still captured in the Social Inbox and
 * still eligible for auto-reply either way; this only gates whether it also
 * produces a Lead in the pipeline + notification. Owner-only.
 */
export const setInstagramLeadCreationConfig = mutation({
  args: {
    orgId: v.id("organizations"),
    leadFromCommentsEnabled: v.boolean(),
    leadFromDmsEnabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (!settings) {
      throw new ConvexError("Connect Instagram before configuring lead creation.");
    }

    await ctx.db.patch(settings._id, {
      instagramLeadFromCommentsEnabled: args.leadFromCommentsEnabled,
      instagramLeadFromDmsEnabled: args.leadFromDmsEnabled,
    });
  },
});

/**
 * Clears stored Instagram credentials by IG business account ID rather than
 * orgId — used by the deauthorize and data-deletion HTTP callbacks Meta
 * requires for every Instagram Login app, which only identify the user via
 * their signed `user_id`, not our internal orgId.
 */
export const disconnectByInstagramUserId = internalMutation({
  args: { instagramBusinessAccountId: v.string() },
  handler: async (ctx, args) => {
    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_instagram_business_account_id", (q) =>
        q.eq("instagramBusinessAccountId", args.instagramBusinessAccountId)
      )
      .first();
    if (!settings) return;

    await ctx.db.patch(settings._id, {
      instagramBusinessAccountId: undefined,
      instagramWebhookAccountId: undefined,
      instagramAccessToken: undefined,
      instagramTokenExpiresAt: undefined,
      instagramPageName: undefined,
      socialAutoPostEnabled: false,
      instagramAutoReplyEnabled: false,
    });
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
      instagramWebhookAccountId: undefined,
      instagramAccessToken: undefined,
      instagramTokenExpiresAt: undefined,
      instagramPageName: undefined,
      socialAutoPostEnabled: false,
      instagramAutoReplyEnabled: false,
    });
  },
});

/**
 * Toggles auto-posting on vehicle status → AVAILABLE. Owner-only. Shared
 * across both Instagram and Facebook — each platform's own auto-post helper
 * (`maybeAutoPostToInstagram`/`maybeAutoPostToFacebook`) independently
 * no-ops if that specific platform isn't connected, so this only requires
 * at least one of the two to be active.
 */
export const setAutoPostEnabled = mutation({
  args: { orgId: v.id("organizations"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    const hasAnyConnection = settings?.instagramAccessToken || settings?.facebookPageAccessToken;
    if (args.enabled && !hasAnyConnection) {
      throw new ConvexError("Connect Instagram or Facebook before enabling auto-post.");
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
    instagramWebhookAccountId: v.optional(v.string()),
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
    // Instagram user IDs can exceed Number.MAX_SAFE_INTEGER (17 digits) — if
    // Meta's response has `user_id` as an unquoted JSON number, `.json()`
    // would silently round it to a different, wrong ID before we ever see
    // it. Quote it in the raw text first so JSON.parse treats it as a string.
    const tokenRawText = await tokenRes.text();
    const tokenSafeText = tokenRawText.replace(/"user_id"\s*:\s*(\d+)/, '"user_id":"$1"');
    const tokenJson = JSON.parse(tokenSafeText);
    const shortLivedToken: string | undefined = tokenJson.access_token;
    const igUserId: string | undefined = tokenJson.user_id;
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

    // 3. Fetch the username for display purposes ("Connected as @handle"),
    // and the profile's "user_id" field — a *different* ID from `igUserId`
    // above. Confirmed by direct API probe: `id` (igUserId) is what Graph
    // API path calls (subscribed_apps, messages) expect, but Meta's webhook
    // payloads use `user_id` in entry[].id. Both must be captured.
    let username: string | undefined;
    let webhookAccountId: string | undefined;
    try {
      const profileUrl = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${igUserId}`);
      profileUrl.searchParams.set("fields", "username,user_id");
      profileUrl.searchParams.set("access_token", longLivedToken);
      const profileRes = await fetch(profileUrl.toString());
      const profileJson = await profileRes.json();
      username = profileJson.username;
      webhookAccountId = profileJson.user_id;
    } catch {
      // Non-fatal — connection still succeeds without a display name.
    }

    await ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
      orgId: args.orgId,
      instagramBusinessAccountId: igUserId,
      instagramWebhookAccountId: webhookAccountId,
      instagramAccessToken: longLivedToken,
      instagramTokenExpiresAt: expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : undefined,
      instagramPageName: username,
    });

    // 4. Subscribe this specific IG account to webhook delivery. The
    // app-level Webhooks product config (callback URL + verify token +
    // field selection in the Meta dashboard) is necessary but not
    // sufficient — each connected account must also opt in via this call,
    // or comments/messages will never be delivered to /instagram-webhook
    // even though the OAuth scopes were granted.
    try {
      const subscribeUrl = new URL(`https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}/${igUserId}/subscribed_apps`);
      subscribeUrl.searchParams.set("subscribed_fields", "comments,messages");
      subscribeUrl.searchParams.set("access_token", longLivedToken);
      const subscribeRes = await fetch(subscribeUrl.toString(), { method: "POST" });
      const subscribeJson = await subscribeRes.json();
      if (!subscribeRes.ok || subscribeJson?.success !== true) {
        throw new ConvexError(subscribeJson?.error?.message ?? subscribeRes.statusText);
      }
    } catch (err) {
      // Non-fatal — the account is connected and posting/comment-viewing
      // still work; only inbound webhook delivery is affected. Logged so
      // it's visible in the admin Overview rather than silently swallowed.
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "instagram",
        status: "error",
        summary: `subscribed_apps failed for IG account ${igUserId}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
