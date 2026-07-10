import { RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  email: { kind: "token bucket", rate: 5, period: 60000, capacity: 5 }, // 5 emails per minute
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
  notificationWhatsapp: { kind: "token bucket", rate: 10, period: 60000, capacity: 10 }, // Outbound WhatsApp notification sends
  notificationPush: { kind: "token bucket", rate: 20, period: 60000, capacity: 20 }, // Outbound Web Push dispatch calls (each may fan out to several devices)
  // System-wide circuit breaker for create/standardApi/upload, checked in addition to
  // the per-org bucket above. Per-org limits give tenant fairness; this protects the
  // underlying Convex deployment from an aggregate spike across many orgs at once
  // (e.g. several large imports running concurrently, or a runaway client bug).
  // Sized well above expected combined traffic — tune from production telemetry once
  // real multi-tenant load data exists.
  globalWrites: { kind: "token bucket", rate: 3000, period: 60000, capacity: 3000 },
});

export type TenantWriteLimitName = "create" | "standardApi" | "upload";

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
