import { v, ConvexError } from "convex/values";
import { action, query, internalQuery, internalAction } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { mutation, internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { requireOwner, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { getValidatedEnv } from "./utils/env";
import { DEFAULT_SETTINGS } from "./orgSettings";
import { FACEBOOK_REVOCATION_RETENTION_MS } from "./utils/facebookRevocation";
import { requireFeature } from "./subscriptions";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FACEBOOK_GRAPH_VERSION = "v25.0";

// Fixed text for the revocation fence (see `facebookRevocations` in schema.ts).
// FACEBOOK_REVOCATION_RETENTION_MS must stay well above OAUTH_STATE_TTL_MS plus
// the exchange action's runtime.
const FACEBOOK_REVOKED_MESSAGE =
  "Facebook access for this account was revoked while connecting. Please start the connection again.";
const FACEBOOK_ATTEMPT_EXPIRED_MESSAGE = "This connection attempt expired. Please start the connection again.";
const FACEBOOK_DISCONNECTED_MESSAGE = "Facebook was disconnected while connecting. Please start the connection again.";

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
    // Record the revocation first and unconditionally: a first-time connection
    // still in flight has no row for the clear below to find, and without this
    // its exchange would store the tokens it already fetched after we replied 200.
    // One row per user; its time never moves backwards.
    // Expired fences are removed by the hourly adminSystem.pruneOperationalLogs.
    const now = Date.now();
    const fence = await findFacebookRevocation(ctx, args.facebookConnectedByUserId);
    if (fence) await ctx.db.patch(fence._id, { revokedAt: Math.max(fence.revokedAt, now) });
    else await ctx.db.insert("facebookRevocations", { facebookUserId: args.facebookConnectedByUserId, revokedAt: now });

    // One Facebook user can connect several orgs (e.g. a dealer-group admin);
    // Meta sends a single callback for that user, so every one must be cleared.
    const rows = await ctx.db
      .query("orgSettings")
      .withIndex("by_facebook_connected_user_id", (q) =>
        q.eq("facebookConnectedByUserId", args.facebookConnectedByUserId)
      )
      .collect();

    for (const settings of rows) {
      await ctx.db.patch(settings._id, {
        facebookPageId: undefined,
        facebookPageAccessToken: undefined,
        facebookTokenExpiresAt: undefined,
        facebookPageName: undefined,
        facebookConnectedByUserId: undefined,
        facebookAutoReplyEnabled: false,
        facebookAvailablePages: undefined,
        facebookPendingCredentials: undefined,
        facebookPendingAttemptId: undefined,
      });
    }
  },
});

/** Disconnects Facebook for the org. Owner-only.
 *  Intentionally NOT gated behind requireFeature — downgraded orgs must
 *  still be able to revoke stored credentials.
 *
 *  Also records WHEN, as `facebookDisconnectedAt`: an exchange already in flight
 *  (its Graph call is an action, outside any transaction) or a state never
 *  consumed must not be able to recreate pending credentials afterwards. That is
 *  checked inside `saveFacebookPendingPages`, which reads the same `by_org` index
 *  range this writes (an empty range included), so the two conflict and whichever
 *  commits second re-runs and sees the other. The record is made even when the
 *  org has no settings row yet. Assumes mutation clocks are ordered to within far
 *  less than an OAuth round trip; a tie is refused. */
export const disconnect = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    const now = Date.now();
    if (!settings) {
      await ctx.db.insert("orgSettings", {
        orgId: args.orgId,
        currency: DEFAULT_SETTINGS.currency,
        currencySymbol: DEFAULT_SETTINGS.currencySymbol,
        enabledPaymentTypes: DEFAULT_SETTINGS.enabledPaymentTypes,
        facebookDisconnectedAt: now,
      });
      return;
    }

    await ctx.db.patch(settings._id, {
      facebookDisconnectedAt: Math.max(settings.facebookDisconnectedAt ?? 0, now),
      facebookPageId: undefined,
      facebookPageAccessToken: undefined,
      facebookTokenExpiresAt: undefined,
      facebookPageName: undefined,
      facebookConnectedByUserId: undefined,
      facebookAutoReplyEnabled: false,
      facebookAvailablePages: undefined,
      facebookPendingCredentials: undefined,
      facebookPendingAttemptId: undefined,
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
    return { orgId: record.orgId, createdAt: record.createdAt };
  },
});

