import { ConvexError } from "convex/values";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import type { ActionCtx, MutationCtx } from "./_generated/server";

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Outbound email, keyed per recipient address or per org — see convex/email.ts.
  //
  // This was a single unkeyed `email` bucket (5/min), i.e. five emails per
  // minute for the ENTIRE deployment, shared by every org, every recipient and
  // every kind of mail. One org's notification fan-out therefore starved every
  // other org's team invites and account-setup links, and the dropped sends
  // were invisible.
  //
  // Sized per key rather than per platform: the question each bucket answers is
  // "how much mail should one mailbox (or one tenant) get", not "how much may
  // the platform emit" — emailGlobal below is what answers the latter. The
  // split is by how bad a false block is, because that differs enormously:
  //
  //  - transactional: a person is waiting on this specific message (team
  //    invite, account-setup link, a human-typed support reply). Being
  //    throttled out of one is a hard failure — someone cannot join the org —
  //    so it must never share a budget with cron traffic. Keyed by recipient
  //    address, the only identifier that exists here: an invitee has no userId
  //    yet, and may have no org either. 10/min to one address is already a
  //    resend loop; a real flow sends one or two.
  //  - bulk: automated fan-out (notification emails, task alarms, auto-replies,
  //    weekly and renewal digests). A dropped one is an inconvenience, not a
  //    failure — the in-app notification is inserted by dispatch() regardless
  //    and stays the source of truth. Capacity is the burst one recipient can
  //    legitimately receive from a single bulk action (e.g. being assigned 20
  //    leads in one batch); rate is the sustained ceiling, above which a
  //    runaway loop is throttled instead of filling an inbox. Deliberately the
  //    same shape as notificationWebPush — a per-recipient budget should mean
  //    the same thing on every channel.
  //  - staffNotice: mail addressed to AutoFlow's own staff inboxes (an upgrade
  //    request, a new support message). Keyed by the org or the external sender
  //    that triggered it, never by recipient: the recipients are a fixed staff
  //    list, so keying those by address would rebuild the global bucket exactly.
  //    Tighter than the others because the recipient is us, and the same
  //    content is already durably in the admin UI either way.
  emailTransactional: { kind: "token bucket", rate: 10, period: 60000, capacity: 10 },
  emailBulk: { kind: "token bucket", rate: 10, period: 60000, capacity: 20 },
  emailStaffNotice: { kind: "token bucket", rate: 5, period: 60000, capacity: 10 },
  // Deployment-wide circuit breaker for every outbound email, checked in
  // addition to the keyed buckets above — same two-tier shape as globalWrites.
  // Keying alone removes the only platform-level ceiling that existed, and
  // unlike WhatsApp (per-org Meta credentials, per-org billing) email really
  // does have a shared resource behind it: every tenant sends through one
  // Resend account and one quota. Sized far above expected combined volume so
  // it only fires on a genuine runaway; tune from production telemetry.
  emailGlobal: { kind: "token bucket", rate: 300, period: 60000, capacity: 300 },
  create: { kind: "token bucket", rate: 30, period: 60000, capacity: 30 }, // per-org: 30 creates per minute
  upload: { kind: "token bucket", rate: 10, period: 60000, capacity: 10 }, // per-org: 10 uploads per minute
  heavyRead: { kind: "token bucket", rate: 20, period: 60000, capacity: 20 }, // For reports and massive aggregations
  standardApi: { kind: "token bucket", rate: 100, period: 60000, capacity: 200 }, // per-org: general mutations (updates, deletes)
  webhook: { kind: "token bucket", rate: 60, period: 60000, capacity: 60 }, // Inbound webhooks (Clerk, WhatsApp, Meta), keyed by source
  chatMessage: { kind: "token bucket", rate: 20, period: 60000, capacity: 20 }, // Live chat messages, keyed by sender userId
  contactForm: { kind: "token bucket", rate: 3, period: 600000, capacity: 3 }, // Public contact form, keyed by submitter email
  websiteLeadHost: { kind: "token bucket", rate: 30, period: 600000, capacity: 30 }, // Public dealer-site lead intake, keyed by host
  websiteLeadOrg: { kind: "token bucket", rate: 20, period: 600000, capacity: 20 }, // Destination dealership guardrail
  websiteLeadContact: { kind: "token bucket", rate: 3, period: 600000, capacity: 3 }, // Normalized email/phone/WhatsApp
  websiteLeadFingerprint: { kind: "token bucket", rate: 5, period: 600000, capacity: 5 }, // Browser/device fingerprint or trusted IP hash
  websiteEventVisitor: { kind: "token bucket", rate: 60, period: 60000, capacity: 60 }, // Page-view/click beacons, keyed by anonymous visitorId
  websiteEventHost: { kind: "token bucket", rate: 600, period: 60000, capacity: 600 }, // Page-view/click beacons, keyed by host
  socialPosting: { kind: "token bucket", rate: 10, period: 60000, capacity: 10 }, // Instagram/Facebook posts, keyed by orgId — stays well under Meta's own API limits
  marketplaceRequestFingerprint: { kind: "token bucket", rate: 5, period: 600000, capacity: 5 }, // Public "Request a Car" intake, keyed by browser fingerprint/IP hash
  marketplaceRequestContact: { kind: "token bucket", rate: 3, period: 600000, capacity: 3 }, // Normalized buyer phone
  marketplaceTradeInFingerprint: { kind: "token bucket", rate: 5, period: 600000, capacity: 5 }, // Public trade-in intake, keyed by browser fingerprint/IP hash
  marketplaceTradeInContact: { kind: "token bucket", rate: 3, period: 600000, capacity: 3 }, // Normalized buyer phone
  // Outbound WhatsApp notification sends, keyed by orgId.
  //
  // Was unkeyed at 10/min, so ten WhatsApp messages a minute was the ceiling
  // for the whole deployment and the eleventh — from any org — vanished
  // silently. The org is the right key rather than the recipient phone: the
  // Meta Cloud API credentials, the per-number sending quota and the message
  // cost are all per-org (see convex/whatsappSend.ts), so the org is both the
  // tenant-fairness unit and the entity whose money is being spent. A single
  // recipient is bounded transitively — flooding one phone means burning the
  // org's own budget.
  //
  // Capacity covers the largest legitimate burst, a notifyAllMembers broadcast
  // to a ~30-person dealership; rate is the sustained ceiling. Kept modest
  // because these are billed template messages (Arabic sends at Meta's
  // MARKETING rates, ~6-15x UTILITY), so a runaway loop here costs real money.
  notificationWhatsapp: { kind: "token bucket", rate: 20, period: 60000, capacity: 30 },
  // Outbound push, keyed by recipient userId — one bucket per channel.
  //
  // These were a single unkeyed bucket ("notificationPush", 20/min), which made
  // 20 pushes per minute the ceiling for the ENTIRE deployment, shared across
  // every org, every user and both channels. Past that everything was dropped
  // silently, which is what made push look broken rather than throttled.
  //
  // Sized per-user instead: the limit is now "how many device alerts should one
  // human get", not "how much push can the platform emit". The capacity is the
  // burst a bulk action can legitimately produce for a single recipient (e.g.
  // being assigned 20 leads in one batch); the rate is the sustained ceiling,
  // above which a runaway loop is throttled rather than spamming a lock screen.
  // Dropping the excess is the intended behaviour, not a failure: the in-app
  // notification is inserted by dispatch() regardless and stays the source of
  // truth. Mobile is sized higher than web because it fires for every
  // notification a user receives (registering a device token IS the consent),
  // whereas web push only fires when the user opted in via pushEnabled.
  notificationWebPush: { kind: "token bucket", rate: 10, period: 60000, capacity: 20 },
  notificationMobilePush: { kind: "token bucket", rate: 15, period: 60000, capacity: 30 },
  marketplaceListingImageUpload: { kind: "token bucket", rate: 10, period: 60000, capacity: 10 }, // Direct-listing image upload URLs, keyed by userId (orgless)
  marketplaceListingWrite: { kind: "token bucket", rate: 30, period: 60000, capacity: 30 }, // Direct-listing create/update/delete/mark-sold, keyed by userId (orgless)
  // System-wide circuit breaker for create/standardApi/upload, checked in addition to
  // the per-org bucket above. Per-org limits give tenant fairness; this protects the
  // underlying Convex deployment from an aggregate spike across many orgs at once
  // (e.g. several large imports running concurrently, or a runaway client bug).
  // Sized well above expected combined traffic — tune from production telemetry once
  // real multi-tenant load data exists.
  globalWrites: { kind: "token bucket", rate: 3000, period: 60000, capacity: 3000 },
});

