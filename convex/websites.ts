import { ConvexError, v } from "convex/values";
import { ActionCtx, MutationCtx, QueryCtx, action, internalQuery, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { domainRegistrarService } from "./domainRegistrar";
import {
  DEFAULT_ENABLED_WEBSITE_SECTIONS,
  DEFAULT_WEBSITE_SECTION_KEYS,
  WEBSITE_DOMAIN_TARGET,
  WEBSITE_FORM_TYPES,
  normalizedCustomDomain,
  normalizedWebsiteHost,
  platformDomainForSlug,
  sectionKeyForWebsiteForm,
  validateCustomDomain,
  validateSubdomainSlug,
} from "./websiteConfig";
import { websitePublicProjection, websiteSectionMap } from "./websiteProjection";
import { PERMISSIONS } from "./utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { writeAuditLog } from "./utils/auditLog";
import { resolveGeneratedLeadAssignee } from "./utils/leadAssignment";
import { notifyUser } from "./utils/notifications";
import { getValidatedEnv } from "./utils/env";
import { rateLimiter } from "./rateLimit";
import { recordLeadCreated } from "./utils/leadActivity";
import { hasPlanFeature, requireFeature } from "./subscriptions";

const PUBLIC_LEAD_MAX_NAME_CHARS = 80;
const PUBLIC_LEAD_MAX_EMAIL_CHARS = 254;
const PUBLIC_LEAD_MAX_PHONE_CHARS = 24;
const PUBLIC_LEAD_MAX_MESSAGE_CHARS = 2000;
const PUBLIC_LEAD_MAX_FINGERPRINT_CHARS = 256;
const PUBLIC_LEAD_MAX_IP_HASH_CHARS = 128;
const PUBLIC_LEAD_DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TURNSTILE_ACTION = "turnstile-spin-v1";

const OPEN_LEAD_STAGES = new Set([
  "NEW",
  "CONTACTED",
  "INTERESTED",
  "TEST_DRIVE",
  "NEGOTIATION",
  "RESERVED",
]);

const publicLeadBaseArgs = {
  host: v.string(),
  formType: v.string(),
  vehicleId: v.optional(v.id("vehicles")),
  firstName: v.string(),
  lastName: v.optional(v.string()),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  whatsapp: v.optional(v.string()),
  message: v.optional(v.string()),
  preferredDate: v.optional(v.number()),
  clientFingerprint: v.string(),
  clientIpHash: v.optional(v.string()),
};

type PublicLeadFormType = (typeof WEBSITE_FORM_TYPES)[number];
type PublicLeadResult = { success: true; leadId: Id<"leads">; duplicate?: true };
/**
 * A submission refused for an abuse reason that was recorded first. A Convex
 * mutation is atomic, so throwing from createPublicLead would roll the abuse
 * record back along with everything else — the monitoring table would only ever
 * hold duplicate_suppressed, the single branch that returns rather than throws.
 * The mutation hands the refusal back instead, letting the record commit, and
 * submitPublicLead (an action, so not part of that transaction) raises it to the
 * caller. The message reaching the client is unchanged.
 */
type PublicLeadRejection = { success: false; message: string };
type PublicLeadOutcome = PublicLeadResult | PublicLeadRejection;
type BlocklistKind = "fingerprint" | "ipHash" | "email" | "emailDomain" | "phone";

const sectionInputValidator = v.object({
  sectionKey: v.string(),
  enabled: v.boolean(),
  configJson: v.optional(v.any()),
});

const routingInputValidator = v.object({
  formType: v.string(),
  routeToUserId: v.optional(v.id("users")),
  routeToRole: v.optional(v.string()),
  routeToBranchId: v.optional(v.id("branches")),
  createTask: v.boolean(),
  notifyByEmail: v.boolean(),
  notifyByWhatsApp: v.boolean(),
  configJson: v.optional(v.any()),
});

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value);
}

export function normalizeText(value: string | undefined, field: string, maxLength: number): string | undefined {
  const text = value?.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  if (text.length > maxLength || hasControlCharacters(text)) {
    throw new ConvexError(`${field} is invalid.`);
  }
  return text;
}

export function normalizeRequiredText(value: string, field: string, maxLength: number): string {
  const text = normalizeText(value, field, maxLength);
  if (!text) throw new ConvexError(`${field} is required.`);
  return text;
}

function normalizeEmail(value: string | undefined): string | undefined {
  const email = normalizeText(value, "Email", PUBLIC_LEAD_MAX_EMAIL_CHARS)?.toLowerCase();
  if (!email) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new ConvexError("Email is invalid.");
  }
  return email;
}

function normalizePhone(value: string | undefined, field: string): string | undefined {
  const text = normalizeText(value, field, PUBLIC_LEAD_MAX_PHONE_CHARS);
  if (!text) return undefined;
  const normalized = text.replace(/[^\d+]/g, "");
  if (!/^\+?\d{7,20}$/.test(normalized)) {
    throw new ConvexError(`${field} is invalid.`);
  }
  return normalized;
}

function normalizeLimitKey(value: string | undefined, field: string, maxLength: number): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (text.length > maxLength || hasControlCharacters(text)) {
    throw new ConvexError(`${field} is invalid.`);
  }
  return text;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Reduces a value to the exact form `websiteLeadBlocklistValueHash` hashes.
 *
 * Each branch mirrors, character for character, what `createPublicLead` has
 * already applied to the candidate it will look up — that correspondence is
 * the whole contract. A blocklist entry saved as "0799 999 999" has to match a
 * submission the lead path normalised to "0799999999", and an entry saved as
 * "Spam@Example.COM" has to match "spam@example.com".
 */
function normalizeBlocklistValue(kind: BlocklistKind, value: string): string {
  switch (kind) {
    // Opaque client tokens. `createPublicLead` runs these through
    // `normalizeLimitKey`, which only trims — so trimming is all that may
    // happen here, or the two sides would disagree on any value with inner
    // whitespace.
    case "fingerprint":
      return value.trim();
    // Already a hex digest computed before it reached us; case is the only
    // free variable left.
    case "ipHash":
      return value.trim().toLowerCase();
    // Mirrors `normalizeEmail` (normalizeText + toLowerCase).
    case "email":
      return value.trim().replace(/\s+/g, " ").toLowerCase();
    // The read side supplies `email.split("@")[1]`, so accept an operator
    // typing either "example.com" or "@example.com".
    case "emailDomain":
      return value.trim().replace(/\s+/g, " ").toLowerCase().replace(/^@+/, "");
    // Mirrors `normalizePhone`.
    case "phone":
      return value.trim().replace(/\s+/g, " ").replace(/[^\d+]/g, "");
  }
}

