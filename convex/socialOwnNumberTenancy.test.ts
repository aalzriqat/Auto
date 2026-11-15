import { beforeAll, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { newT, seedOrg, PROD_LIKE_FB } from "../test-utils/socialWebhook";
import { signed, wrappedWrite, type Platform } from "../test-utils/socialOwnNumberHarness";
import "./http";
import "./users";
import "./marketplaceListings";
import "./memberships";

const OLD = "0790000801";
const NEXT = "0770000802";
const LAST = "0780000803";
type Producer = "user" | "listingPhone" | "listingWhatsapp" | "seller";

beforeAll(async () => {
  const t = newT();
  const orgId = await seedOrg(t, PROD_LIKE_FB);
  await t.mutation(internal.facebookEngagement.handleIncomingFacebookEvent, { orgId, kind: "dm", senderFacebookId: "warm", externalId: "warm", senderText: "Warmup", text: "Warmup" });
});

async function membershipsMatrix(platform: Platform, producer: Producer) {
  vi.useFakeTimers();
  const t = newT();
  try {
    const a = await seedOrg(t, {});
    const b = await seedOrg(t, {});
    const c = await seedOrg(t, {});
    const setup = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "matrix_staff", email: "staff@matrix.invalid", name: "Synthetic staff" });
      const managers = [];
      for (const orgId of [a, b]) {
        const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
        if (!member) throw new Error("Synthetic manager missing");
        const user = await ctx.db.get(member.userId);
        if (!user) throw new Error("Synthetic manager missing");
        await ctx.db.patch(member.roleId, { name: "OWNER", permissions: ["manage:users"] });
        const roleId = await ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] });
        managers.push({ orgId, clerkId: user.clerkId, roleId });
      }
      let listingId: Id<"marketplaceListings"> | undefined;
      let sellerId: Id<"marketplaceIndividualSellerProfiles"> | undefined;
      if (producer !== "user") {
        listingId = await ctx.db.insert("marketplaceListings", { sellerUserId: userId, sellerKind: "INDIVIDUAL", sellerDisplayName: "Synthetic", sellerPhone: producer === "listingPhone" ? OLD : "contact unavailable", sellerWhatsapp: producer === "listingWhatsapp" ? OLD : undefined,
          make: "Synthetic", model: "Fixture", year: 2020, mileage: 0, price: 1, currency: "JOD", transmission: "AUTO", fuelType: "OTHER", city: "Synthetic", description: "Fixture", condition: "GOOD", imageIds: [], status: "PENDING_VERIFICATION", createdAt: 1, updatedAt: 1 });
        if (producer === "seller") sellerId = await ctx.db.insert("marketplaceIndividualSellerProfiles", { sellerUserId: userId, sellerKind: "INDIVIDUAL", phone: OLD, createdAt: 1, updatedAt: 1 });
      }
      return { userId, managers, listingId, sellerId };
    });
    for (const manager of setup.managers) await t.withIdentity({ subject: manager.clerkId }).mutation(api.memberships.add, { orgId: manager.orgId, userEmail: "staff@matrix.invalid", roleId: manager.roleId });
    const asStaff = t.withIdentity({ subject: "matrix_staff" });
    async function update(phone: string) {
      if (producer === "user") await asStaff.mutation(api.users.updateMyNotificationProfile, { whatsappPhone: phone });
      else {
        if (!setup.listingId) throw new Error("Synthetic listing missing");
        await asStaff.mutation(api.marketplaceListings.updateListing, { listingId: setup.listingId, ...(producer === "listingWhatsapp" ? { sellerWhatsapp: phone } : { sellerPhone: phone }) });
        // The profile producer must answer independently of its listing sibling.
        if (producer === "seller") await wrappedWrite(t, (ctx) => ctx.db.patch(setup.listingId!, { sellerPhone: "contact unavailable" }));
      }
    }
    await update(OLD);
    await signed(t, a, platform, "initial_a", OLD);
    await signed(t, b, platform, "initial_b", OLD);
    await signed(t, c, platform, "unrelated", OLD, OLD);
    await update(NEXT);
    await signed(t, a, platform, "next_a", NEXT);
    await signed(t, b, platform, "next_b", NEXT);
    await signed(t, a, platform, "old_a", OLD, OLD);
    await signed(t, b, platform, "old_b", OLD, OLD);
    await asStaff.mutation(api.memberships.leave, { orgId: a });
    await signed(t, a, platform, "leave_a", NEXT, NEXT);
    await signed(t, b, platform, "leave_b_intact", NEXT);
    const manager = setup.managers[0];
    await t.withIdentity({ subject: manager.clerkId }).mutation(api.memberships.add, { orgId: a, userEmail: "staff@matrix.invalid", roleId: manager.roleId });
    await update(LAST);
    await signed(t, a, platform, "rejoin_a", LAST);
    await signed(t, b, platform, "rejoin_b_intact", LAST);
    if (producer === "user") await update("");
    else if (producer === "listingWhatsapp") await wrappedWrite(t, (ctx) => ctx.db.patch(setup.listingId!, { sellerWhatsapp: undefined }));
    else await wrappedWrite(t, async (ctx) => {
      // Required phone fields have no public clearing API. Exercise physical
      // source removal through the same public mutation builder, not raw DB.
      if (producer === "seller" && setup.sellerId) await ctx.db.delete(setup.sellerId);
      else if (setup.listingId) await ctx.db.delete(setup.listingId);
    });
    await signed(t, a, platform, "removed_a", LAST, LAST);
    await signed(t, b, platform, "removed_b", LAST, LAST);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
}

test("SCRUM-949 r7 tenancy: facebook shared user WhatsApp update removal join leave", () => membershipsMatrix("facebook", "user"));
test("SCRUM-949 r7 tenancy: instagram shared user WhatsApp update removal join leave", () => membershipsMatrix("instagram", "user"));
test("SCRUM-949 r7 tenancy: facebook shared listing phone update removal join leave", () => membershipsMatrix("facebook", "listingPhone"));
test("SCRUM-949 r7 tenancy: instagram shared listing phone update removal join leave", () => membershipsMatrix("instagram", "listingPhone"));
test("SCRUM-949 r7 tenancy: facebook shared listing WhatsApp update removal join leave", () => membershipsMatrix("facebook", "listingWhatsapp"));
test("SCRUM-949 r7 tenancy: instagram shared listing WhatsApp update removal join leave", () => membershipsMatrix("instagram", "listingWhatsapp"));
test("SCRUM-949 r7 tenancy: facebook shared seller profile update removal join leave", () => membershipsMatrix("facebook", "seller"));
test("SCRUM-949 r7 tenancy: instagram shared seller profile update removal join leave", () => membershipsMatrix("instagram", "seller"));