export type TenantWriteLimitName = "create" | "standardApi" | "upload";

export type MarketplaceSubmissionRateLimitName =
  | "marketplaceRequestFingerprint"
  | "marketplaceRequestContact"
  | "marketplaceTradeInFingerprint"
  | "marketplaceTradeInContact";

/** Shared "reject with a generic message if this key is over its submission rate limit" guard for the marketplace's public buyer-intake actions (buyer requests, trade-in requests) — same shape, different bucket per flow. */
export async function enforceMarketplaceSubmissionRateLimit(
  ctx: ActionCtx | MutationCtx,
  name: MarketplaceSubmissionRateLimitName,
  key: string
): Promise<void> {
  const status = await rateLimiter.limit(ctx, name, { key });
  if (!status.ok) {
    throw new ConvexError("Too many submissions. Please try again later.");
  }
}

/**
 * Two-tier write rate limit: a per-org bucket (fairness between tenants) plus the
 * shared globalWrites bucket (protects the platform from aggregate overload). Call
 * after auth so an unauthorized caller can't spend down a target org's budget.
 */
export async function checkTenantWriteLimit(
  ctx: MutationCtx,
  name: TenantWriteLimitName,
  orgId: string
): Promise<{ ok: true; retryAfter?: number } | { ok: false; retryAfter: number }> {
  const globalStatus = await rateLimiter.limit(ctx, "globalWrites");
  if (!globalStatus.ok) return globalStatus;
  return rateLimiter.limit(ctx, name, { key: orgId });
}