/**
 * The single definition of what `websiteLeadBlocklist.valueHash` holds.
 *
 * The read side used to compare a *raw* candidate (`args.email`, the client
 * fingerprint, …) against a column named `valueHash`. Nothing wrote the table,
 * so nothing ever surfaced it, but the comparison could not have matched even
 * if something had: the public-lead blocklist has never blocked anything.
 * Routing both sides through this one function is what makes "like against
 * like" a property of the code rather than a convention two call sites have to
 * remember independently.
 *
 * SHA-256 is genuinely available in this context. Convex's runtime exposes Web
 * Crypto's async `crypto.subtle.digest` to queries and mutations, not only to
 * actions — handlers are `async`, so awaiting a digest is ordinary control
 * flow. `recordWebsiteLeadAbuseEvent`, a few lines below and reached from the
 * same `createPublicLead` mutation, has been awaiting `sha256Hex` from a
 * `MutationCtx` in production all along, which is the proof. So there is no
 * need to fall back to a plain normalised-string comparison here, and the
 * table keeps the property its column name promises: a stolen database dump
 * yields no email addresses or phone numbers.
 */
export async function websiteLeadBlocklistValueHash(
  kind: BlocklistKind,
  value: string,
): Promise<string> {
  return await sha256Hex(`${kind}:${normalizeBlocklistValue(kind, value)}`);
}

export async function verifyTurnstileToken(token: string): Promise<void> {
  const env = getValidatedEnv();
  if (!env.TURNSTILE_SECRET_KEY) {
    console.error("TURNSTILE_SECRET_KEY is not configured for public website lead intake.");
    throw new ConvexError("Request verification is unavailable. Please try again later.");
  }

  const responseToken = token.trim();
  if (!responseToken || responseToken.length > 4096) {
    throw new ConvexError("Please complete the verification challenge.");
  }

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: responseToken,
    }),
  });

  if (!response.ok) {
    console.error("Turnstile siteverify request failed", response.status);
    throw new ConvexError("Request verification failed. Please try again.");
  }

  const result = optionalRecord(await response.json());
  if (result?.success !== true) {
    console.error("Turnstile verification rejected public lead", result);
    throw new ConvexError("Request verification failed. Please try again.");
  }

  const action = optionalString(result.action);
  if (action && action !== TURNSTILE_ACTION) {
    console.error("Turnstile verification returned unexpected action", action);
    throw new ConvexError("Request verification failed. Please try again.");
  }
}

async function recordWebsiteLeadAbuseEvent(
  ctx: MutationCtx,
  args: {
    orgId?: Id<"organizations">;
    host: string;
    formType: string;
    reason: "blocked" | "rate_limited" | "duplicate_suppressed" | "validation_failed";
    clientFingerprint?: string;
    clientIpHash?: string;
    contactKey?: string;
    detail?: string;
  },
) {
  await ctx.db.insert("websiteLeadAbuseEvents", {
    orgId: args.orgId as Id<"organizations">,
    host: args.host,
    formType: args.formType,
    reason: args.reason,
    fingerprintHash: args.clientFingerprint ? await sha256Hex(args.clientFingerprint) : undefined,
    clientIpHash: args.clientIpHash,
    contactKeyHash: args.contactKey ? await sha256Hex(args.contactKey) : undefined,
    detail: args.detail,
    createdAt: Date.now(),
  });
}

async function enforcePublicLeadRateLimit(
  ctx: MutationCtx | ActionCtx,
  name: "websiteLeadHost" | "websiteLeadOrg" | "websiteLeadContact" | "websiteLeadFingerprint",
  key: string,
) {
  const status = await rateLimiter.limit(ctx, name, { key });
  if (!status.ok) {
    throw new ConvexError("Too many submissions. Please try again later.");
  }
}

async function findWebsiteLeadBlock(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    host: string;
    clientFingerprint: string;
    clientIpHash?: string;
    email?: string;
    phone?: string;
    whatsapp?: string;
  },
) {
  const candidates: Array<{ kind: BlocklistKind; value: string }> = [
    { kind: "fingerprint", value: args.clientFingerprint },
  ];
  if (args.clientIpHash) candidates.push({ kind: "ipHash", value: args.clientIpHash });
  if (args.email) {
    candidates.push({ kind: "email", value: args.email });
    const emailDomain = args.email.split("@")[1];
    if (emailDomain) candidates.push({ kind: "emailDomain", value: emailDomain });
  }
  if (args.phone) candidates.push({ kind: "phone", value: args.phone });
  if (args.whatsapp) candidates.push({ kind: "phone", value: args.whatsapp });

  const now = Date.now();
  for (const candidate of candidates) {
    // Hash the candidate before looking it up. The old code compared the raw
    // value against `valueHash` directly, which could never match.
    const valueHash = await websiteLeadBlocklistValueHash(candidate.kind, candidate.value);
    const rows = await ctx.db
      .query("websiteLeadBlocklist")
      .withIndex("by_org_kind_valueHash", (q) =>
        q.eq("orgId", args.orgId).eq("kind", candidate.kind).eq("valueHash", valueHash),
      )
      // `.collect()`, not a bounded `.take()`: the org is now part of the index
      // prefix, so this returns only this org's entries for this one value —
      // at most one org-wide row plus one per host it was scoped to. On the old
      // global index a bounded read was a fail-open, since other tenants
      // blocking the same email could crowd out this org's own entry.
      .collect();
    const active = rows.find((row) => {
      if (row.expiresAt !== undefined && row.expiresAt <= now) return false;
      // orgId needs no re-check: it is an equality term of the index above, so
      // a foreign row cannot be in `rows` at all.
      if (row.host !== undefined && row.host !== args.host) return false;
      return true;
    });
    if (active) return active;
  }
  return null;
}

function sectionDefaults() {
  return DEFAULT_WEBSITE_SECTION_KEYS.map((sectionKey) => ({
    sectionKey,
    enabled: DEFAULT_ENABLED_WEBSITE_SECTIONS.has(sectionKey),
    configJson: undefined,
  }));
}

