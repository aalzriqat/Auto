import { v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requireSuperAdmin } from "./utils/tenancy";
import { notifyAllMembers } from "./utils/notifications";
import { logAdminAction } from "./adminAudit";
import { getValidatedEnv } from "./utils/env";

const changelogTypeValidator = v.union(v.literal("FEATURE"), v.literal("FIX"), v.literal("IMPROVEMENT"));

const changelogEntryArgs = {
  type: changelogTypeValidator,
  titleEn: v.string(),
  titleAr: v.string(),
  descriptionEn: v.string(),
  descriptionAr: v.string(),
  publishedAt: v.optional(v.number()),
  notifyUsers: v.optional(v.boolean()),
};

type ChangelogEntryArgs = {
  type: "FEATURE" | "FIX" | "IMPROVEMENT";
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  descriptionAr: string;
  publishedAt?: number;
  notifyUsers?: boolean;
};

/** Shared by `create` and `createInternal` — the only difference between them is how `admin` is resolved. */
async function insertChangelogEntry(
  ctx: MutationCtx,
  admin: Doc<"users">,
  args: ChangelogEntryArgs,
  action: "changelog:create" | "changelog:createInternal"
) {
  const now = Date.now();
  const entryId = await ctx.db.insert("changelogEntries", {
    type: args.type,
    titleEn: args.titleEn,
    titleAr: args.titleAr,
    descriptionEn: args.descriptionEn,
    descriptionAr: args.descriptionAr,
    publishedAt: args.publishedAt ?? now,
    createdBy: admin._id,
    createdAt: now,
  });

  if (args.notifyUsers) {
    // Fanning out to every org/member can be a lot of work — hand it to a
    // self-paginating scheduled mutation so this insert never blocks on (or
    // fails because of) the size of that fan-out.
    await ctx.scheduler.runAfter(0, internal.changelog.broadcastNewEntry, {
      titleEn: args.titleEn,
      descriptionEn: args.descriptionEn,
    });
  }

  await logAdminAction(ctx, admin, {
    action,
    targetTable: "changelogEntries",
    targetId: entryId,
    after: { type: args.type, titleEn: args.titleEn, notifyUsers: args.notifyUsers ?? false },
  });

  return entryId;
}

export const create = mutation({
  args: changelogEntryArgs,
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    return insertChangelogEntry(ctx, admin, args, "changelog:create");
  },
});

/**
 * Automation-only entry point for creating a changelog entry without a live
 * Clerk session — invoked via `npx convex run changelog:createInternal '{...}' --prod`.
 * Internal mutations are never reachable by any client (browser, mobile, or
 * public API), only by the Convex CLI with deploy-key auth or server-side
 * code, so this is safe without its own auth check — it just needs a real
 * `users` row to attribute the entry to, resolved from the first configured
 * SUPER_ADMIN_EMAILS address rather than a mutation argument.
 */
/**
 * The user an automation-run change is attributed to: the first configured
 * SUPER_ADMIN_EMAILS address, resolved to its `users` row. Shared by the
 * internal create/update entry points, which run under deploy-key auth with no
 * Clerk session and so have no caller identity of their own to record.
 */
async function resolveAutomationAdmin(ctx: MutationCtx): Promise<Doc<"users">> {
  const attributedEmail = (getValidatedEnv().SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)[0];
  if (!attributedEmail) {
    throw new Error("SUPER_ADMIN_EMAILS is not set on this deployment — cannot attribute an automated changelog change.");
  }
  const admin = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", attributedEmail))
    .unique();
  if (!admin) {
    throw new Error(`No user found for super-admin email "${attributedEmail}" — cannot attribute an automated changelog change.`);
  }
  return admin;
}

export const createInternal = internalMutation({
  args: changelogEntryArgs,
  handler: async (ctx, args) => {
    const admin = await resolveAutomationAdmin(ctx);
    return insertChangelogEntry(ctx, admin, args, "changelog:createInternal");
  },
});

/**
 * Automation-only counterpart to `update`, for correcting a published entry's
 * wording from the CLI without a live Clerk session (same reason
 * `createInternal` exists — see its comment). Patches only the fields provided,
 * so a typo fix touches nothing else.
 *
 * Deliberately never touches `publishedAt` and never broadcasts: the copies
 * already fanned out to inboxes are immutable point-in-time notifications, and
 * a wording fix must not re-surface an old entry as unread or re-notify anyone.
 * It only corrects what the What's New panel shows going forward.
 */
export const updateInternal = internalMutation({
  args: {
    entryId: v.id("changelogEntries"),
    type: v.optional(changelogTypeValidator),
    titleEn: v.optional(v.string()),
    titleAr: v.optional(v.string()),
    descriptionEn: v.optional(v.string()),
    descriptionAr: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const admin = await resolveAutomationAdmin(ctx);
    const { entryId, ...updates } = args;

    const existing = await ctx.db.get(entryId);
    if (!existing) throw new Error("Changelog entry not found.");

    const patch = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length === 0) throw new Error("No fields provided to update.");

    await ctx.db.patch(entryId, { ...patch, updatedAt: Date.now(), updatedBy: admin._id });

    await logAdminAction(ctx, admin, {
      action: "changelog:updateInternal",
      targetTable: "changelogEntries",
      targetId: entryId,
      before: { titleEn: existing.titleEn, descriptionEn: existing.descriptionEn },
      after: { titleEn: updates.titleEn ?? existing.titleEn, descriptionEn: updates.descriptionEn ?? existing.descriptionEn },
    });
  },
});

const BROADCAST_BATCH_SIZE = 50;

/**
 * Notifies every org's members about a new changelog entry, one page of orgs
 * at a time, self-rescheduling until done. This is the same "notify every
 * org" shape as adminBroadcasts.create, just paginated instead of a single
 * unbounded loop, since this mutation runs on its own schedule rather than
 * inline with a super-admin's create-entry click.
 */
export const broadcastNewEntry = internalMutation({
  args: {
    titleEn: v.string(),
    descriptionEn: v.string(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("organizations")
      .paginate({ cursor: args.cursor ?? null, numItems: BROADCAST_BATCH_SIZE });

    for (const org of page.page) {
      await notifyAllMembers(ctx, org._id, "system.announcement", {
        title: args.titleEn,
        message: args.descriptionEn,
      }, { link: "/whats-new" });
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.changelog.broadcastNewEntry, {
        titleEn: args.titleEn,
        descriptionEn: args.descriptionEn,
        cursor: page.continueCursor,
      });
    }
  },
});

export const update = mutation({
  args: {
    entryId: v.id("changelogEntries"),
    type: changelogTypeValidator,
    titleEn: v.string(),
    titleAr: v.string(),
    descriptionEn: v.string(),
    descriptionAr: v.string(),
    // Optional and left untouched unless explicitly provided — publishedAt
    // drives both display ordering and the unread-dot indicator, so a plain
    // typo fix must not silently re-publish (and re-notify-as-unread) an old
    // entry. Pass this only for a deliberate republish/backdate.
    publishedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const { entryId, ...updates } = args;

    const existing = await ctx.db.get(entryId);
    if (!existing) throw new Error("Changelog entry not found.");

    await ctx.db.patch(entryId, {
      ...updates,
      publishedAt: updates.publishedAt ?? existing.publishedAt,
      updatedAt: Date.now(),
      updatedBy: admin._id,
    });

    await logAdminAction(ctx, admin, {
      action: "changelog:update",
      targetTable: "changelogEntries",
      targetId: entryId,
      before: { titleEn: existing.titleEn, type: existing.type },
      after: { titleEn: updates.titleEn, type: updates.type },
    });
  },
});

