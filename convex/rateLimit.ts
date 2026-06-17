import { RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  email: { kind: "token bucket", rate: 5, period: 60000, capacity: 5 }, // 5 emails per minute
  create: { kind: "token bucket", rate: 30, period: 60000, capacity: 30 }, // 30 creates per minute
  upload: { kind: "token bucket", rate: 10, period: 60000, capacity: 10 }, // 10 uploads per minute
  heavyRead: { kind: "token bucket", rate: 20, period: 60000, capacity: 20 }, // For reports and massive aggregations
  standardApi: { kind: "token bucket", rate: 100, period: 60000, capacity: 200 }, // General mutations (updates, deletes)
  webhook: { kind: "token bucket", rate: 60, period: 60000, capacity: 60 }, // Inbound webhooks (Clerk, WhatsApp), keyed by source
});
