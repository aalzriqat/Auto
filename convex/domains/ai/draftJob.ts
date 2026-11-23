import type { Infer } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { calculateFinancingEstimate } from "../../utils/smartReplyBuilder";
import { buildDraftContext, flattenSocialEvents } from "./draftContext";
import type { DraftContext, DraftFinancingInput, DraftMessage, DraftVehicleInput } from "./draftContext";
import type { draftJobValidator } from "./draftValidators";
import { readSealedProviderKey } from "./keyStore";
import { isAiDraftEnabledForOrg } from "./settings";

export type DraftJob = Infer<typeof draftJobValidator>;

// A customer's thread is read newest first and stops early: enough rows to
// fill the context window even when most are comments, never the whole table.
const MAX_DM_EVENTS = 40;
const MAX_SCANNED_EVENTS = 300;

type ProjectedVehicle = DraftVehicleInput & { status: Doc<"vehicles">["status"] };

interface DmEvents {
  /** Newest first. */
  dms: { text?: string; autoReplyText?: string; manualReplyText?: string; vehicleId?: Id<"vehicles"> }[];
}

async function readDmEvents(
  ctx: QueryCtx,
  draft: Doc<"aiDrafts">
): Promise<DmEvents> {
  const dms: DmEvents["dms"] = [];
  let scanned = 0;
  const take = (event: Doc<"instagramEvents"> | Doc<"facebookEvents">): boolean => {
    scanned += 1;
    if (event.kind === "dm") {
      dms.push({
        text: event.text,
        autoReplyText: event.autoReplyText,
        manualReplyText: event.manualReplyText,
        vehicleId: event.vehicleId,
      });
    }
    return dms.length < MAX_DM_EVENTS && scanned < MAX_SCANNED_EVENTS;
  };
  if (draft.platform === "instagram") {
    const events = ctx.db
      .query("instagramEvents")
      .withIndex("by_org_customer", (q) => q.eq("orgId", draft.orgId).eq("customerId", draft.customerId))
      .order("desc");
    for await (const event of events) if (!take(event)) break;
  } else {
    const events = ctx.db
      .query("facebookEvents")
      .withIndex("by_org_customer", (q) => q.eq("orgId", draft.orgId).eq("customerId", draft.customerId))
      .order("desc");
    for await (const event of events) if (!take(event)) break;
  }
  return { dms };
}

// Facebook keeps the full Messenger thread in its own table; use it when present.
async function readFacebookThread(ctx: QueryCtx, draft: Doc<"aiDrafts">): Promise<DraftMessage[]> {
  const rows = await ctx.db
    .query("facebookMessages")
    .withIndex("by_org_customer_ts", (q) => q.eq("orgId", draft.orgId).eq("customerId", draft.customerId))
    .order("desc")
    .take(12);
  const messages: DraftMessage[] = [];
  for (const row of rows.reverse()) {
    if (!row.text) continue;
    messages.push({ direction: row.direction === "in" ? "customer" : "dealership", text: row.text });
  }
  return messages;
}

async function readVehicle(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles"> | undefined
): Promise<ProjectedVehicle | null> {
  if (!vehicleId) return null;
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle || vehicle.orgId !== orgId || vehicle.isDeleted) return null;
  // Named fields only: costs, VIN, notes and supplier never leave this function.
  const projected: ProjectedVehicle = {
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.model,
    mileage: vehicle.mileage,
    color: vehicle.color,
    fuelType: vehicle.fuelType,
    transmission: vehicle.transmission,
    sellingPrice: vehicle.sellingPrice,
    status: vehicle.status,
  };
  if (vehicle.trim) projected.trim = vehicle.trim;
  return projected;
}

async function readFinancing(
  ctx: QueryCtx,
  orgSettings: Doc<"orgSettings"> | null,
  orgId: Id<"organizations">,
  vehicle: ProjectedVehicle | null
): Promise<DraftFinancingInput | null> {
  const financeCompanyId = orgSettings?.smartReplyDefaultFinanceCompanyId;
  if (!vehicle || !orgSettings || !financeCompanyId) return null;
  const company = await ctx.db.get(financeCompanyId);
  if (!company || company.orgId !== orgId) return null;
  return calculateFinancingEstimate({
    vehicle: { sellingPrice: vehicle.sellingPrice, status: vehicle.status },
    orgSettings: {
      smartReplyFinancingMode: orgSettings.smartReplyFinancingMode,
      smartReplyDefaultDownPaymentPercent: orgSettings.smartReplyDefaultDownPaymentPercent,
    },
    financeCompany: {
      isActive: company.isActive,
      profitRate: company.profitRate,
      maxTermMonths: company.maxTermMonths,
      gracePeriodMonths: company.gracePeriodMonths,
      adminFees: company.adminFees,
      commission: company.commission,
      insuranceRate: company.insuranceRate,
      includesCommissionInDebt: company.includesCommissionInDebt,
    },
  });
}

/**
 * Everything the job needs, after re-checking every condition the request
 * checked: a refusal means the action makes no provider call. Returns the
 * ENCRYPTED key; only an internal query may call this.
 */
export async function loadDraftJobData(ctx: QueryCtx, draftId: Id<"aiDrafts">): Promise<DraftJob> {
  const draft = await ctx.db.get(draftId);
  if (!draft || draft.status !== "pending") return { ok: false, reason: "not_pending" };

  const org = await ctx.db.get(draft.orgId);
  if (!org || org.suspended || org.deletionRequestedAt !== undefined || org.destructivePurgeStartedAt !== undefined) {
    return { ok: false, reason: "org_unavailable" };
  }
  if (!(await isAiDraftEnabledForOrg(ctx, draft.orgId))) return { ok: false, reason: "not_enabled" };
  const key = await readSealedProviderKey(ctx, "anthropic");
  if (!key) return { ok: false, reason: "key_missing" };

  const { dms } = await readDmEvents(ctx, draft);
  if (dms.length === 0) return { ok: false, reason: "no_conversation" };

  const orgSettings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", draft.orgId))
    .unique();
  const vehicle = await readVehicle(ctx, draft.orgId, dms.find((dm) => dm.vehicleId)?.vehicleId);
  const financing = await readFinancing(ctx, orgSettings, draft.orgId, vehicle);

  let messages = flattenSocialEvents([...dms].reverse());
  if (draft.platform === "facebook") {
    const thread = await readFacebookThread(ctx, draft);
    if (thread.length > 0) messages = thread;
  }

  const context: DraftContext = buildDraftContext({
    org: {
      dealershipName: orgSettings?.dealershipName,
      dealershipAddress: orgSettings?.dealershipAddress,
      dealershipPhone: orgSettings?.dealershipPhone,
      currencySymbol: orgSettings?.currencySymbol,
      currency: orgSettings?.currency,
    },
    vehicle,
    financing,
    messages,
  });
  return { ok: true, context, sealedKey: key };
}
