import type { Infer } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { newestDmEvents, readOrgSettings } from "../../utils/socialDmAccess";
import { buildConversation, flattenSocialEvents } from "./draftContext";
import type { DraftMessage } from "./draftContext";
import { buildSentenceTable } from "./draftSentences";
import type { draftJobValidator } from "./draftValidators";
import { readSealedProviderKey } from "./keyStore";
import { isAiDraftEnabledForOrg } from "./settings";

export type DraftJob = Infer<typeof draftJobValidator>;

// A customer's newest direct messages through one index: enough rows to fill
// the context window, however many comment events the customer has.
const MAX_DM_EVENTS = 40;
const MAX_MESSENGER_ROWS = 12;

// Facebook keeps the full Messenger thread in its own table; use it when present.
async function readFacebookThread(ctx: QueryCtx, draft: Doc<"aiDrafts">): Promise<DraftMessage[]> {
  const rows = await ctx.db
    .query("facebookMessages")
    .withIndex("by_org_customer_ts", (q) => q.eq("orgId", draft.orgId).eq("customerId", draft.customerId))
    .order("desc")
    .take(MAX_MESSENGER_ROWS);
  const messages: DraftMessage[] = [];
  for (const row of rows.reverse()) {
    if (!row.text) continue;
    messages.push({ direction: row.direction === "in" ? "customer" : "dealership", text: row.text });
  }
  return messages;
}

/** The conversation's vehicle, only while it belongs to the organization and is not deleted. */
async function readVehicle(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles"> | undefined
): Promise<Doc<"vehicles"> | null> {
  if (!vehicleId) return null;
  const vehicle = await ctx.db.get(vehicleId);
  return vehicle && vehicle.orgId === orgId && !vehicle.isDeleted ? vehicle : null;
}

async function readFinanceCompany(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  orgSettings: Doc<"orgSettings"> | null
): Promise<Doc<"financeCompanies"> | null> {
  const companyId = orgSettings?.smartReplyDefaultFinanceCompanyId;
  if (!companyId) return null;
  const company = await ctx.db.get(companyId);
  return company && company.orgId === orgId ? company : null;
}

/**
 * Everything the job needs, after re-checking every condition the request
 * checked: a refusal means the action makes no provider call. Returns the
 * ENCRYPTED key; only an internal query may call this. Of the dealership it
 * returns only the pre-rendered Smart Reply sentences.
 */
export async function loadDraftJobData(ctx: QueryCtx, draftId: Id<"aiDrafts">): Promise<DraftJob> {
  const draft = await ctx.db.get(draftId);
  if (draft?.status !== "pending") return { ok: false, reason: "not_pending" };

  const org = await ctx.db.get(draft.orgId);
  if (!org || org.suspended || org.deletionRequestedAt !== undefined || org.destructivePurgeStartedAt !== undefined) {
    return { ok: false, reason: "org_unavailable" };
  }
  if (!(await isAiDraftEnabledForOrg(ctx, draft.orgId))) return { ok: false, reason: "not_enabled" };
  const key = await readSealedProviderKey(ctx, "anthropic");
  if (!key) return { ok: false, reason: "key_missing" };

  const dms = await newestDmEvents(ctx, draft, MAX_DM_EVENTS);
  if (dms.length === 0) return { ok: false, reason: "no_conversation" };

  const orgSettings = await readOrgSettings(ctx, draft.orgId);
  const vehicle = await readVehicle(ctx, draft.orgId, dms.find((dm) => dm.vehicleId)?.vehicleId);
  const financeCompany = await readFinanceCompany(ctx, draft.orgId, orgSettings);

  let messages = flattenSocialEvents([...dms].reverse());
  if (draft.platform === "facebook") {
    const thread = await readFacebookThread(ctx, draft);
    if (thread.length > 0) messages = thread;
  }

  return {
    ok: true,
    sentences: buildSentenceTable({ vehicle, orgSettings, financeCompany }),
    conversation: buildConversation(messages),
    sealedKey: key,
  };
}