export async function getSettingsByOrg(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
  return await ctx.db
    .query("websiteSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
}

async function requireWebsiteSettings(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
  const settings = await getSettingsByOrg(ctx, orgId);
  if (!settings) throw new ConvexError("Create the website setup first.");
  return settings;
}

/** The parsed contents of a published site snapshot: the dealer's live public inventory + finance terms + profile, exactly as the buyer-facing browse renders them. */
export type PublishedSnapshotData = {
  vehicles?: unknown[];
  profile?: { dealershipName?: string };
  financeCompany?: unknown | null;
};

/**
 * Resolves a dealer's currently-published site snapshot JSON, or null when
 * they have no active published site. Shared by the public browse query and
 * the marketplace matcher so both score against the exact same inventory
 * source — the alternative (each re-deriving the snapshot resolution) is how
 * "what the buyer browses" and "what the buyer gets matched to" silently drift.
 */
export async function getPublishedSnapshotData(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">
): Promise<PublishedSnapshotData | null> {
  const settings = await getSettingsByOrg(ctx, orgId);
  if (!settings || settings.status !== "active" || !settings.enabled || !settings.publishedSnapshotId) return null;

  const snapshot = await ctx.db.get(settings.publishedSnapshotId);
  if (!snapshot || snapshot.orgId !== orgId || snapshot.websiteSettingsId !== settings._id) return null;

  return (snapshot.snapshotJson ?? null) as PublishedSnapshotData | null;
}

export async function activePrimaryDomain(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
  return await ctx.db
    .query("websiteDomains")
    .withIndex("by_org_primary", (q) => q.eq("orgId", orgId).eq("isPrimary", true))
    .first();
}

async function activePublishedSnapshot(
  ctx: QueryCtx | MutationCtx,
  domain: Doc<"websiteDomains">,
  settings: Doc<"websiteSettings">,
) {
  const snapshotId = domain.publishedSnapshotId ?? settings.publishedSnapshotId;
  if (!snapshotId) return null;

  const snapshot = await ctx.db.get(snapshotId);
  if (!snapshot) return null;
  if (snapshot.orgId !== domain.orgId) return null;
  if (snapshot.websiteSettingsId !== settings._id) return null;
  if (snapshot.domain !== domain.domain) return null;
  return snapshot;
}

function snapshotSectionMap(snapshotJson: unknown): Record<string, boolean> {
  const root = optionalRecord(snapshotJson);
  const sections = optionalRecord(root?.sections);
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(sections ?? {})) {
    if (typeof value === "boolean") result[key] = value;
  }
  return result;
}

async function ensureDomainAvailableForOrg(ctx: QueryCtx | MutationCtx, domain: string, orgId: Id<"organizations">) {
  const existing = await ctx.db
    .query("websiteDomains")
    .withIndex("by_domain", (q) => q.eq("domain", domain))
    .unique();

  if (existing && existing.orgId !== orgId) {
    throw new ConvexError("This domain is already assigned to another dealership.");
  }
  return existing;
}

async function upsertSectionRows(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  websiteSettingsId: Id<"websiteSettings">,
  sections: Array<{ sectionKey: string; enabled: boolean; configJson?: unknown }>
) {
  for (const section of sections) {
    if (!DEFAULT_WEBSITE_SECTION_KEYS.includes(section.sectionKey as (typeof DEFAULT_WEBSITE_SECTION_KEYS)[number])) {
      throw new ConvexError(`Unknown website section: ${section.sectionKey}`);
    }

    const existing = await ctx.db
      .query("websitePublishedSections")
      .withIndex("by_org_settings_section", (q) =>
        q.eq("orgId", orgId).eq("websiteSettingsId", websiteSettingsId).eq("sectionKey", section.sectionKey)
      )
      .unique();

    const row = {
      orgId,
      websiteSettingsId,
      sectionKey: section.sectionKey,
      enabled: section.enabled,
      configJson: section.configJson,
    };

    if (existing) {
      await ctx.db.patch(existing._id, { enabled: row.enabled, configJson: row.configJson });
    } else {
      await ctx.db.insert("websitePublishedSections", row);
    }
  }
}

async function upsertRoutingRows(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  websiteSettingsId: Id<"websiteSettings">,
  routing: Array<{
    formType: string;
    routeToUserId?: Id<"users">;
    routeToRole?: string;
    routeToBranchId?: Id<"branches">;
    createTask: boolean;
    notifyByEmail: boolean;
    notifyByWhatsApp: boolean;
    configJson?: unknown;
  }>
) {
  for (const route of routing) {
    if (!WEBSITE_FORM_TYPES.includes(route.formType as (typeof WEBSITE_FORM_TYPES)[number])) {
      throw new ConvexError(`Unknown website form type: ${route.formType}`);
    }
    const routeToUserId = route.routeToUserId;
    if (routeToUserId) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", routeToUserId))
        .unique();
      if (!membership) throw new ConvexError("Selected assignee is not a member of this dealership.");
    }
    if (route.routeToBranchId) {
      const branch = await ctx.db.get(route.routeToBranchId);
      if (!branch || branch.orgId !== orgId) throw new ConvexError("Selected branch was not found.");
    }

    const existing = await ctx.db
      .query("websiteLeadRouting")
      .withIndex("by_org_settings_form", (q) =>
        q.eq("orgId", orgId).eq("websiteSettingsId", websiteSettingsId).eq("formType", route.formType)
      )
      .unique();

    const row = { orgId, websiteSettingsId, ...route };
    if (existing) {
      await ctx.db.patch(existing._id, route);
    } else {
      await ctx.db.insert("websiteLeadRouting", row);
    }
  }
}

export const getStatus = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_VIEW]);
    await requireFeature(ctx, args.orgId, "websiteBuilder");

    const settings = await getSettingsByOrg(ctx, args.orgId);
    if (!settings) {
      return {
        settings: null,
        primaryDomain: null,
        domains: [],
        sections: sectionDefaults(),
        routing: WEBSITE_FORM_TYPES.map((formType) => ({
          formType,
          createTask: formType === "test_drive",
          notifyByEmail: true,
          notifyByWhatsApp: false,
        })),
      };
    }

    const [domains, sections, routing, primaryDomain] = await Promise.all([
      ctx.db.query("websiteDomains").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).take(50),
      ctx.db.query("websitePublishedSections").withIndex("by_settings", (q) => q.eq("websiteSettingsId", settings._id)).take(100),
      ctx.db.query("websiteLeadRouting").withIndex("by_settings", (q) => q.eq("websiteSettingsId", settings._id)).take(20),
      activePrimaryDomain(ctx, args.orgId),
    ]);

    return { settings, primaryDomain, domains, sections, routing };
  },
});

