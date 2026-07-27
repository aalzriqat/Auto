import { v } from "convex/values";
import { internalMutation, internalQuery, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { notifyManagers, notifyUser } from "./utils/notifications";
import { nextGeneratedLeadAssignee } from "./utils/leadAssignment";
import { hasPlanFeature } from "./subscriptions";

// ─── Internal helpers ─────────────────────────────────────────────────────────

export const getSettingsByOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    if (!(await hasPlanFeature(ctx, args.orgId, "whatsapp"))) return null;
    return await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
  },
});

/**
 * A sender's number can be stored on either `phone` or `whatsapp`, so this
 * checks both — via their indexes. Collecting every customer in the org and
 * scanning in JS meant each inbound message loaded the whole customer table.
 */
async function lookupCustomerByPhone(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  phone: string
): Promise<Doc<"customers"> | null> {
  const [byPhone, byWhatsapp] = await Promise.all([
    ctx.db
      .query("customers")
      .withIndex("by_org_phone", (q) => q.eq("orgId", orgId).eq("phone", phone))
      .first(),
    ctx.db
      .query("customers")
      .withIndex("by_org_whatsapp", (q) => q.eq("orgId", orgId).eq("whatsapp", phone))
      .first(),
  ]);
  return byPhone ?? byWhatsapp ?? null;
}

export const findCustomerByPhone = internalQuery({
  args: { orgId: v.id("organizations"), phone: v.string() },
  handler: async (ctx, args) => lookupCustomerByPhone(ctx, args.orgId, args.phone),
});

/**
 * Called by the WhatsApp webhook HTTP action when a new message arrives.
 * Finds or creates a customer for the sender, then opens a lead.
 */
export const handleIncomingMessage = internalMutation({
  args: {
    orgId: v.id("organizations"),
    senderPhone: v.string(),
    senderName: v.optional(v.string()),
    messageText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId, senderPhone, senderName, messageText } = args;
    if (!(await hasPlanFeature(ctx, orgId, "whatsapp"))) return;

    // Find or create customer
    let customer: Doc<"customers"> | null = await lookupCustomerByPhone(ctx, orgId, senderPhone);

    if (!customer) {
      const nameParts = (senderName ?? "WhatsApp Contact").split(" ");
      const customerId = await ctx.db.insert("customers", {
        orgId,
        firstName: nameParts[0] ?? "WhatsApp",
        lastName: nameParts.slice(1).join(" ") || "Contact",
        phone: senderPhone,
        whatsapp: senderPhone,
      });
      customer = await ctx.db.get(customerId);
    }

    if (!customer) return;

    // Check if an open lead already exists for this customer
    const existingLeads = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();

    const hasOpenLead = existingLeads.some(
      (l) =>
        l.customerId === customer!._id &&
        !l.isDeleted &&
        l.stage !== "WON" &&
        l.stage !== "LOST"
    );

    if (!hasOpenLead) {
      const assignedUserId = await nextGeneratedLeadAssignee(ctx, orgId);
      const leadId = await ctx.db.insert("leads", {
        orgId,
        customerId: customer._id,
        assignedUserId,
        source: "WhatsApp",
        stage: "NEW",
        notes: messageText
          ? `First WhatsApp message: "${messageText.slice(0, 200)}"`
          : "Lead created from WhatsApp message",
      });

      await notifyManagers(
        ctx,
        orgId,
        "whatsapp.lead_created",
        { senderName: senderName ?? senderPhone },
        { link: `/${orgId}/leads?highlightId=${leadId}` }
      );

      if (assignedUserId) {
        await notifyUser(
          ctx,
          orgId,
          assignedUserId,
          "lead.assigned",
          { actorName: "AutoFlow" },
          { link: `/${orgId}/leads?highlightId=${leadId}` }
        );
      }
    }
  },
});