export const remove = mutation({
  args: { entryId: v.id("changelogEntries") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const existing = await ctx.db.get(args.entryId);
    if (!existing) throw new Error("Changelog entry not found.");

    await ctx.db.delete(args.entryId);

    await logAdminAction(ctx, admin, {
      action: "changelog:delete",
      targetTable: "changelogEntries",
      targetId: args.entryId,
      before: { titleEn: existing.titleEn, type: existing.type },
    });
  },
});

/** Visible to any authenticated user — this is a product-wide "What's New" log, not admin-only. */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireAuth(ctx);
    return await ctx.db
      .query("changelogEntries")
      .withIndex("by_publishedAt")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

/** Cheap existence + latest-timestamp check for the unread-dot indicator in TopNav. */
export const getLatestPublishedAt = query({
  args: {},
  handler: async (ctx) => {
    await requireAuth(ctx);
    const latest = await ctx.db
      .query("changelogEntries")
      .withIndex("by_publishedAt")
      .order("desc")
      .first();
    return latest?.publishedAt ?? null;
  },
});

type ChangelogType = "FEATURE" | "FIX" | "IMPROVEMENT";

type HistoricalChangelogEntry = {
  type: ChangelogType;
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  descriptionAr: string;
  publishedAt: number;
};

const releaseAt = (year: number, month: number, day: number, sequence: number) =>
  Date.UTC(year, month - 1, day, 12, sequence, 0);