export const startSetup = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_MANAGE]);
    await requireFeature(ctx, args.orgId, "websiteBuilder");
    const existing = await getSettingsByOrg(ctx, args.orgId);
    if (existing) return existing._id;

    const now = Date.now();
    const org = await ctx.db.get(args.orgId);
    const settingsId = await ctx.db.insert("websiteSettings", {
      orgId: args.orgId,
      enabled: true,
      status: "draft",
      templateId: "modern-showroom",
      defaultLanguage: "en",
      supportedLanguages: ["en", "ar"],
      primaryColor: "#0f172a",
      secondaryColor: "#f97316",
      heroTitle: org?.name ? `${org.name} inventory` : "Create your dealership website",
      heroSubtitle: "Browse our public inventory and contact our team.",
      createdAt: now,
      updatedAt: now,
    });

    await upsertSectionRows(ctx, args.orgId, settingsId, sectionDefaults());
    await upsertRoutingRows(
      ctx,
      args.orgId,
      settingsId,
      WEBSITE_FORM_TYPES.map((formType) => ({
        formType,
        createTask: formType === "test_drive",
        notifyByEmail: true,
        notifyByWhatsApp: false,
      }))
    );

    await writeAuditLog(ctx, user, {
      action: "website created",
      targetTable: "websiteSettings",
      targetId: settingsId,
      orgId: args.orgId,
    });

    return settingsId;
  },
});

export const checkSubdomain = mutation({
  args: { orgId: v.id("organizations"), slug: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_DOMAIN_MANAGE]);
    await requireFeature(ctx, args.orgId, "websiteBuilder");
    const validation = validateSubdomainSlug(args.slug);
    if (!validation.ok) {
      return { available: false, error: validation.error, previewUrl: null };
    }

    const domain = platformDomainForSlug(validation.slug);
    const existing = await ctx.db
      .query("websiteDomains")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .unique();

    const available = !existing || existing.orgId === args.orgId;
    await writeAuditLog(ctx, user, {
      action: "domain searched",
      targetTable: "websiteDomains",
      orgId: args.orgId,
      after: { domain, available, type: "platform_subdomain" },
    });

    return {
      available,
      error: available ? null : "This AutoFlow subdomain is already taken.",
      domain,
      previewUrl: `https://${domain}`,
    };
  },
});

export const searchDomain = mutation({
  args: { orgId: v.id("organizations"), domain: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_DOMAIN_MANAGE]);
    await requireFeature(ctx, args.orgId, "websiteBuilder");
    const validation = validateCustomDomain(args.domain);
    if (!validation.ok) return { available: false, error: validation.error, domain: normalizedCustomDomain(args.domain) };

    const existing = await ctx.db
      .query("websiteDomains")
      .withIndex("by_domain", (q) => q.eq("domain", validation.domain))
      .unique();
    if (existing && existing.orgId !== args.orgId) {
      return { available: false, error: "This domain is already assigned to another dealership.", domain: validation.domain };
    }

    const result = await domainRegistrarService.searchDomain(validation.domain);
    await ctx.db.insert("domainSearchLogs", {
      orgId: args.orgId,
      query: validation.domain,
      available: result.available,
      price: result.price,
      provider: result.provider,
      createdAt: Date.now(),
    });
    await writeAuditLog(ctx, user, {
      action: "domain searched",
      targetTable: "domainSearchLogs",
      orgId: args.orgId,
      after: result,
    });

    return result;
  },
});

