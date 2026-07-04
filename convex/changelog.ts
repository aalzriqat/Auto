import { v, ConvexError } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireAuth, requireSuperAdmin } from "./utils/tenancy";
import { notifyAllMembers } from "./utils/notifications";
import { logAdminAction } from "./adminAudit";

const changelogTypeValidator = v.union(v.literal("FEATURE"), v.literal("FIX"), v.literal("IMPROVEMENT"));

export const create = mutation({
  args: {
    type: changelogTypeValidator,
    titleEn: v.string(),
    titleAr: v.string(),
    descriptionEn: v.string(),
    descriptionAr: v.string(),
    publishedAt: v.optional(v.number()),
    notifyUsers: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
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
      const orgIds = (await ctx.db.query("organizations").collect()).map((o) => o._id);
      for (const orgId of orgIds) {
        await notifyAllMembers(ctx, orgId, "system.announcement", {
          title: args.titleEn,
          message: args.descriptionEn,
        }, { link: "/whats-new" });
      }
    }

    await logAdminAction(ctx, admin, {
      action: "changelog:create",
      targetTable: "changelogEntries",
      targetId: entryId,
      after: { type: args.type, titleEn: args.titleEn, notifyUsers: args.notifyUsers ?? false },
    });

    return entryId;
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
    publishedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const { entryId, ...updates } = args;

    const existing = await ctx.db.get(entryId);
    if (!existing) throw new Error("Changelog entry not found.");

    await ctx.db.patch(entryId, {
      ...updates,
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

const HISTORICAL_ENTRIES: Array<{
  type: "FEATURE" | "FIX" | "IMPROVEMENT";
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  descriptionAr: string;
  publishedAt: number;
}> = [
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
];

/**
 * One-time historical backfill, run manually once after this feature deploys:
 *   npx convex run changelog:seedHistoricalEntries '{"actorEmail":"you@example.com"}'
 * Idempotent — skips if any changelog entries already exist, so it's safe to
 * re-run and safe to leave in place rather than deleting after first use.
 */
export const seedHistoricalEntries = internalMutation({
  args: { actorEmail: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("changelogEntries").first();
    if (existing) {
      return { skipped: true, reason: "changelogEntries already has data" };
    }

    const actor = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.actorEmail))
      .unique();
    if (!actor) {
      throw new ConvexError(`No user found with email ${args.actorEmail}.`);
    }

    const now = Date.now();
    for (const entry of HISTORICAL_ENTRIES) {
      await ctx.db.insert("changelogEntries", { ...entry, createdBy: actor._id, createdAt: now });
    }

    return { skipped: false, inserted: HISTORICAL_ENTRIES.length };
  },
});