const HISTORICAL_ENTRIES: HistoricalChangelogEntry[] = [
  {
    type: "FEATURE",
    titleEn: "AutoFlow dealership workspace is live",
    titleAr: "إطلاق مساحة عمل أوتوفلو للمعارض",
    descriptionEn: "The first AutoFlow workspace brought organizations, roles, inventory, customers, leads, and sales together so dealership teams can run their daily work from one place.",
    descriptionAr: "أصبحت مساحة عمل أوتوفلو الأولى تجمع المؤسسات والصلاحيات والمخزون والعملاء والعملاء المحتملين والمبيعات حتى يدير فريق المعرض عمله اليومي من مكان واحد.",
    publishedAt: releaseAt(2026, 6, 3, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Dashboard, CRM, leads, sales, and team modules",
    titleAr: "لوحة التحكم وإدارة العملاء والعملاء المحتملين والمبيعات والفريق",
    descriptionEn: "Added the main dashboard stats, vehicle inventory management, customer records, lead tracking, sales and revenue tracking, team management, analytics, tasks, expenses, repairs, and work-order foundations.",
    descriptionAr: "تمت إضافة إحصاءات لوحة التحكم وإدارة مخزون السيارات وسجلات العملاء وتتبع العملاء المحتملين وتتبع المبيعات والإيرادات وإدارة الفريق والتحليلات والمهام والمصاريف والإصلاحات وأساس أوامر العمل.",
    publishedAt: releaseAt(2026, 6, 4, 1),
  },
  {
    type: "FEATURE",
    titleEn: "PDF documents and bilingual RTL interface",
    titleAr: "مستندات PDF وواجهة ثنائية اللغة تدعم RTL",
    descriptionEn: "AutoFlow added generated PDF documents, a modern interface theme, Arabic localization, and right-to-left layout support for Arabic users.",
    descriptionAr: "أضاف أوتوفلو مستندات PDF مولّدة وواجهة حديثة وتعريباً ودعماً لاتجاه الكتابة من اليمين إلى اليسار للمستخدمين العرب.",
    publishedAt: releaseAt(2026, 6, 4, 2),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Reports, team performance, expenses, and work orders improved",
    titleAr: "تحسين التقارير وأداء الفريق والمصاريف وأوامر العمل",
    descriptionEn: "Reports, team views, expenses, repairs, and work orders were expanded with more status, vendor, payer, and performance detail for day-to-day dealership operations.",
    descriptionAr: "تم توسيع التقارير وواجهات الفريق والمصاريف والإصلاحات وأوامر العمل بتفاصيل أكثر عن الحالة والمورّد والدافع والأداء لدعم العمليات اليومية للمعرض.",
    publishedAt: releaseAt(2026, 6, 6, 1),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Simpler team account setup",
    titleAr: "إعداد أبسط لحسابات الفريق",
    descriptionEn: "Team members can be created directly instead of relying only on invitation flow, with follow-up fixes for username creation, Clerk sync, and cleanup when a member is removed.",
    descriptionAr: "يمكن إنشاء أعضاء الفريق مباشرة بدلاً من الاعتماد فقط على الدعوات، مع إصلاحات لإنشاء اسم المستخدم ومزامنة Clerk وتنظيف الحساب عند حذف العضو.",
    publishedAt: releaseAt(2026, 6, 6, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Financing engine, applications, and deal closure",
    titleAr: "محرك التمويل والطلبات وإغلاق الصفقات",
    descriptionEn: "Added financing rules, document requirements, finance applications, deal closure flows, branch management, and Arabic translations for the finance workflow.",
    descriptionAr: "تمت إضافة قواعد التمويل ومتطلبات المستندات وطلبات التمويل وتدفقات إغلاق الصفقات وإدارة الفروع وترجمة عربية لمسار التمويل.",
    publishedAt: releaseAt(2026, 6, 7, 1),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Arabic coverage and RTL fixes across more screens",
    titleAr: "تغطية عربية وإصلاحات RTL عبر شاشات أكثر",
    descriptionEn: "Navigation, reports, team pages, vehicle valuations, document rules, dialogs, roles, dashboard labels, and tab layouts received Arabic and RTL fixes.",
    descriptionAr: "تم إصلاح التعريب واتجاه RTL في التنقل والتقارير وصفحات الفريق وتقييمات السيارات وقواعد المستندات والنوافذ والصلاحيات وتسميات لوحة التحكم وتخطيط التبويبات.",
    publishedAt: releaseAt(2026, 6, 7, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Stock valuation and LTV guardrails",
    titleAr: "تقييم المخزون وضوابط نسبة التمويل",
    descriptionEn: "Added dealership spreadsheet valuation logic and stricter loan-to-value checks so financing offers follow the configured valuation rules.",
    descriptionAr: "تمت إضافة منطق تقييم من ملف مخزون المعرض وضوابط أكثر صرامة لنسبة التمويل إلى القيمة حتى تلتزم عروض التمويل بقواعد التقييم المحددة.",
    publishedAt: releaseAt(2026, 6, 7, 3),
  },
  {
    type: "FIX",
    titleEn: "Protected purchase-price visibility",
    titleAr: "حماية ظهور سعر الشراء",
    descriptionEn: "Purchase-price details are now stripped for roles that should not see dealer cost information, reducing accidental cost exposure.",
    descriptionAr: "أصبحت تفاصيل سعر الشراء مخفية عن الأدوار التي لا يجب أن ترى تكلفة المعرض، مما يقلل احتمال كشف التكلفة بالخطأ.",
    publishedAt: releaseAt(2026, 6, 7, 4),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Sales portal and printable quote upgrades",
    titleAr: "تحسين بوابة المبيعات وعروض الأسعار القابلة للطباعة",
    descriptionEn: "Sales users received a better portal experience, Arabic-friendly quote PDF generation, printable quote layouts, signatures, and custom quote footers.",
    descriptionAr: "حصل مستخدمو المبيعات على تجربة أفضل في البوابة، وإنشاء PDF مناسب للعربية، وتخطيطات عروض أسعار للطباعة، وتواقيع، وتذييل مخصص للعروض.",
    publishedAt: releaseAt(2026, 6, 11, 1),
  },
  {
    type: "FIX",
    titleEn: "Friendlier bilingual error messages",
    titleAr: "رسائل أخطاء أوضح باللغتين",
    descriptionEn: "Technical server and validation errors are now translated into safer, user-friendly English and Arabic toasts instead of leaking developer details.",
    descriptionAr: "أصبحت أخطاء الخادم والتحقق التقنية تظهر كرسائل آمنة وواضحة بالإنجليزية والعربية بدلاً من عرض تفاصيل مخصصة للمطورين.",
    publishedAt: releaseAt(2026, 6, 13, 1),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Production hardening and monitoring",
    titleAr: "تقوية الإنتاج والمراقبة",
    descriptionEn: "Added stronger validation, environment checks, rate limiting, Sentry monitoring, test coverage foundations, CI checks, and safer backend error handling.",
    descriptionAr: "تمت إضافة تحقق أقوى من المدخلات، وفحص إعدادات البيئة، وتحديد معدلات الطلبات، ومراقبة Sentry، وأساسات الاختبارات، وفحوصات CI، وتعامل آمن أكثر مع أخطاء الخادم.",
    publishedAt: releaseAt(2026, 6, 13, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Searchable selects and saved sales drafts",
    titleAr: "قوائم بحث وحفظ مسودات المبيعات",
    descriptionEn: "High-volume dropdowns were replaced with searchable selectors, and the sales wizard now saves in-progress drafts so work can resume after a refresh.",
    descriptionAr: "تم استبدال القوائم الطويلة بمحددات قابلة للبحث، وأصبح معالج البيع يحفظ المسودات الجارية حتى يمكن استكمالها بعد تحديث الصفحة.",
    publishedAt: releaseAt(2026, 6, 14, 1),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Vehicle import matches dealership spreadsheets",
    titleAr: "استيراد السيارات يطابق ملفات المعرض",
    descriptionEn: "The vehicle import template now matches the dealership spreadsheet layout, including better make/model splitting when source columns are incomplete.",
    descriptionAr: "أصبح قالب استيراد السيارات يطابق تخطيط ملف المعرض، مع فصل أفضل للماركة والموديل عندما تكون أعمدة المصدر غير مكتملة.",
    publishedAt: releaseAt(2026, 6, 14, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Better VIN decoding and optional mileage import",
    titleAr: "فك VIN أفضل واستيراد عداد اختياري",
    descriptionEn: "VIN decoding now combines WMI and NHTSA results in parallel, improves international make/model detection, and lets mileage be optional during imports.",
    descriptionAr: "أصبح فك رقم VIN يجمع نتائج WMI وNHTSA بالتوازي، ويحسن اكتشاف الماركة والموديل عالمياً، ويجعل عداد المسافة اختيارياً أثناء الاستيراد.",
    publishedAt: releaseAt(2026, 6, 15, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Organization settings and configurable sales flow",
    titleAr: "إعدادات المؤسسة وتدفق مبيعات قابل للتخصيص",
    descriptionEn: "Added organization currency, country, VAT, payment types, lead sources, valuation companies, pipeline stages, and configurable approval thresholds.",
    descriptionAr: "تمت إضافة العملة والدولة والضريبة وطرق الدفع ومصادر العملاء المحتملين وشركات التقييم ومراحل المسار وحدود الموافقة القابلة للتخصيص لكل مؤسسة.",
    publishedAt: releaseAt(2026, 6, 15, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Branding, WhatsApp setup, custom fields, commissions, and onboarding",
    titleAr: "الهوية وواتساب والحقول المخصصة والعمولات والتهيئة",
    descriptionEn: "Added org logo and brand color, WhatsApp settings, custom fields for vehicles/customers/leads, commission tiers, and a guided onboarding wizard for new organizations.",
    descriptionAr: "تمت إضافة شعار المؤسسة ولون الهوية وإعدادات واتساب وحقول مخصصة للسيارات والعملاء والعملاء المحتملين وشرائح العمولات ومعالج تهيئة للمؤسسات الجديدة.",
    publishedAt: releaseAt(2026, 6, 15, 3),
  },
  {
    type: "FEATURE",
    titleEn: "Branded quotes and bill of sale",
    titleAr: "عروض أسعار وعقد بيع بهوية المعرض",
    descriptionEn: "Quotes and bill-of-sale documents can now use the organization's branding instead of hardcoded dealership defaults.",
    descriptionAr: "أصبحت عروض الأسعار وعقود البيع تستخدم هوية المؤسسة بدلاً من قيم معرض ثابتة داخل النظام.",
    publishedAt: releaseAt(2026, 6, 16, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Feedback widget and admin inbox",
    titleAr: "أداة ملاحظات وصندوق وارد للإدارة",
    descriptionEn: "Users can submit bugs or feature requests from inside the dashboard, and owners/admins can review and manage those submissions.",
    descriptionAr: "يمكن للمستخدمين إرسال أخطاء أو طلبات ميزات من داخل لوحة التحكم، ويمكن للمالكين أو الإدارة مراجعة هذه الملاحظات وإدارتها.",
    publishedAt: releaseAt(2026, 6, 16, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Commission modes and vehicle total cost in sales",
    titleAr: "أنماط العمولات وإجمالي تكلفة السيارة في المبيعات",
    descriptionEn: "Added automatic tier commissions, member-based commissions, manual commission entry, and clearer vehicle total cost in the sales wizard.",
    descriptionAr: "تمت إضافة عمولات تلقائية حسب الشرائح وعمولات حسب العضو وإدخال يدوي للعمولة، مع عرض أوضح لإجمالي تكلفة السيارة في معالج البيع.",
    publishedAt: releaseAt(2026, 6, 16, 3),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Mobile-first dashboard improvements",
    titleAr: "تحسينات لوحة التحكم للموبايل أولاً",
    descriptionEn: "Dashboard pages, navigation, sidebars, drawers, and key lists were adjusted for smaller screens and touch-first use.",
    descriptionAr: "تم تحسين صفحات لوحة التحكم والتنقل والقوائم الجانبية والأدراج والقوائم الأساسية للشاشات الصغيرة والاستخدام باللمس.",
    publishedAt: releaseAt(2026, 6, 16, 4),
  },
  {
    type: "FIX",
    titleEn: "Safer draft and pending-deal cleanup",
    titleAr: "تنظيف آمن للمسودات والصفقات المعلقة",
    descriptionEn: "Added cancel and discard actions for in-progress drafts and pending deals, plus fixes for duplicate customer creation and vehicle-step crashes in the sales wizard.",
    descriptionAr: "تمت إضافة أزرار إلغاء وحذف للمسودات الجارية والصفقات المعلقة، مع إصلاح تكرار إنشاء العميل وتعطل خطوة السيارة في معالج البيع.",
    publishedAt: releaseAt(2026, 6, 16, 5),
  },
  {
    type: "FIX",
    titleEn: "Stronger organization scoping and notification privacy",
    titleAr: "عزل أقوى للمؤسسات وخصوصية للإشعارات",
    descriptionEn: "Closed cross-organization access gaps, moved dashboard routes under org-scoped paths, and prevented users from accessing notifications by client-supplied IDs.",
    descriptionAr: "تم إغلاق ثغرات الوصول بين المؤسسات، ونقل مسارات لوحة التحكم إلى روابط تحتوي المؤسسة، ومنع الوصول إلى الإشعارات عبر معرفات يرسلها العميل.",
    publishedAt: releaseAt(2026, 6, 17, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Excel import wizard and custom customer statuses",
    titleAr: "معالج استيراد Excel وحالات عملاء مخصصة",
    descriptionEn: "Added an Excel import wizard for vehicles and customers, plus per-organization custom customer statuses.",
    descriptionAr: "تمت إضافة معالج استيراد Excel للسيارات والعملاء، مع حالات عملاء مخصصة لكل مؤسسة.",
    publishedAt: releaseAt(2026, 6, 17, 2),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Finance company settings and comparison logic",
    titleAr: "إعدادات شركات التمويل ومنطق المقارنة",
    descriptionEn: "Finance company settings and comparison behavior were expanded so offers can reflect each dealership's financing partners more accurately.",
    descriptionAr: "تم توسيع إعدادات شركات التمويل ومنطق المقارنة حتى تعكس العروض شركاء التمويل لكل معرض بدقة أكبر.",
    publishedAt: releaseAt(2026, 6, 17, 3),
  },
  {
    type: "FEATURE",
    titleEn: "Super-admin control center",
    titleAr: "مركز تحكم للإدارة العليا",
    descriptionEn: "Added a super-admin dashboard for organization management, user management, cross-org data browsing, system health, and audit-log review.",
    descriptionAr: "تمت إضافة لوحة إدارة عليا لإدارة المؤسسات والمستخدمين وتصفح البيانات بين المؤسسات ومتابعة صحة النظام ومراجعة سجل التدقيق.",
    publishedAt: releaseAt(2026, 6, 18, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Support inbox, contact routing, and acknowledgments",
    titleAr: "صندوق دعم وتوجيه التواصل وردود تأكيد",
    descriptionEn: "Added company support and info inboxes, verified-domain email sending, contact-form routing, and automatic acknowledgments for new support conversations.",
    descriptionAr: "تمت إضافة صناديق دعم ومعلومات للشركة، وإرسال بريد من نطاق موثق، وتوجيه نموذج التواصل، وردود تأكيد تلقائية للمحادثات الجديدة.",
    publishedAt: releaseAt(2026, 6, 18, 2),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Simpler Add Team Member flow",
    titleAr: "تدفق أبسط لإضافة عضو فريق",
    descriptionEn: "Adding team members now asks only for email, first name, and last name, with automatic username generation behind the scenes.",
    descriptionAr: "أصبحت إضافة أعضاء الفريق تطلب البريد الإلكتروني والاسم الأول واسم العائلة فقط، مع توليد اسم المستخدم تلقائياً في الخلفية.",
    publishedAt: releaseAt(2026, 6, 18, 3),
  },
  {
    type: "FEATURE",
    titleEn: "Legal pages, contact page, and marketing assistant",
    titleAr: "صفحات قانونية وتواصل ومساعد تسويقي",
    descriptionEn: "Added public legal pages, a contact form, and a marketing-site assistant to help visitors reach the right channel.",
    descriptionAr: "تمت إضافة صفحات قانونية عامة ونموذج تواصل ومساعد للموقع التسويقي لمساعدة الزوار على الوصول إلى القناة المناسبة.",
    publishedAt: releaseAt(2026, 6, 18, 4),
  },
  {
    type: "FIX",
    titleEn: "Owner-only administration and privacy guards",
    titleAr: "إدارة مخصصة للمالك وحماية خصوصية",
    descriptionEn: "Role and settings administration is now restricted to owners, settings links are hidden from non-owner roles, and commission visibility is limited to the right users.",
    descriptionAr: "أصبحت إدارة الأدوار والإعدادات محصورة بالمالكين، وتم إخفاء روابط الإعدادات عن غير المالكين، وتقييد رؤية العمولات للمستخدمين المناسبين.",
    publishedAt: releaseAt(2026, 6, 19, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Audited super-admin impersonation",
    titleAr: "دخول إداري مُدقق نيابة عن المستخدمين",
    descriptionEn: "Super admins can now use an in-app, audited impersonation flow instead of external deep links when support needs to inspect an organization experience.",
    descriptionAr: "أصبح بإمكان الإدارة العليا استخدام تدفق دخول داخل التطبيق ومُسجّل في التدقيق بدلاً من روابط خارجية عند الحاجة لفحص تجربة مؤسسة.",
    publishedAt: releaseAt(2026, 6, 19, 2),
  },
  {
    type: "FEATURE",
    titleEn: "CRM data quality tools",
    titleAr: "أدوات جودة بيانات CRM",
    descriptionEn: "Added duplicate detection, VIN checksum validation, customer merge tools, lead-to-sale visibility, and a data-quality dashboard widget.",
    descriptionAr: "تمت إضافة كشف التكرارات، والتحقق من رقم VIN، وأدوات دمج العملاء، ووضوح تحويل العميل المحتمل إلى بيع، ومؤشر جودة البيانات في لوحة التحكم.",
    publishedAt: releaseAt(2026, 6, 20, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Instagram publishing and engagement",
    titleAr: "النشر والتفاعل عبر إنستغرام",
    descriptionEn: "Added Instagram connection, manual posting, automatic posting when vehicles become available, likes/comments engagement capture, and required deauthorization/data-deletion callbacks.",
    descriptionAr: "تمت إضافة ربط إنستغرام والنشر اليدوي والنشر التلقائي عند توفر السيارات والتقاط الإعجابات والتعليقات وروابط إلغاء الربط وحذف البيانات المطلوبة.",
    publishedAt: releaseAt(2026, 6, 20, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Deposits, vehicle holds, and cash-sale completion",
    titleAr: "العربون وحجز السيارة وإكمال البيع النقدي",
    descriptionEn: "Added deposit tracking, vehicle reservation holds, cash-sale completion from the quote success screen, and automatic lead-stage movement after test drives or shared quotes.",
    descriptionAr: "تمت إضافة تتبع العربون وحجوزات السيارات وإكمال البيع النقدي من شاشة نجاح العرض وتحريك مرحلة العميل المحتمل تلقائياً بعد تجربة القيادة أو مشاركة العرض.",
    publishedAt: releaseAt(2026, 6, 21, 1),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Linked leads, quotes, sales, and bank valuations",
    titleAr: "ربط العملاء والعروض والمبيعات وتقييمات البنوك",
    descriptionEn: "Leads, quotes, and sales now carry explicit links through the lifecycle, and bank valuation data can be carried through vehicle Excel import.",
    descriptionAr: "أصبحت العملاء المحتملون والعروض والمبيعات مرتبطة بشكل صريح عبر دورة العمل، ويمكن تمرير بيانات تقييم البنوك من استيراد Excel للسيارات.",
    publishedAt: releaseAt(2026, 6, 21, 2),
  },
  {
    type: "FIX",
    titleEn: "Finance card calculations clarified",
    titleAr: "توضيح حسابات بطاقات التمويل",
    descriptionEn: "Fixed Dar Al Tamweel commission double-counting and separated execution commission from execution fees in the financing cards.",
    descriptionAr: "تم إصلاح تكرار احتساب عمولة دار التمويل وفصل عمولة التنفيذ عن مصاريف التنفيذ في بطاقات التمويل.",
    publishedAt: releaseAt(2026, 6, 21, 3),
  },
  {
    type: "FEATURE",
    titleEn: "Instagram and Facebook social inbox",
    titleAr: "صندوق وارد اجتماعي لإنستغرام وفيسبوك",
    descriptionEn: "Added inbound Instagram comments/DMs and Facebook comments/Messenger capture, automatic replies, lead creation, and conversation dialogs linked to leads.",
    descriptionAr: "تمت إضافة التقاط تعليقات ورسائل إنستغرام وتعليقات فيسبوك ورسائل ماسنجر، مع ردود تلقائية وإنشاء عملاء محتملين ونوافذ محادثة مرتبطة بالعملاء.",
    publishedAt: releaseAt(2026, 6, 22, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Rule-based Smart Reply",
    titleAr: "رد ذكي قائم على القواعد",
    descriptionEn: "Added deterministic Smart Reply templates for Instagram and Facebook auto-answers, with separate behavior for DMs and public comments.",
    descriptionAr: "تمت إضافة قوالب رد ذكي محددة بالقواعد لردود إنستغرام وفيسبوك التلقائية، مع سلوك منفصل للرسائل الخاصة والتعليقات العامة.",
    publishedAt: releaseAt(2026, 6, 22, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Facebook Page integration",
    titleAr: "تكامل صفحات فيسبوك",
    descriptionEn: "Dealerships can connect Facebook Pages, post to the feed, capture inbound engagement, and tune lead-creation toggles for Facebook events.",
    descriptionAr: "يمكن للمعارض ربط صفحات فيسبوك والنشر عليها والتقاط التفاعل الوارد وضبط مفاتيح إنشاء العملاء المحتملين لأحداث فيسبوك.",
    publishedAt: releaseAt(2026, 6, 22, 3),
  },
  {
    type: "FIX",
    titleEn: "Role redirects, social permissions, and approval gates fixed",
    titleAr: "إصلاح توجيه الأدوار وصلاحيات التواصل وبوابات الموافقة",
    descriptionEn: "Fixed role-based redirects for reception/accounting/sales users, quote/deposit permissions, vehicle approval-tier enforcement, and social integration permission details.",
    descriptionAr: "تم إصلاح توجيه أدوار الاستقبال والمحاسبة والمبيعات، وصلاحيات العروض والعربون، وتطبيق مستويات موافقة السيارات، وتفاصيل صلاحيات تكاملات التواصل.",
    publishedAt: releaseAt(2026, 6, 22, 4),
  },
  {
    type: "FEATURE",
    titleEn: "Multi-channel notification system",
    titleAr: "نظام إشعارات متعدد القنوات",
    descriptionEn: "Added bilingual notification preferences, categories, priorities, broadcasts, sound support, and safer org-scoped notification links.",
    descriptionAr: "تمت إضافة تفضيلات إشعارات ثنائية اللغة وتصنيفات وأولويات وبث جماعي ودعم الصوت وروابط إشعارات آمنة ضمن المؤسسة.",
    publishedAt: releaseAt(2026, 6, 23, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Social inbox filters, post links, resync, and vehicle analytics",
    titleAr: "فلاتر وروابط ومزامنة وتحليلات لصندوق التواصل",
    descriptionEn: "Added social inbox filters, standalone post links, historical post resync, DM support, vehicle linking, auto-extraction, and analytics.",
    descriptionAr: "تمت إضافة فلاتر لصندوق التواصل وروابط منشورات مستقلة وإعادة مزامنة تاريخية ودعم الرسائل الخاصة وربط السيارات والاستخراج التلقائي والتحليلات.",
    publishedAt: releaseAt(2026, 6, 24, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Internal messaging",
    titleAr: "مراسلة داخلية",
    descriptionEn: "Added internal messaging foundations so dealership staff can communicate inside AutoFlow.",
    descriptionAr: "تمت إضافة أساس المراسلة الداخلية حتى يتمكن فريق المعرض من التواصل داخل أوتوفلو.",
    publishedAt: releaseAt(2026, 6, 24, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Floating Messenger and global search",
    titleAr: "ماسنجر عائم وبحث شامل",
    descriptionEn: "Added a floating Messenger widget with direct messages, groups, seen receipts, sounds, and onboarding, plus global search across vehicles, customers, and leads.",
    descriptionAr: "تمت إضافة أداة ماسنجر عائمة للرسائل المباشرة والمجموعات ومؤشرات القراءة والأصوات والتهيئة، مع بحث شامل في السيارات والعملاء والعملاء المحتملين.",
    publishedAt: releaseAt(2026, 6, 25, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Inventory intelligence",
    titleAr: "ذكاء المخزون",
    descriptionEn: "Added inventory aging, landed costs, price history, reservation tracking, and richer inventory insights.",
    descriptionAr: "تمت إضافة عمر المخزون والتكاليف النهائية وتاريخ الأسعار وتتبع الحجوزات ورؤى أعمق للمخزون.",
    publishedAt: releaseAt(2026, 6, 25, 2),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Smarter social lead automation",
    titleAr: "أتمتة أذكى للعملاء من التواصل",
    descriptionEn: "Social conversations now auto-link vehicles from posts, comments, DMs, reels, and attachments when safe, show suggestions when ambiguous, require mobile numbers for DM leads, and can auto-assign generated leads to sales.",
    descriptionAr: "أصبحت محادثات التواصل تربط السيارات تلقائياً من المنشورات والتعليقات والرسائل والريلز والمرفقات عند الأمان، وتعرض اقتراحات عند الالتباس، وتطلب رقم جوال لعملاء الرسائل، ويمكنها تعيين العملاء الناتجين للمبيعات.",
    publishedAt: releaseAt(2026, 6, 25, 3),
  },
  {
    type: "FEATURE",
    titleEn: "Dealer website builder",
    titleAr: "منشئ مواقع للمعارض",
    descriptionEn: "Added a dealer website module with setup, preview, publish flow, wildcard subdomain routing, branch links, lead forms, and bilingual English/Arabic support.",
    descriptionAr: "تمت إضافة وحدة إنشاء موقع للمعرض مع الإعداد والمعاينة والنشر وتوجيه النطاقات الفرعية وروابط الفروع ونماذج العملاء ودعم العربية والإنجليزية.",
    publishedAt: releaseAt(2026, 6, 26, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Premium website themes and presets",
    titleAr: "قوالب مواقع مميزة واقتراحات جاهزة",
    descriptionEn: "Dealer websites gained premium themes, hero-text suggestions, better mobile navigation, improved logos, and cleaner publish feedback.",
    descriptionAr: "حصلت مواقع المعارض على قوالب مميزة واقتراحات لنص الواجهة وتحسين تنقل الموبايل والشعارات ورسائل أوضح عند النشر.",
    publishedAt: releaseAt(2026, 6, 26, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Billing, subscriptions, plans, and upgrade prompts",
    titleAr: "الفوترة والاشتراكات والخطط ورسائل الترقية",
    descriptionEn: "Added a billing page, subscription inbox, freemium plan system, pricing toggle, upgrade modal, and support notifications around subscriptions.",
    descriptionAr: "تمت إضافة صفحة فوترة وصندوق اشتراكات ونظام خطة مجانية ومفتاح تسعير ونافذة ترقية وإشعارات دعم حول الاشتراكات.",
    publishedAt: releaseAt(2026, 6, 26, 3),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Feedback replies and better financing-card contrast",
    titleAr: "ردود على الملاحظات وتباين أفضل لبطاقات التمويل",
    descriptionEn: "Admins can notify submitters when feedback is replied to or resolved, and financing-card contrast was improved for readability.",
    descriptionAr: "يمكن للإدارة إشعار صاحب الملاحظة عند الرد أو الحل، وتم تحسين تباين بطاقات التمويل لقراءة أفضل.",
    publishedAt: releaseAt(2026, 6, 27, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Receivables and collections management",
    titleAr: "إدارة الذمم والتحصيل",
    descriptionEn: "Added receivables, collection tracking, payment recording, approvals, refunds, and collection lifecycle foundations.",
    descriptionAr: "تمت إضافة الذمم وتتبع التحصيل وتسجيل المدفوعات والموافقات والمستردات وأساسات دورة حياة التحصيل.",
    publishedAt: releaseAt(2026, 6, 28, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Accounting ledger and posting engine",
    titleAr: "دفتر أستاذ ومحرك ترحيل محاسبي",
    descriptionEn: "Added the accounting event registry, posting engine, journal entries, reversal engine, canonical payments, allocations, and domain hooks into sales, deposits, collections, expenses, and work orders.",
    descriptionAr: "تمت إضافة سجل الأحداث المحاسبية ومحرك الترحيل والقيود اليومية ومحرك العكس والمدفوعات المعيارية والتوزيعات وربطها بالمبيعات والعربون والتحصيل والمصاريف وأوامر العمل.",
    publishedAt: releaseAt(2026, 6, 29, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Ledger-backed financial reports",
    titleAr: "تقارير مالية مبنية على دفتر الأستاذ",
    descriptionEn: "Trial balance, profit and loss, balance sheet, and AR aging now read from ledger-backed accounting data instead of loose operational totals.",
    descriptionAr: "أصبحت ميزان المراجعة والأرباح والخسائر والميزانية وأعمار الذمم تقرأ من بيانات محاسبية مرتبطة بدفتر الأستاذ بدلاً من مجاميع تشغيلية منفصلة.",
    publishedAt: releaseAt(2026, 6, 29, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Financial audit controls and lifecycle reversals",
    titleAr: "ضوابط تدقيق مالي وعكس دورات العمل",
    descriptionEn: "Added financial audit logs, segregation of duties, manual journal review controls, sale cancellation reversals, cheque-return handling, finance disbursement lifecycle, and payment webhook handling.",
    descriptionAr: "تمت إضافة سجلات تدقيق مالي وفصل المهام وضوابط مراجعة القيود اليدوية وعكس إلغاء البيع ومعالجة الشيكات المرتجعة ودورة صرف التمويل ومعالجة ويب هوك المدفوعات.",
    publishedAt: releaseAt(2026, 6, 29, 3),
  },
  {
    type: "FIX",
    titleEn: "Production audit fixes for finance and accounting",
    titleAr: "إصلاحات تدقيق إنتاج للتمويل والمحاسبة",
    descriptionEn: "Hardened GL outbox processing, idempotency, finance-application permissions, audit columns, webhook processing, receivable balances, and security checks after production readiness reviews.",
    descriptionAr: "تم تقوية معالجة صندوق GL الخارجي ومنع التكرار وصلاحيات طلبات التمويل وأعمدة التدقيق ومعالجة الويب هوك وأرصدة الذمم وفحوصات الأمان بعد مراجعات جاهزية الإنتاج.",
    publishedAt: releaseAt(2026, 6, 30, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Sourced vehicles and finance application lifecycle controls",
    titleAr: "مصادر السيارات وضوابط دورة طلب التمويل",
    descriptionEn: "Added sourced-vehicle tracking, finance application cancel/void flows, duplicate guards, and a feature spotlight for newly shipped capabilities.",
    descriptionAr: "تمت إضافة تتبع مصدر السيارات وتدفقات إلغاء/إبطال طلب التمويل وحماية من التكرار وتسليط ضوء على الميزات الجديدة.",
    publishedAt: releaseAt(2026, 7, 1, 1),
  },
  {
    type: "FIX",
    titleEn: "Arabic currency and deposit descriptions fixed",
    titleAr: "إصلاح العملة العربية ووصف العربون",
    descriptionEn: "Fixed Arabic i18n, switched JOD display to dinar wording where needed, and improved null-safe deposit and ledger descriptions.",
    descriptionAr: "تم إصلاح التعريب، وتحويل عرض JOD إلى صياغة الدينار عند الحاجة، وتحسين أوصاف العربون ودفتر الأستاذ عند غياب بعض البيانات.",
    publishedAt: releaseAt(2026, 7, 1, 2),
  },
  {
    type: "FIX",
    titleEn: "Dashboard, reports, and notifications fixed",
    titleAr: "إصلاح لوحة التحكم والتقارير والإشعارات",
    descriptionEn: "Fixed dashboard sales metrics, report accuracy, notification behavior, Arabic ledger details, and sale VIN preservation in ledger descriptions.",
    descriptionAr: "تم إصلاح مقاييس مبيعات لوحة التحكم ودقة التقارير وسلوك الإشعارات وتفاصيل دفتر الأستاذ بالعربية وحفظ رقم VIN في أوصاف الدفتر.",
    publishedAt: releaseAt(2026, 7, 2, 1),
  },
  {
    type: "FIX",
    titleEn: "Deposits, sales lifecycle, and finance core hardened",
    titleAr: "تقوية العربون ودورة المبيعات وأساس التمويل",
    descriptionEn: "Deposit, sale, finance, receivable, refund, and cancellation paths were tightened so holds, payments, and accounting balances stay aligned.",
    descriptionAr: "تم تقوية مسارات العربون والبيع والتمويل والذمم والمستردات والإلغاء حتى تبقى الحجوزات والمدفوعات والأرصدة المحاسبية متوافقة.",
    publishedAt: releaseAt(2026, 7, 2, 2),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Vehicle status guards and import UI",
    titleAr: "حماية حالات السيارات وواجهة الاستيراد",
    descriptionEn: "Vehicle status changes now respect active reservations, deposits, and approval rules, with updated edit/request flows and import UI improvements.",
    descriptionAr: "أصبحت تغييرات حالة السيارة تراعي الحجوزات والعربون وقواعد الموافقة النشطة، مع تحسين تدفقات التعديل والطلبات وواجهة الاستيراد.",
    publishedAt: releaseAt(2026, 7, 2, 3),
  },
  {
    type: "FIX",
    titleEn: "Membership, admin, roles, and tenancy hardening",
    titleAr: "تقوية العضويات والإدارة والأدوار وعزل المؤسسات",
    descriptionEn: "Membership, role, user, admin, and tenancy helpers were hardened to reduce permission drift and cross-organization mistakes.",
    descriptionAr: "تم تقوية مساعدات العضويات والأدوار والمستخدمين والإدارة وعزل المؤسسات لتقليل أخطاء الصلاحيات والخلط بين المؤسسات.",
    publishedAt: releaseAt(2026, 7, 2, 4),
  },
  {
    type: "FIX",
    titleEn: "Social integrations and dealer websites hardened",
    titleAr: "تقوية تكاملات التواصل ومواقع المعارض",
    descriptionEn: "Facebook/Instagram engagement, the social inbox, auto-posting, website builder, dealer-site themes, email, HTTP handlers, and deployment checks received audit fixes.",
    descriptionAr: "حصلت تفاعلات فيسبوك/إنستغرام وصندوق التواصل والنشر التلقائي ومنشئ المواقع وقوالب مواقع المعارض والبريد ومعالجات HTTP وفحوصات النشر على إصلاحات تدقيق.",
    publishedAt: releaseAt(2026, 7, 2, 5),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "More accurate accounting for refunds and cheques",
    titleAr: "محاسبة أدق للمستردات والشيكات",
    descriptionEn: "Fixed several accounting edge cases: refunds now post to the correct account based on how they're paid out, cheque-related sales can no longer be cancelled while a cheque is still outstanding, and a few approval-screen display issues were corrected.",
    descriptionAr: "تم إصلاح عدة حالات محاسبية خاصة: المستردات الآن تُرحّل إلى الحساب الصحيح حسب طريقة الدفع، ولم يعد بالإمكان إلغاء عمليات البيع المرتبطة بشيك ما دام الشيك لم يُحصّل بعد، كما تم تصحيح بعض مشاكل العرض في شاشة الموافقات.",
    publishedAt: Date.UTC(2026, 6, 3, 0, 0, 0),
  },
  {
    type: "FEATURE",
    titleEn: "Automatic retry for missed social media replies",
    titleAr: "إعادة محاولة تلقائية للردود الفائتة على وسائل التواصل",
    descriptionEn: "If an automatic reply to a Facebook or Instagram comment or message doesn't go through the first time, AutoFlow now retries automatically for up to 48 hours before flagging it for manual follow-up.",
    descriptionAr: "إذا لم يتم إرسال الرد التلقائي على تعليق أو رسالة في فيسبوك أو إنستغرام من أول مرة، يقوم أوتوفلو الآن بإعادة المحاولة تلقائياً لمدة تصل إلى 48 ساعة قبل تحويلها للمتابعة اليدوية.",
    publishedAt: Date.UTC(2026, 6, 3, 0, 0, 0),
  },
  {
    type: "FEATURE",
    titleEn: "Two-person approval for manual accounting entries",
    titleAr: "موافقة من شخصين على القيود المحاسبية اليدوية",
    descriptionEn: "Manual journal entries in the accounting section now require a second finance-authorized person to review and approve them before they post — the person who creates an entry can no longer approve it themselves.",
    descriptionAr: "القيود اليدوية في قسم المحاسبة تتطلب الآن مراجعة وموافقة من شخص آخر مخوّل مالياً قبل ترحيلها — لم يعد بإمكان من أنشأ القيد الموافقة عليه بنفسه.",
    publishedAt: Date.UTC(2026, 6, 3, 12, 0, 0),
  },
  {
    type: "FIX",
    titleEn: "Fixed a crash when opening \"New Manual Journal\"",
    titleAr: "إصلاح تعطّل عند فتح \"قيد يدوي جديد\"",
    descriptionEn: "Opening the New Manual Journal dialog in the accounting section could crash the page. This is now fixed.",
    descriptionAr: "كان فتح نافذة \"قيد يدوي جديد\" في قسم المحاسبة قد يتسبب بتعطّل الصفحة. تم إصلاح ذلك الآن.",
    publishedAt: Date.UTC(2026, 6, 4, 0, 0, 0),
  },
  {
    type: "FEATURE",
    titleEn: "Fixed assets and depreciation",
    titleAr: "الأصول الثابتة والاستهلاك",
    descriptionEn: "Added fixed-asset lifecycle tracking and depreciation postings directly into the ledger.",
    descriptionAr: "تمت إضافة تتبع دورة حياة الأصول الثابتة وترحيل الاستهلاك مباشرة إلى دفتر الأستاذ.",
    publishedAt: releaseAt(2026, 7, 4, 1),
  },
  {
    type: "FEATURE",
    titleEn: "Partner equity ledger",
    titleAr: "دفتر حقوق الشركاء",
    descriptionEn: "Partner equity is now recorded as immutable, GL-posted transactions for clearer owner capital tracking.",
    descriptionAr: "أصبحت حقوق الشركاء تسجل كحركات غير قابلة للتعديل ومرحّلة إلى دفتر الأستاذ لتتبع أوضح لرأس مال الملاك.",
    publishedAt: releaseAt(2026, 7, 4, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Claim receivables and settlement",
    titleAr: "ذمم المطالبات والتسوية",
    descriptionEn: "Added claim receivables, settlement flow, and write-off handling for finance-company claims.",
    descriptionAr: "تمت إضافة ذمم المطالبات وتدفق التسوية ومعالجة الشطب لمطالبات شركات التمويل.",
    publishedAt: releaseAt(2026, 7, 4, 3),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Multi-currency reporting correctness",
    titleAr: "دقة التقارير متعددة العملات",
    descriptionEn: "Financial reports now handle multi-currency balances more carefully so reporting currency and account currency stay consistent.",
    descriptionAr: "أصبحت التقارير المالية تتعامل مع الأرصدة متعددة العملات بعناية أكبر حتى تبقى عملة التقرير وعملة الحساب متوافقتين.",
    publishedAt: releaseAt(2026, 7, 4, 4),
  },
  {
    type: "FEATURE",
    titleEn: "Cash drawer sessions",
    titleAr: "جلسات درج النقد",
    descriptionEn: "Added full cash-drawer session tracking for opening balances, cash activity, reconciliation, and review.",
    descriptionAr: "تمت إضافة تتبع كامل لجلسات درج النقد للأرصدة الافتتاحية وحركة النقد والمطابقة والمراجعة.",
    publishedAt: releaseAt(2026, 7, 4, 5),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Legacy money migration and scalable report balances",
    titleAr: "ترحيل المال القديم وأرصدة تقارير قابلة للتوسع",
    descriptionEn: "Added accountant cutover support for legacy money data and running account-balance snapshots to keep larger reports responsive.",
    descriptionAr: "تمت إضافة دعم انتقال المحاسب لبيانات المال القديمة ولقطات أرصدة حسابات جارية للحفاظ على سرعة التقارير الكبيرة.",
    publishedAt: releaseAt(2026, 7, 4, 6),
  },
  {
    type: "FEATURE",
    titleEn: "What's New panel",
    titleAr: "لوحة ما الجديد",
    descriptionEn: "Added a user-facing What's New panel so features, improvements, and hotfixes can be published to every organization.",
    descriptionAr: "تمت إضافة لوحة ما الجديد للمستخدمين حتى يمكن نشر الميزات والتحسينات والإصلاحات لكل المؤسسات.",
    publishedAt: releaseAt(2026, 7, 4, 7),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Complete money-flow coverage",
    titleAr: "تغطية كاملة لتدفقات المال",
    descriptionEn: "Accounting coverage now reaches more operational money flows, including deposits, collections, provider payments, expenses, claims, partner equity, cash drawers, and finance lifecycle events.",
    descriptionAr: "أصبحت التغطية المحاسبية تشمل مزيداً من تدفقات المال التشغيلية، بما فيها العربون والتحصيل ومدفوعات المزودين والمصاريف والمطالبات وحقوق الشركاء وأدراج النقد وأحداث دورة التمويل.",
    publishedAt: releaseAt(2026, 7, 5, 1),
  },
  {
    type: "FIX",
    titleEn: "Currency precision fixed in collections",
    titleAr: "إصلاح دقة العملة في التحصيل",
    descriptionEn: "Fixed precision loss in collection and reminder flows so money amounts keep their correct minor-unit values.",
    descriptionAr: "تم إصلاح فقدان الدقة في التحصيل والتذكيرات حتى تحتفظ المبالغ بقيمها الصحيحة بالوحدات الصغرى.",
    publishedAt: releaseAt(2026, 7, 5, 2),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Validated accounting dialogs and scalable snapshots",
    titleAr: "نوافذ محاسبية موثقة ولقطات أرصدة قابلة للتوسع",
    descriptionEn: "Several accounting dialogs now use stronger form validation, and account-balance snapshot writes were sharded for better scalability.",
    descriptionAr: "أصبحت عدة نوافذ محاسبية تستخدم تحققاً أقوى من النماذج، وتم توزيع كتابة لقطات أرصدة الحسابات لتحسين القابلية للتوسع.",
    publishedAt: releaseAt(2026, 7, 5, 3),
  },
  {
    type: "FEATURE",
    titleEn: "Reservation hold period and prepaid expense amortization",
    titleAr: "مدة حجز السيارة وإطفاء المصاريف المدفوعة مقدماً",
    descriptionEn: "Added an organization setting for reservation hold periods and support for prepaid expense amortization.",
    descriptionAr: "تمت إضافة إعداد للمؤسسة يحدد مدة حجز السيارة، مع دعم إطفاء المصاريف المدفوعة مقدماً.",
    publishedAt: releaseAt(2026, 7, 5, 4),
  },
  {
    type: "FEATURE",
    titleEn: "Search, sort, filters, provenance, and Sale Trail",
    titleAr: "بحث وفرز وفلاتر ومصدر بيانات ومسار البيع",
    descriptionEn: "Tables across the app now support search, sort, and filtering. Customer and vehicle records show provenance, and Sale Trail gives a clearer path through a deal's history.",
    descriptionAr: "أصبحت الجداول في التطبيق تدعم البحث والفرز والفلاتر. كما تعرض سجلات العملاء والسيارات مصدر البيانات، ويقدم مسار البيع رؤية أوضح لتاريخ الصفقة.",
    publishedAt: releaseAt(2026, 7, 5, 5),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Paginated table search auto-loads more results",
    titleAr: "بحث الجداول المحملة على صفحات يجلب نتائج أكثر تلقائياً",
    descriptionEn: "Searching paginated tables now automatically loads more pages when needed, so users are less likely to miss matching results hidden beyond the first page.",
    descriptionAr: "أصبح البحث في الجداول المقسمة إلى صفحات يجلب صفحات إضافية تلقائياً عند الحاجة، حتى لا تفوت المستخدم نتائج موجودة بعد الصفحة الأولى.",
    publishedAt: releaseAt(2026, 7, 5, 6),
  },
  {
    type: "FEATURE",
    titleEn: "Prepaid expenses now spread across the months they cover",
    titleAr: "المصروفات المدفوعة مقدماً تُوزّع الآن على الأشهر التي تغطيها",
    descriptionEn: "When you record an expense you can now mark it as prepaid and choose how many months it covers (e.g. a year of insurance paid up front). AutoFlow holds it as an asset and recognizes an equal share each month automatically, so your monthly profit and the accounting ledger always agree.",
    descriptionAr: "عند تسجيل مصروف يمكنك الآن تحديده كمدفوع مقدماً واختيار عدد الأشهر التي يغطيها (مثل تأمين سنة مدفوع مقدماً). يحتفظ أوتوفلو به كأصل ويحتسب حصة متساوية كل شهر تلقائياً، بحيث يتطابق ربحك الشهري مع دفتر المحاسبة دائماً.",
    publishedAt: releaseAt(2026, 7, 14, 1),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "Clearer month-end close: real blockers vs. review warnings",
    titleAr: "إغلاق نهاية الشهر أوضح: عوائق حقيقية مقابل تنبيهات للمراجعة",
    descriptionEn: "The period-close checklist now separates issues that truly must be fixed before closing from subledger differences that are usually just cross-period timing and only need a review — so a legitimate month can no longer be blocked from closing by activity that happened after it ended.",
    descriptionAr: "أصبحت قائمة إغلاق الفترة تفصل الأمور التي يجب إصلاحها فعلاً قبل الإغلاق عن فروقات دفاتر الأستاذ المساعدة التي تكون عادةً مجرد توقيت بين الفترات وتحتاج مراجعة فقط، فلم يعد بالإمكان منع إغلاق شهر سليم بسبب نشاط حدث بعد انتهائه.",
    publishedAt: releaseAt(2026, 7, 14, 2),
  },
  {
    type: "FEATURE",
    titleEn: "Buyers now watch dealer offers arrive live in the app",
    titleAr: "المشترون يتابعون عروض المعارض تصل مباشرةً في التطبيق",
    descriptionEn: "The mobile marketplace has a new Request Room: after a buyer tells us what car they want, they land straight in a live screen where each matching dealer's offer streams in as it arrives, with the monthly payment, cash price, and trust badges. Buyers can shortlist, compare two or three offers side by side, and only their chosen dealer sees their phone number after they explicitly allow contact. A My Requests tab keeps every request one tap away, with a badge when new offers land.",
    descriptionAr: "أصبح لسوق التطبيق غرفة طلب جديدة: بعد أن يخبرنا المشتري بالسيارة التي يريدها، ينتقل مباشرةً إلى شاشة حيّة تظهر فيها عروض المعارض المطابقة أولاً بأول مع القسط الشهري والسعر نقداً وشارات الثقة. يمكن للمشتري حفظ العروض ومقارنة عرضين أو ثلاثة جنباً إلى جنب، ولا يظهر رقم هاتفه إلا للمعرض الذي يختاره وبعد موافقته الصريحة. ويحتفظ تبويب «طلباتي» بكل طلب على بُعد نقرة واحدة مع إشعار عند وصول عروض جديدة.",
    publishedAt: releaseAt(2026, 7, 18, 1),
  },
  {
    type: "IMPROVEMENT",
    titleEn: "See your budget reach before you sign up",
    titleAr: "شوف مدى ميزانيتك قبل ما تسجّل",
    descriptionEn: "The mobile 'request a car' flow now leads with value: it asks about the car and your budget first, and shows the approximate price range you can reach for a given monthly payment — calculated live from real dealer finance terms — before ever asking for your name or number. Your contact details are the last step, not the first.",
    descriptionAr: "أصبح مسار «اطلب سيارة» في التطبيق يبدأ بالقيمة: يسألك عن السيارة وميزانيتك أولاً، ويعرض لك مدى الأسعار التقريبي الذي تقدر توصله بقسط شهري معيّن — محسوباً مباشرةً من شروط تمويل المعارض الحقيقية — قبل أن يطلب اسمك أو رقمك. بيانات تواصلك أصبحت الخطوة الأخيرة لا الأولى.",
    publishedAt: releaseAt(2026, 7, 18, 2),
  },
];

const DUPLICATE_LOOKUP_LIMIT = 25;

async function historicalEntryExists(ctx: MutationCtx, entry: HistoricalChangelogEntry) {
  const sameTimestamp = await ctx.db
    .query("changelogEntries")
    .withIndex("by_publishedAt", (q) => q.eq("publishedAt", entry.publishedAt))
    .take(DUPLICATE_LOOKUP_LIMIT);

  return sameTimestamp.some((existing) => existing.titleEn === entry.titleEn);
}

async function insertMissingHistoricalEntries(ctx: MutationCtx, createdBy: Id<"users">) {
  const now = Date.now();
  let inserted = 0;
  let skipped = 0;

  for (const entry of HISTORICAL_ENTRIES) {
    if (await historicalEntryExists(ctx, entry)) {
      skipped += 1;
      continue;
    }

    await ctx.db.insert("changelogEntries", { ...entry, createdBy, createdAt: now });
    inserted += 1;
  }

  return { inserted, skipped, total: HISTORICAL_ENTRIES.length };
}

/**
 * Backfills customer-facing product history into What's New.
 * Idempotent and additive: re-running skips entries with the same title/date,
 * so deployments that already seeded a small historical set can receive newly
 * curated entries without deleting anything.
 */
export const seedHistoricalEntries = mutation({
  args: {},
  handler: async (ctx) => {
    const admin = await requireSuperAdmin(ctx);
    const seedResult = await insertMissingHistoricalEntries(ctx, admin._id);

    if (seedResult.inserted > 0) {
      await logAdminAction(ctx, admin, {
        action: "changelog:seedHistoricalEntries",
        targetTable: "changelogEntries",
        after: seedResult,
      });
    }

    return seedResult;
  },
});