/** The user's revocation fence, if any. One row per user (see disconnectByFacebookConnectedUserId). */
function findFacebookRevocation(ctx: MutationCtx, facebookUserId: string) {
  return ctx.db
    .query("facebookRevocations")
    .withIndex("by_facebook_user_id", (q) => q.eq("facebookUserId", facebookUserId))
    .unique();
}

export const FACEBOOK_PAGE_IN_USE_MESSAGE =
  "This Facebook Page is already connected to another AutoFlow organization. Disconnect it there first.";

/**
 * The webhook resolves an org by Page id, so a Page may belong to one org only;
 * a second holder made every delivery for it ambiguous (SCRUM-622).
 */
async function assertFacebookPageFree(ctx: MutationCtx, orgId: Id<"organizations">, facebookPageId: string) {
  const holders = await ctx.db
    .query("orgSettings")
    .withIndex("by_facebook_page_id", (q) => q.eq("facebookPageId", facebookPageId))
    .take(2);
  if (holders.some((settings) => settings.orgId !== orgId)) {
    throw new ConvexError(FACEBOOK_PAGE_IN_USE_MESSAGE);
  }
}

// Fixed text: this is thrown on a path that holds Page tokens.
const FACEBOOK_SELECTION_CHANGED_MESSAGE =
  "This Facebook connection changed before it could be completed. Please reconnect via OAuth.";

/**
 * Finalises a Page selection: the only writer of an active Page token.
 *
 * selectFacebookPage reads the pending credential, awaits Meta's subscribed_apps
 * call, and only then calls this. Meta's deauthorize / data-deletion callback
 * (or a newer OAuth) can clear or replace the pending credentials during that
 * await, so the caller's copy proves nothing here: the org row must STILL hold a
 * pending credential with the same Page id and token, under the same non-empty
 * connecting-user id, read in this transaction. Otherwise a token the callback
 * had already erased would be written back after it reported success.
 *
 * It must also still be the SAME ATTEMPT: every save of pending credentials stamps
 * a fresh `facebookPendingAttemptId`, and the selection carries the one it read. A
 * disconnect followed by a genuinely new attempt for the same user, Page and token
 * matches on everything above, and only this tells the old selection from the new
 * attempt whose credentials it would otherwise promote.
 */