export const saveDraft = mutation({
  args: {
    orgId: v.id("organizations"),
    subdomainSlug: v.optional(v.string()),
    purchasedDomain: v.optional(v.string()),
    templateId: v.optional(v.string()),
    defaultLanguage: v.optional(v.union(v.literal("en"), v.literal("ar"))),
    supportedLanguages: v.optional(v.array(v.union(v.literal("en"), v.literal("ar")))),
    primaryColor: v.optional(v.string()),
    secondaryColor: v.optional(v.string()),
    heroTitle: v.optional(v.string()),
    heroSubtitle: v.optional(v.string()),
    heroBadgeText: v.optional(v.string()),
    slogan: v.optional(v.string()),
    activeFinanceCompanyId: v.optional(v.union(v.id("financeCompanies"), v.null())),
    themeConfig: v.optional(v.any()),
    sections: v.optional(v.array(sectionInputValidator)),
    routing: v.optional(v.array(routingInputValidator)),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_MANAGE]);
    await requireFeature(ctx, args.orgId, "websiteBuilder");

    if (args.activeFinanceCompanyId) {
      const company = await ctx.db.get(args.activeFinanceCompanyId);
      if (!company || company.orgId !== args.orgId || !company.isActive) {
        throw new ConvexError("Finance company not found.");
      }
    }

    let settings = await getSettingsByOrg(ctx, args.orgId);
    if (!settings) {
      const settingsId = await ctx.db.insert("websiteSettings", {
        orgId: args.orgId,
        enabled: true,
        status: "draft",
        templateId: "modern-showroom",
        defaultLanguage: "en",
        supportedLanguages: ["en", "ar"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await upsertSectionRows(ctx, args.orgId, settingsId, sectionDefaults());
      settings = (await ctx.db.get(settingsId))!;
    }

    let activeDomainId = settings.activeDomainId;
    let defaultSubdomain = settings.defaultSubdomain;

    if (args.subdomainSlug !== undefined && args.subdomainSlug.trim()) {
      const validation = validateSubdomainSlug(args.subdomainSlug);
      if (!validation.ok) throw new ConvexError(validation.error);
      const domain = platformDomainForSlug(validation.slug);
      const existing = await ensureDomainAvailableForOrg(ctx, domain, args.orgId);

      const existingPrimary = await activePrimaryDomain(ctx, args.orgId);
      if (existingPrimary && existingPrimary.domain !== domain) {
        await ctx.db.patch(existingPrimary._id, { isPrimary: false, updatedAt: Date.now() });
      }

      if (existing) {
        await ctx.db.patch(existing._id, {
          websiteSettingsId: settings._id,
          isPrimary: true,
          updatedAt: Date.now(),
        });
        activeDomainId = existing._id;
      } else {
        activeDomainId = await ctx.db.insert("websiteDomains", {
          orgId: args.orgId,
          websiteSettingsId: settings._id,
          domain,
          type: "platform_subdomain",
          status: "active",
          isPrimary: true,
          registrarProvider: "autoflow",
          dnsStatus: "configured",
          sslStatus: "active",
          autoRenew: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      defaultSubdomain = domain;
      await writeAuditLog(ctx, user, {
        action: "domain selected",
        targetTable: "websiteDomains",
        targetId: activeDomainId,
        orgId: args.orgId,
        after: { domain, type: "platform_subdomain" },
      });
    }

    if (args.purchasedDomain !== undefined && args.purchasedDomain.trim()) {
      const validation = validateCustomDomain(args.purchasedDomain);
      if (!validation.ok) throw new ConvexError(validation.error);
      await ensureDomainAvailableForOrg(ctx, validation.domain, args.orgId);
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now(), status: settings.status === "disabled" ? "draft" : settings.status };
    if (defaultSubdomain !== undefined) patch.defaultSubdomain = defaultSubdomain;
    if (activeDomainId !== undefined) patch.activeDomainId = activeDomainId;
    // `null` means "clear the selection" — patching with `undefined` unsets the
    // field, whereas omitting the key entirely (undefined argument) leaves it untouched.
    if (args.activeFinanceCompanyId !== undefined) patch.activeFinanceCompanyId = args.activeFinanceCompanyId ?? undefined;
    for (const key of [
      "templateId",
      "defaultLanguage",
      "supportedLanguages",
      "primaryColor",
      "secondaryColor",
      "heroTitle",
      "heroSubtitle",
      "heroBadgeText",
      "slogan",
      "themeConfig",
    ] as const) {
      if (args[key] !== undefined) patch[key] = args[key];
    }

    await ctx.db.patch(settings._id, patch);
    if (args.sections) await upsertSectionRows(ctx, args.orgId, settings._id, args.sections);
    if (args.routing) await upsertRoutingRows(ctx, args.orgId, settings._id, args.routing);

    await writeAuditLog(ctx, user, {
      action: "settings changed",
      targetTable: "websiteSettings",
      targetId: settings._id,
      orgId: args.orgId,
      after: patch,
    });

    return settings._id;
  },
});

export const purchaseDomain = mutation({
  args: { orgId: v.id("organizations"), domain: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_DOMAIN_MANAGE]);
    await requireFeature(ctx, args.orgId, "websiteBuilder");
    const settings = await requireWebsiteSettings(ctx, args.orgId);
    const validation = validateCustomDomain(args.domain);
    if (!validation.ok) throw new ConvexError(validation.error);
    await ensureDomainAvailableForOrg(ctx, validation.domain, args.orgId);

    await writeAuditLog(ctx, user, {
      action: "website_domain_purchase_requested",
      targetTable: "websiteDomains",
      orgId: args.orgId,
      after: { domain: validation.domain },
    });

    const search = await domainRegistrarService.searchDomain(validation.domain);
    if (!search.available) {
      await writeAuditLog(ctx, user, {
        action: "website_domain_purchase_failed",
        targetTable: "websiteDomains",
        orgId: args.orgId,
        after: search,
      });
      throw new ConvexError("This domain is unavailable.");
    }

    const purchase = await domainRegistrarService.purchaseDomain(validation.domain, args.orgId);
    const dns = await domainRegistrarService.configureDns(validation.domain, WEBSITE_DOMAIN_TARGET);
    const existingPrimary = await activePrimaryDomain(ctx, args.orgId);
    if (existingPrimary) await ctx.db.patch(existingPrimary._id, { isPrimary: false, updatedAt: Date.now() });

    const domainId = await ctx.db.insert("websiteDomains", {
      orgId: args.orgId,
      websiteSettingsId: settings._id,
      domain: validation.domain,
      type: "purchased_custom_domain",
      status: "active",
      isPrimary: true,
      registrarProvider: purchase.registrarProvider,
      registrarDomainId: purchase.registrarDomainId,
      dnsStatus: dns.dnsStatus,
      sslStatus: dns.sslStatus,
      registrationExpiresAt: purchase.registrationExpiresAt,
      autoRenew: purchase.autoRenew,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await ctx.db.patch(settings._id, { activeDomainId: domainId, updatedAt: Date.now() });
    await writeAuditLog(ctx, user, {
      action: "website_domain_purchased",
      targetTable: "websiteDomains",
      targetId: domainId,
      orgId: args.orgId,
      after: purchase,
    });
    await writeAuditLog(ctx, user, {
      action: "domain activated",
      targetTable: "websiteDomains",
      targetId: domainId,
      orgId: args.orgId,
    });

    return domainId;
  },
});

export const publish = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_PUBLISH]);
    await requireFeature(ctx, args.orgId, "websiteBuilder");
    const settings = await requireWebsiteSettings(ctx, args.orgId);
    const primaryDomain = await activePrimaryDomain(ctx, args.orgId);
    if (!primaryDomain) throw new ConvexError("Choose a website address before publishing.");
    if (primaryDomain.status !== "active") throw new ConvexError("The selected domain is not active yet.");

    const now = Date.now();
    const publishedSettings = {
      ...settings,
      enabled: true,
      status: "active" as const,
      activeDomainId: primaryDomain._id,
      publishedAt: now,
      updatedAt: now,
    };
    const snapshotJson = await websitePublicProjection(ctx, args.orgId, publishedSettings);
    const snapshotId = await ctx.db.insert("websitePublishSnapshots", {
      orgId: args.orgId,
      websiteSettingsId: settings._id,
      domain: primaryDomain.domain,
      version: `pending-${now}`,
      snapshotJson,
      createdAt: now,
      publishedAt: now,
      publishedByUserId: user._id,
    });
    const snapshotVersion = snapshotId.toString();
    await ctx.db.patch(snapshotId, { version: snapshotVersion });
    await ctx.db.patch(settings._id, {
      enabled: true,
      status: "active",
      activeDomainId: primaryDomain._id,
      publishedAt: now,
      publishedSnapshotId: snapshotId,
      updatedAt: now,
    });
    await ctx.db.patch(primaryDomain._id, {
      publishedSnapshotId: snapshotId,
      updatedAt: now,
    });

    await writeAuditLog(ctx, user, {
      action: "website published",
      targetTable: "websitePublishSnapshots",
      targetId: snapshotId,
      orgId: args.orgId,
    });

    return { snapshotId, version: snapshotVersion, url: `https://${primaryDomain.domain}` };
  },
});

