import { ConvexError, v } from "convex/values";
import { ActionCtx, MutationCtx, QueryCtx, action, internalMutation, mutation, query } from "./_generated/server";
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
import { requireTenantAuth } from "./utils/tenancy";
import { writeAuditLog } from "./utils/auditLog";
import { resolveGeneratedLeadAssignee } from "./utils/leadAssignment";
import { notifyUser } from "./utils/notifications";
import { getValidatedEnv } from "./utils/env";
import { rateLimiter } from "./rateLimit";
import { hasPlanFeature, requireFeature } from "./subscriptions";

const PUBLIC_LEAD_MAX_NAME_CHARS = 80;
const PUBLIC_LEAD_MAX_EMAIL_CHARS = 254;
const PUBLIC_LEAD_MAX_PHONE_CHARS = 24;
const PUBLIC_LEAD_MAX_MESSAGE_CHARS = 2000;
const PUBLIC_LEAD_MAX_FINGERPRINT_CHARS = 256;
const PUBLIC_LEAD_MAX_IP_HASH_CHARS = 128;
const PUBLIC_LEAD_DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const TURNSTILE_ACTION = "turnstile-spin-v1";

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

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value);
}

function normalizeText(value: string | undefined, field: string, maxLength: number): string | undefined {
  const text = value?.trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  if (text.length > maxLength || hasControlCharacters(text)) {
    throw new ConvexError(`${field} is invalid.`);
  }
  return text;
}

function normalizeRequiredText(value: string, field: string, maxLength: number): string {
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

async function verifyTurnstileToken(token: string): Promise<void> {
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
    const rows = await ctx.db
      .query("websiteLeadBlocklist")
      .withIndex("by_kind_and_valueHash", (q) =>
        q.eq("kind", candidate.kind).eq("valueHash", candidate.value),
      )
      .take(10);
    const active = rows.find((row) => {
      if (row.expiresAt !== undefined && row.expiresAt <= now) return false;
      if (row.orgId !== undefined && row.orgId !== args.orgId) return false;
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

async function getSettingsByOrg(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
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

async function activePrimaryDomain(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">) {
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
    logoUrl: v.optional(v.string()),
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
      "logoUrl",
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
    const result: PublicLeadResult = await ctx.runMutation(internal.websites.createPublicLead, {
      ...leadArgs,
      clientFingerprint,
    });
    return result;
  },
});

export const createPublicLead = internalMutation({
  args: publicLeadBaseArgs,
  handler: async (ctx, args): Promise<PublicLeadResult> => {
    const host = normalizedWebsiteHost(args.host);
    const formType = args.formType as PublicLeadFormType;
    const clientFingerprint = normalizeLimitKey(
      args.clientFingerprint,
      "Client fingerprint",
      PUBLIC_LEAD_MAX_FINGERPRINT_CHARS,
    );
    const clientIpHash = normalizeLimitKey(args.clientIpHash, "Client IP hash", PUBLIC_LEAD_MAX_IP_HASH_CHARS);

    if (!clientFingerprint) throw new ConvexError("Request verification failed. Please try again.");
    if (!WEBSITE_FORM_TYPES.includes(formType)) {
      await recordWebsiteLeadAbuseEvent(ctx, {
        host,
        formType: args.formType,
        reason: "validation_failed",
        clientFingerprint,
        clientIpHash,
        detail: "unsupported_form_type",
      });
      throw new ConvexError("Unsupported website form.");
    }

    const domain = await ctx.db
      .query("websiteDomains")
      .withIndex("by_domain", (q) => q.eq("domain", host))
      .unique();
    if (!domain || domain.status !== "active") throw new ConvexError("Website not found.");
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
      throw new ConvexError("Provide an email, phone, or WhatsApp number.");
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
      throw new ConvexError("This request cannot be accepted.");
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
      throw error;
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