export const saveFacebookCredentials = internalMutation({
  args: {
    orgId: v.id("organizations"),
    facebookPageId: v.string(),
    facebookPageAccessToken: v.string(),
    facebookTokenExpiresAt: v.optional(v.number()),
    facebookPageName: v.optional(v.string()),
    facebookConnectedByUserId: v.string(),
    pendingAttemptId: v.string(),
  },
  handler: async (ctx, args) => {
    // `pendingAttemptId` is destructured out so it is not spread into the row below.
    const { orgId, pendingAttemptId, ...fields } = args;
    await assertFacebookPageFree(ctx, orgId, fields.facebookPageId);
    const existing = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique();

    const stillPending = existing?.facebookPendingCredentials?.some(
      (cred) => cred.id === fields.facebookPageId && cred.token === fields.facebookPageAccessToken
    );
    if (
      !existing ||
      !stillPending ||
      !fields.facebookConnectedByUserId ||
      existing.facebookConnectedByUserId !== fields.facebookConnectedByUserId ||
      !pendingAttemptId ||
      existing.facebookPendingAttemptId !== pendingAttemptId
    ) {
      throw new ConvexError(FACEBOOK_SELECTION_CHANGED_MESSAGE);
    }

    // Clear the pending-page fields now that selection is finalised.
    await ctx.db.patch(existing._id, {
      ...fields,
      facebookAvailablePages: undefined,
      facebookPendingCredentials: undefined,
      facebookPendingAttemptId: undefined,
    });
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

// Fixed user-facing text. Meta's own `error.message` and the response body are
// untrusted and may echo tokens; they are never interpolated into these.
const FACEBOOK_UNEXPECTED_PAGES = "Facebook returned an unexpected Pages response.";

type FacebookPageCredential = { id: string; name: string; access_token: string };

/**
 * Narrows the untrusted `/me/accounts` `data` array to the three fields we store.
 *
 * Meta also returns `category`, `category_list` and `tasks` per Page, and a type
 * annotation does not remove them at runtime: `saveFacebookPendingPages`
 * validates strictly, so passing the response through made it reject the
 * argument and echo the rejected value — `access_token` included — into the
 * thrown error. Any row that is not a Page with a string id, name and token
 * fails the whole connection, with a message that quotes nothing from Meta.
 */
function pickPageCredentials(data: unknown): FacebookPageCredential[] {
  if (!Array.isArray(data)) throw new ConvexError(FACEBOOK_UNEXPECTED_PAGES);
  return data.map((page) => {
    const { id, name, access_token } = (page && typeof page === "object" ? page : {}) as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof name !== "string" || typeof access_token !== "string" || !access_token) {
      throw new ConvexError(FACEBOOK_UNEXPECTED_PAGES);
    }
    return { id, name, access_token };
  });
}

/** The only fields read from an untrusted Graph reply; anything else is ignored. */
type GraphBody = { access_token?: string; id?: unknown; data?: unknown } | null;

/**
 * GETs a Graph URL that carries credentials in its query string. A rejected
 * fetch can embed that URL (`client_secret`, `access_token`) in its message, and
 * the OAuth callback stores thrown messages in the webhook log, so a transport
 * or body failure is replaced by the caller's fixed message.
 */
async function graphGet(url: URL, failureMessage: string): Promise<{ ok: boolean; json: GraphBody }> {
  try {
    const res = await fetch(url.toString());
    return { ok: res.ok, json: await res.json().catch(() => null) };
  } catch {
    throw new ConvexError(failureMessage);
  }
}

/**
 * Exchanges the OAuth `code` for a long-lived user token, fetches all Pages
 * this user manages, and stores them in `facebookAvailablePages` for the org
 * admin to choose from. The frontend shows a page-picker dialog while
 * `facebookAvailablePages` is populated and `facebookPageId` is absent;
 * the org admin then calls `selectFacebookPage` to complete the connection.
 * Runs as a Node action since it needs `fetch`.
 */
export const exchangeCodeForToken = internalAction({
  // attemptStartedAt: when the user began this OAuth attempt (the state's
  // createdAt); the revocation fence is compared against it.
  args: { orgId: v.id("organizations"), code: v.string(), attemptStartedAt: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const { appId, appSecret, redirectUri } = await ctx.runQuery(internal.facebookIntegrations.getEnvForExchange, {});

    // 1. Exchange the authorization code for a short-lived user access token.
    const tokenUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", appId);
    tokenUrl.searchParams.set("client_secret", appSecret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", args.code);
    const tokenFailed = "Facebook token exchange failed.";
    const { ok: tokenOk, json: tokenJson } = await graphGet(tokenUrl, tokenFailed);
    const shortLivedToken: string | undefined = tokenJson?.access_token;
    if (!tokenOk || !shortLivedToken) {
      throw new ConvexError(tokenFailed);
    }

    // 2. Exchange for a long-lived user access token (~60 days).
    const longLivedUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/oauth/access_token`);
    longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
    longLivedUrl.searchParams.set("client_id", appId);
    longLivedUrl.searchParams.set("client_secret", appSecret);
    longLivedUrl.searchParams.set("fb_exchange_token", shortLivedToken);
    const longLivedFailed = "Facebook long-lived token exchange failed.";
    const { ok: longLivedOk, json: longLivedJson } = await graphGet(longLivedUrl, longLivedFailed);
    if (!longLivedOk || !longLivedJson?.access_token) {
      throw new ConvexError(longLivedFailed);
    }
    const longLivedUserToken: string = longLivedJson.access_token;

    // 3. Fetch the connecting user's own Facebook ID. Meta's deauthorize and
    // data-deletion callbacks identify only the user, never the Page, and
    // disconnectByFacebookConnectedUserId finds the org through this ID alone —
    // so Page tokens stored without it could never be erased by them. Any /me
    // failure therefore aborts the connection before anything is written.
    const meUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me`);
    meUrl.searchParams.set("fields", "id");
    meUrl.searchParams.set("access_token", longLivedUserToken);
    const identityFailed = "Facebook could not identify the connecting account.";
    const { ok: meOk, json: meJson } = await graphGet(meUrl, identityFailed);
    const connectedByUserId = meJson?.id;
    if (!meOk || typeof connectedByUserId !== "string" || !connectedByUserId) {
      throw new ConvexError(identityFailed);
    }

    // 4. List the Pages this person manages. Page Access Tokens returned
    // here (derived from a long-lived user token) are themselves
    // non-expiring — no separate refresh flow needed, unlike Instagram.
    const accountsUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/me/accounts`);
    accountsUrl.searchParams.set("access_token", longLivedUserToken);
    const accountsFailed = "Facebook Pages could not be retrieved.";
    const { ok: accountsOk, json: accountsJson } = await graphGet(accountsUrl, accountsFailed);
    if (!accountsOk) {
      throw new ConvexError(accountsFailed);
    }
    const pages = pickPageCredentials(accountsJson?.data);
    if (pages.length === 0) {
      throw new ConvexError("No Facebook Pages available to connect: this account doesn't manage any Pages.");
    }

    // 5. Store the full page list so the admin can pick which Page to connect.
    //    selectFacebookPage finalises the connection; we do NOT auto-select here.
    await ctx.runMutation(internal.facebookIntegrations.saveFacebookPendingPages, {
      orgId: args.orgId,
      pages,
      connectedByUserId,
      attemptStartedAt: args.attemptStartedAt,
    });
  },
});

/** Persists the pending page list from the OAuth flow.
 *  Writes picker-safe data to `facebookAvailablePages` and tokens to
 *  `facebookPendingCredentials` (server-only). The active connection is
 *  intentionally preserved so the current Page keeps working while the
 *  admin picks a new one from the picker. */
export const saveFacebookPendingPages = internalMutation({
  args: {
    orgId: v.id("organizations"),
    pages: v.array(v.object({ id: v.string(), name: v.string(), access_token: v.string() })),
    // Required: it is the only key Meta's deauthorize / data-deletion callbacks
    // can use to find and erase these credentials.
    connectedByUserId: v.string(),
    attemptStartedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const { orgId, pages, connectedByUserId, attemptStartedAt } = args;

    // An attempt begun at or before this user's last signed revocation must not
    // store anything: the callback has already committed and cleared what it
    // could find. Ties go to the revocation; a genuinely new attempt has a later
    // start. An attempt older than the retention window cannot be judged (its
    // fence may already have been swept) and is refused; no live attempt is that
    // old, so this is a backstop.
    if (attemptStartedAt < Date.now() - FACEBOOK_REVOCATION_RETENTION_MS) {
      throw new ConvexError(FACEBOOK_ATTEMPT_EXPIRED_MESSAGE);
    }
    const fence = await findFacebookRevocation(ctx, connectedByUserId);
    if (fence && fence.revokedAt >= attemptStartedAt) {
      throw new ConvexError(FACEBOOK_REVOKED_MESSAGE);
    }

    const existing = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique();

    // The Owner's disconnect fences attempts begun at or before it, with or
    // without a prior settings row (ties go to the disconnect). A new attempt
    // begun afterwards has a later start and passes.
    if (existing?.facebookDisconnectedAt !== undefined && existing.facebookDisconnectedAt >= attemptStartedAt) {
      throw new ConvexError(FACEBOOK_DISCONNECTED_MESSAGE);
    }

    // facebookConnectedByUserId is the single key Meta's callbacks use to find
    // this row. Overwriting it while an active Page token stays would make that
    // token invisible to its real owner's deauthorization, so another user (or
    // an unknown one, on a legacy row) must disconnect first. Pending-only state
    // has nothing active depending on the id and may be replaced.
    if (existing?.facebookPageAccessToken && existing.facebookConnectedByUserId !== connectedByUserId) {
      throw new ConvexError(
        "A different Facebook account is already connected to this organization. Disconnect Facebook first, then connect again."
      );
    }

    // Picker-safe subset for the client; credentials kept server-side only.
    const pickerPages = pages.map(({ id, name }) => ({ id, name }));
    const pendingCredentials = pages.map(({ id, name, access_token }) => ({
      id,
      name,
      token: access_token,
    }));

    const patch = {
      facebookAvailablePages: pickerPages,
      facebookPendingCredentials: pendingCredentials,
      facebookPendingAttemptId: crypto.randomUUID(),
      facebookConnectedByUserId: connectedByUserId,
      // Active connection (facebookPageId / facebookPageAccessToken / facebookPageName)
      // is intentionally NOT cleared here — the current Page keeps working while the
      // admin picks from the pending list. selectFacebookPage finalises the switch.
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

/** Auth guard run inside a mutation so `requireTenantAuth` receives a MutationCtx.
 *  Also resolves the pending token for the chosen page, returning it so the
 *  action can call the Graph API without touching DB credentials from ActionCtx,
 *  and the attempt id that `saveFacebookCredentials` must find still current. */
export const validateFacebookPageSelectAuth = internalMutation({
  args: { orgId: v.id("organizations"), pageId: v.string() },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId);
    if (!isSystemOwnerRole(role) && !role.permissions.includes(PERMISSIONS.MANAGE_SETTINGS)) {
      throw new ConvexError("Only org owners and admins can connect Facebook Pages.");
    }
    await requireFeature(ctx, args.orgId, "socialInbox");

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    const creds = settings?.facebookPendingCredentials ?? [];
    const cred = creds.find((c) => c.id === args.pageId);
    if (!cred) {
      throw new ConvexError("The selected Facebook Page is not in the pending list. Please reconnect via OAuth.");
    }
    // Refuse before the action subscribes the Page, not only at save time.
    await assertFacebookPageFree(ctx, args.orgId, cred.id);
    // Credentials saved before the user id was mandatory carry none, and Meta's
    // deauthorize / data-deletion callbacks could never find them once promoted.
    // Likewise a pending row from before the attempt id: nothing could tie the
    // selection to it at save time.
    const facebookConnectedByUserId = settings?.facebookConnectedByUserId;
    const pendingAttemptId = settings?.facebookPendingAttemptId;
    if (!facebookConnectedByUserId || !pendingAttemptId) {
      throw new ConvexError("This Facebook connection is incomplete. Please reconnect via OAuth.");
    }
    return {
      pageId: cred.id,
      pageName: cred.name,
      pageAccessToken: cred.token,
      facebookConnectedByUserId,
      pendingAttemptId,
    };
  },
});

/**
 * Completes the Facebook Page connection the admin started via OAuth.
 * Auth is delegated to validateFacebookPageSelectAuth (internalMutation) so
 * requireTenantAuth receives a MutationCtx rather than an ActionCtx.
 * Calls subscribed_apps, then saves credentials and clears pending state.
 */
export const selectFacebookPage = action({
  args: {
    orgId: v.id("organizations"),
    pageId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    // Auth + token resolution run inside a mutation (MutationCtx required).
    const page = await ctx.runMutation(
      internal.facebookIntegrations.validateFacebookPageSelectAuth,
      { orgId: args.orgId, pageId: args.pageId }
    );

    // Subscribe the selected Page to webhook delivery.
    try {
      const subscribeUrl = new URL(`https://graph.facebook.com/${FACEBOOK_GRAPH_VERSION}/${page.pageId}/subscribed_apps`);
      subscribeUrl.searchParams.set("subscribed_fields", "feed,messages");
      subscribeUrl.searchParams.set("access_token", page.pageAccessToken);
      const subscribeRes = await fetch(subscribeUrl.toString(), { method: "POST" });
      const subscribeJson = await subscribeRes.json();
      if (!subscribeRes.ok || subscribeJson?.success !== true) {
        throw new ConvexError("subscribed_apps was not accepted");
      }
    } catch {
      // Non-fatal — save credentials anyway; only inbound webhook is affected.
      // The log row is fixed text: the request URL carries the Page token and
      // Meta's error.message / a fetch failure can echo it, and the row is
      // stored verbatim.
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "facebook",
        status: "error",
        summary: `subscribed_apps failed for Page ${page.pageId}`,
        error: "Webhook subscription failed; provider detail withheld.",
      });
    }

    await ctx.runMutation(internal.facebookIntegrations.saveFacebookCredentials, {
      orgId: args.orgId,
      facebookPageId: page.pageId,
      facebookPageAccessToken: page.pageAccessToken,
      facebookPageName: page.pageName,
      facebookConnectedByUserId: page.facebookConnectedByUserId,
      pendingAttemptId: page.pendingAttemptId,
    });
  },
});