export const unpublish = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_PUBLISH]);
    await requireFeature(ctx, args.orgId, "websiteBuilder");
    const settings = await requireWebsiteSettings(ctx, args.orgId);
    await ctx.db.patch(settings._id, { status: "draft", updatedAt: Date.now() });
    await writeAuditLog(ctx, user, {
      action: "website unpublished",
      targetTable: "websiteSettings",
      targetId: settings._id,
      orgId: args.orgId,
    });
  },
});

export const preview = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_VIEW]);
    await requireFeature(ctx, args.orgId, "websiteBuilder");
    const settings = await requireWebsiteSettings(ctx, args.orgId);
    const projection = await websitePublicProjection(ctx, args.orgId, settings);
    return { ...projection, previewedBy: user._id };
  },
});

export const resolveDomain = query({
  args: { host: v.string() },
  handler: async (ctx, args) => {
    const host = normalizedWebsiteHost(args.host);
    const domain = await ctx.db
      .query("websiteDomains")
      .withIndex("by_domain", (q) => q.eq("domain", host))
      .unique();

    if (!domain || domain.status !== "active") return null;
    if (!(await hasPlanFeature(ctx, domain.orgId, "websiteBuilder"))) return null;
    const settings = await ctx.db.get(domain.websiteSettingsId);
    if (!settings || settings.orgId !== domain.orgId || settings.status !== "active" || !settings.enabled) return null;
    const snapshot = await activePublishedSnapshot(ctx, domain, settings);
    if (!snapshot) return null;
    return {
      ...snapshot.snapshotJson,
      publishedSnapshot: {
        id: snapshot._id,
        domain: snapshot.domain,
        version: snapshot.version,
        publishedAt: snapshot.publishedAt,
      },
    };
  },
});

// Used by the public site-analytics httpAction (convex/http.ts) to resolve a
// host into its owning org without trusting a client-supplied orgId. Unlike
// resolveDomain, this doesn't gate on publish/feature status — traffic should
// still be attributable to an org even while its site is in draft.
export const resolveOrgIdForHost = internalQuery({
  args: { host: v.string() },
  handler: async (ctx, args): Promise<Id<"organizations"> | null> => {
    const host = normalizedWebsiteHost(args.host);
    const domain = await ctx.db
      .query("websiteDomains")
      .withIndex("by_domain", (q) => q.eq("domain", host))
      .unique();
    return domain?.orgId ?? null;
  },
});

export const submitPublicLead = action({
  args: {
    ...publicLeadBaseArgs,
    turnstileToken: v.string(),
  },
  handler: async (ctx, args): Promise<PublicLeadResult> => {
    const clientFingerprint = normalizeLimitKey(
      args.clientFingerprint,
      "Client fingerprint",
      PUBLIC_LEAD_MAX_FINGERPRINT_CHARS,
    );
    if (!clientFingerprint) throw new ConvexError("Request verification failed. Please try again.");

    await verifyTurnstileToken(args.turnstileToken);
    await enforcePublicLeadRateLimit(ctx, "websiteLeadFingerprint", clientFingerprint);

    const { turnstileToken: _turnstileToken, ...leadArgs } = args;
    const result: PublicLeadOutcome = await ctx.runMutation(internal.websites.createPublicLead, {
      ...leadArgs,
      clientFingerprint,
    });
    // Raised out here, after the mutation committed its abuse record.
    if (!result.success) throw new ConvexError(result.message);
    return result;
  },
});

export const createPublicLead = internalMutation({
  args: publicLeadBaseArgs,
  handler: async (ctx, args): Promise<PublicLeadOutcome> => {
    const host = normalizedWebsiteHost(args.host);
    const formType = args.formType as PublicLeadFormType;
    const clientFingerprint = normalizeLimitKey(
      args.clientFingerprint,
      "Client fingerprint",
      PUBLIC_LEAD_MAX_FINGERPRINT_CHARS,
    );
    const clientIpHash = normalizeLimitKey(args.clientIpHash, "Client IP hash", PUBLIC_LEAD_MAX_IP_HASH_CHARS);

    if (!clientFingerprint) throw new ConvexError("Request verification failed. Please try again.");

    // Resolved before the form-type check so the abuse record below has an
    // orgId: websiteLeadAbuseEvents.orgId is required by the schema, and the
    // old ordering passed undefined, so that insert failed validation and the
    // unsupported-form-type case was never recorded at all.
    const domain = await ctx.db
      .query("websiteDomains")
      .withIndex("by_domain", (q) => q.eq("domain", host))
      .unique();
    if (!domain || domain.status !== "active") throw new ConvexError("Website not found.");

    if (!WEBSITE_FORM_TYPES.includes(formType)) {
      await recordWebsiteLeadAbuseEvent(ctx, {
        orgId: domain.orgId,
        host,
        formType: args.formType,
        reason: "validation_failed",
        clientFingerprint,
        clientIpHash,
        detail: "unsupported_form_type",
      });
      return { success: false, message: "Unsupported website form." };
    }
    if (!(await hasPlanFeature(ctx, domain.orgId, "websiteBuilder"))) throw new ConvexError("Website not found.");

    const settings = await ctx.db.get(domain.websiteSettingsId);
    if (!settings || settings.status !== "active" || !settings.enabled) throw new ConvexError("Website is not active.");
    const snapshot = await activePublishedSnapshot(ctx, domain, settings);
    if (!snapshot) throw new ConvexError("Website is not active.");

    const firstName = normalizeRequiredText(args.firstName, "Name", PUBLIC_LEAD_MAX_NAME_CHARS);
    const lastName = normalizeText(args.lastName, "Last name", PUBLIC_LEAD_MAX_NAME_CHARS) ?? "Website Lead";
    const email = normalizeEmail(args.email);
    const phone = normalizePhone(args.phone, "Phone");
    const whatsapp = normalizePhone(args.whatsapp, "WhatsApp");
    const message = normalizeText(args.message, "Message", PUBLIC_LEAD_MAX_MESSAGE_CHARS);
    if (!email && !phone && !whatsapp) {
      await recordWebsiteLeadAbuseEvent(ctx, {
        orgId: domain.orgId,
        host,
        formType,
        reason: "validation_failed",
        clientFingerprint,
        clientIpHash,
        detail: "missing_contact_method",
      });
      return { success: false, message: "Provide an email, phone, or WhatsApp number." };
    }

    const contactKey = email ?? phone ?? whatsapp;
    if (!contactKey) throw new ConvexError("Provide an email, phone, or WhatsApp number.");

    const block = await findWebsiteLeadBlock(ctx, {
      orgId: domain.orgId,
      host,
      clientFingerprint,
      clientIpHash,
      email,
      phone,
      whatsapp,
    });
    if (block) {
      await recordWebsiteLeadAbuseEvent(ctx, {
        orgId: domain.orgId,
        host,
        formType,
        reason: "blocked",
        clientFingerprint,
        clientIpHash,
        contactKey,
        detail: block.kind,
      });
      return { success: false, message: "This request cannot be accepted." };
    }

    try {
      await enforcePublicLeadRateLimit(ctx, "websiteLeadHost", host);
      await enforcePublicLeadRateLimit(ctx, "websiteLeadOrg", domain.orgId);
      await enforcePublicLeadRateLimit(ctx, "websiteLeadContact", contactKey);
      if (clientIpHash) await enforcePublicLeadRateLimit(ctx, "websiteLeadFingerprint", clientIpHash);
    } catch (error) {
      await recordWebsiteLeadAbuseEvent(ctx, {
        orgId: domain.orgId,
        host,
        formType,
        reason: "rate_limited",
        clientFingerprint,
        clientIpHash,
        contactKey,
        detail: error instanceof Error ? error.message : "rate_limited",
      });
      return {
        success: false,
        message: error instanceof Error ? error.message : "Too many requests. Please try again later.",
      };
    }

    const sections = snapshotSectionMap(snapshot.snapshotJson);
    const formSectionKey = sectionKeyForWebsiteForm(formType);
    if (sections[formSectionKey] === false) throw new ConvexError("This form is not enabled.");

    const vehicleId = args.vehicleId;
    if (vehicleId) {
      const vehicle = await ctx.db.get(vehicleId);
      if (!vehicle || vehicle.orgId !== domain.orgId || vehicle.isDeleted) {
        throw new ConvexError("Vehicle not found.");
      }
    }

    const routing = await ctx.db
      .query("websiteLeadRouting")
      .withIndex("by_org_settings_form", (q) =>
        q.eq("orgId", domain.orgId).eq("websiteSettingsId", settings._id).eq("formType", formType)
      )
      .unique();

    let customerId: Id<"customers"> | null = null;
    if (email) {
      customerId = (await ctx.db
        .query("customers")
        .withIndex("by_org_email", (q) => q.eq("orgId", domain.orgId).eq("email", email))
        .first())?._id ?? null;
    }
    if (!customerId && phone) {
      customerId = (await ctx.db
        .query("customers")
        .withIndex("by_org_phone", (q) => q.eq("orgId", domain.orgId).eq("phone", phone))
        .first())?._id ?? null;
    }
    if (!customerId && whatsapp) {
      customerId = (await ctx.db
        .query("customers")
        .withIndex("by_org_whatsapp", (q) => q.eq("orgId", domain.orgId).eq("whatsapp", whatsapp))
        .first())?._id ?? null;
    }

    if (customerId) {
      const existingLeads = await ctx.db
        .query("leads")
        .withIndex("by_org_customer", (q) => q.eq("orgId", domain.orgId).eq("customerId", customerId!))
        .order("desc")
        .take(10);
      const source = `Dealer website: ${formType}`;
      const duplicate = existingLeads.find(
        (lead) =>
          !lead.isDeleted &&
          OPEN_LEAD_STAGES.has(lead.stage) &&
          lead.source === source &&
          (lead.vehicleId ?? null) === (vehicleId ?? null) &&
          Date.now() - lead._creationTime <= PUBLIC_LEAD_DUPLICATE_WINDOW_MS,
      );
      if (duplicate) {
        await recordWebsiteLeadAbuseEvent(ctx, {
          orgId: domain.orgId,
          host,
          formType,
          reason: "duplicate_suppressed",
          clientFingerprint,
          clientIpHash,
          contactKey,
        });
        return { success: true, leadId: duplicate._id, duplicate: true };
      }
    } else {
      customerId = await ctx.db.insert("customers", {
        orgId: domain.orgId,
        firstName,
        lastName,
        email,
        phone,
        whatsapp,
      });
    }

    const assignedUserId = await resolveGeneratedLeadAssignee(ctx, domain.orgId, routing?.routeToUserId);

    const leadId = await ctx.db.insert("leads", {
      orgId: domain.orgId,
      branchId: routing?.routeToBranchId,
      customerId,
      assignedUserId,
      vehicleId,
      source: `Dealer website: ${formType}`,
      stage: formType === "test_drive" ? "TEST_DRIVE" : "NEW",
      notes: message,
    });

    await recordLeadCreated(ctx, {
      orgId: domain.orgId,
      leadId,
      actorLabel: "Dealer website",
      stage: formType === "test_drive" ? "TEST_DRIVE" : "NEW",
      assignedUserId,
      source: `Dealer website: ${formType}`,
    });

    if (assignedUserId) {
      await notifyUser(
        ctx,
        domain.orgId,
        assignedUserId,
        "lead.assigned",
        { actorName: "AutoFlow" },
        { link: `/${domain.orgId}/leads?highlightId=${leadId}` }
      );
    }

    if (routing?.createTask && assignedUserId) {
      await ctx.db.insert("tasks", {
        orgId: domain.orgId,
        assignedTo: assignedUserId,
        title: formType === "test_drive" ? "Website test drive request" : "Follow up website lead",
        description: message,
        dueDate: args.preferredDate ?? Date.now() + 24 * 60 * 60 * 1000,
        status: "PENDING",
        priority: "MEDIUM",
        customerId,
        leadId,
        vehicleId,
      });
    }

    return { success: true, leadId };
  },
});

// ─── Public-lead blocklist management ────────────────────────────────────────
//
// The blocklist existed as a table and a read and nothing else: no mutation,
// query, or script anywhere wrote a row, so the abuse control the public lead
// path consults had no way to ever be populated. These are that missing write
// path. Values are hashed through `websiteLeadBlocklistValueHash` — the same
// function `findWebsiteLeadBlock` hashes its candidates with — so an entry
// saved here is one the read side can actually match.

const blocklistKindValidator = v.union(
  v.literal("fingerprint"),
  v.literal("ipHash"),
  v.literal("email"),
  v.literal("emailDomain"),
  v.literal("phone")
);

const PUBLIC_LEAD_MAX_BLOCKLIST_VALUE_CHARS = 256;
const PUBLIC_LEAD_MAX_BLOCKLIST_REASON_CHARS = 300;

/**
 * Blocks a value from submitting public website leads for this org.
 *
 * `value` is the value **as the visitor's browser would send it** for that
 * kind, not a digest: a raw email/phone/domain, the client fingerprint, or the
 * `clientIpHash` string (which arrives pre-hashed from the edge and is what
 * `websiteLeadAbuseEvents.clientIpHash` displays). Normalisation and hashing
 * happen server-side, so an operator never has to reproduce either by hand.
 *
 * Re-blocking a value already on the list refreshes the existing row rather
 * than inserting a second one, so repeated blocks cannot grow the table
 * without bound or leave stale duplicates with conflicting expiry.
 */
export const addLeadBlocklistEntry = mutation({
  args: {
    orgId: v.id("organizations"),
    kind: blocklistKindValidator,
    value: v.string(),
    /** Restrict the block to a single one of the org's hosts. Omit for org-wide. */
    host: v.optional(v.string()),
    reason: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"websiteLeadBlocklist">> => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_LEADS_MANAGE]);
      await requireFeature(ctx, args.orgId, "websiteBuilder");

      const rawValue = normalizeLimitKey(args.value, "Value", PUBLIC_LEAD_MAX_BLOCKLIST_VALUE_CHARS);
      if (!rawValue) throw new ConvexError("A value to block is required.");
      // Normalisation can empty a value that was only punctuation ("---" as a
      // phone, say). Storing the digest of "" would block every submission
      // whose corresponding field normalised away, so refuse it here.
      if (!normalizeBlocklistValue(args.kind, rawValue)) {
        throw new ConvexError("That value is not valid for this block type.");
      }
      const reason = normalizeText(args.reason, "Reason", PUBLIC_LEAD_MAX_BLOCKLIST_REASON_CHARS);
      if (args.expiresAt !== undefined && !Number.isFinite(args.expiresAt)) {
        throw new ConvexError("Expiry is invalid.");
      }

      // A host-scoped entry may only name a host this org actually owns —
      // otherwise one org could seed rows keyed to another org's domain.
      let host: string | undefined;
      if (args.host !== undefined) {
        const normalizedHost = normalizedWebsiteHost(args.host);
        const domain = await ctx.db
          .query("websiteDomains")
          .withIndex("by_domain", (q) => q.eq("domain", normalizedHost))
          .unique();
        if (!domain || domain.orgId !== args.orgId) {
          throw new ConvexError("That website address does not belong to this organization.");
        }
        host = normalizedHost;
      }

      const valueHash = await websiteLeadBlocklistValueHash(args.kind, rawValue);

      const existing = (
        await ctx.db
          .query("websiteLeadBlocklist")
          .withIndex("by_org_kind_valueHash", (q) =>
            q.eq("orgId", args.orgId).eq("kind", args.kind).eq("valueHash", valueHash),
          )
          .collect()
      ).find((row) => row.host === host);

      if (existing) {
        await ctx.db.patch(existing._id, {
          reason,
          expiresAt: args.expiresAt,
          createdAt: Date.now(),
          createdBy: user._id,
        });
        await writeAuditLog(ctx, user, {
          action: "website lead blocklist entry updated",
          targetTable: "websiteLeadBlocklist",
          targetId: existing._id,
          orgId: args.orgId,
          before: { reason: existing.reason, expiresAt: existing.expiresAt },
          after: { kind: args.kind, host, reason, expiresAt: args.expiresAt },
        });
        return existing._id;
      }

      const entryId = await ctx.db.insert("websiteLeadBlocklist", {
        orgId: args.orgId,
        host,
        kind: args.kind,
        valueHash,
        reason,
        expiresAt: args.expiresAt,
        createdAt: Date.now(),
        createdBy: user._id,
      });

      await writeAuditLog(ctx, user, {
        action: "website lead blocklist entry added",
        targetTable: "websiteLeadBlocklist",
        targetId: entryId,
        orgId: args.orgId,
        after: { kind: args.kind, host, reason, expiresAt: args.expiresAt },
      });

      return entryId;
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("websites.addLeadBlocklistEntry failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/** Lifts a block. The entry is addressed by id, so it must be proven to belong to `orgId` first. */
export const removeLeadBlocklistEntry = mutation({
  args: {
    orgId: v.id("organizations"),
    entryId: v.id("websiteLeadBlocklist"),
  },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_LEADS_MANAGE]);
      await requireFeature(ctx, args.orgId, "websiteBuilder");

      // Caller-supplied id alongside an orgId: requireTenantAuth only proves
      // the caller may act inside the org they named, never that this row is
      // in it.
      const entry = await requireOwnedRow(
        ctx,
        args.orgId,
        "websiteLeadBlocklist",
        args.entryId,
        "Blocklist entry not found in this organization.",
      );

      await ctx.db.delete(args.entryId);

      await writeAuditLog(ctx, user, {
        action: "website lead blocklist entry removed",
        targetTable: "websiteLeadBlocklist",
        targetId: args.entryId,
        orgId: args.orgId,
        before: { kind: entry.kind, host: entry.host, reason: entry.reason, expiresAt: entry.expiresAt },
      });
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("websites.removeLeadBlocklistEntry failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * The org's current blocklist. `valueHash` is deliberately not returned: it is
 * a digest of a visitor's email or phone number, and nothing in the product
 * needs it — an entry is identified by its `_id`, described by kind/host/reason
 * and removed by id.
 */
export const listLeadBlocklist = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_LEADS_MANAGE]);
    const rows = await ctx.db
      .query("websiteLeadBlocklist")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(200);
    const now = Date.now();
    return rows.map((row) => ({
      _id: row._id,
      kind: row.kind,
      host: row.host ?? null,
      reason: row.reason ?? null,
      expiresAt: row.expiresAt ?? null,
      expired: row.expiresAt !== undefined && row.expiresAt <= now,
      createdAt: row.createdAt,
      createdBy: row.createdBy ?? null,
    }));
  },
});
