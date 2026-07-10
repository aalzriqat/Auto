import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, ActionCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { isSystemOwnerRole } from "./utils/permissions";
import { notifyManagers } from "./utils/notifications";
import { getValidatedEnv } from "./utils/env";
import { VEHICLE_IMAGE_CONTENT_TYPES } from "./utils/storageValidation";

// Phase 64 — WhatsApp-native dealer intake (structured, no LLM; master plan
// A8). A dealer texts AutoFlow's platform WhatsApp number and answers one
// sequential prompt per message; confirming submits a PENDING `vehicleEdits`
// CREATE request (the existing approval-workflow table, per CLAUDE.md) so a
// staff review step always sits between an inbound message and a live
// listing — nothing auto-publishes. See docs/dealer_network_marketplace_master_plan.md
// Phase 64 and this branch's commit message for the scope decisions below.

const WHATSAPP_GRAPH_VERSION = "v22.0";
const MAX_PHOTOS = 10;
const MAX_FIELD_CHARS = 60;
const MIN_YEAR = 1980;
const MAX_MILEAGE_KM = 2_000_000;
const MAX_PRICE_JOD = 1_000_000;
const MAX_CANDIDATE_PROFILES = 200;
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

// The vehicles schema requires color/fuelType/transmission (non-optional),
// but the master plan's Phase 64 field list is deliberately just
// make/model/year/price/mileage/photos — adding two more decision points
// (fuel type, transmission) would meaningfully lengthen a flow whose own
// acceptance criterion is "under 2 minutes". These placeholders keep the
// flow schema-valid; staff can fill them in during the normal edit flow
// after approval, same as any other vehicle detail refinement.
const UNSPECIFIED_FIELD = "Not specified";

export type IntakeStep =
  | "AWAITING_MAKE"
  | "AWAITING_MODEL"
  | "AWAITING_YEAR"
  | "AWAITING_MILEAGE"
  | "AWAITING_PRICE"
  | "AWAITING_PHOTOS"
  | "AWAITING_CONFIRM"
  | "COMPLETED"
  | "CANCELLED";

export const intakeStepValidator = v.union(
  v.literal("AWAITING_MAKE"),
  v.literal("AWAITING_MODEL"),
  v.literal("AWAITING_YEAR"),
  v.literal("AWAITING_MILEAGE"),
  v.literal("AWAITING_PRICE"),
  v.literal("AWAITING_PHOTOS"),
  v.literal("AWAITING_CONFIRM"),
  v.literal("COMPLETED"),
  v.literal("CANCELLED")
);

export type IntakeState = {
  step: IntakeStep;
  make?: string;
  model?: string;
  year?: number;
  mileage?: number;
  sellingPrice?: number;
  photoCount: number;
};

export type IntakeInput =
  | { kind: "text"; text: string }
  | { kind: "button"; buttonId: string }
  | { kind: "image" };

export type IntakeReply =
  | { kind: "text"; text: string }
  | { kind: "buttons"; text: string; buttons: { id: string; title: string }[] };

const CONFIRM_BUTTON_ID = "MARKETPLACE_INTAKE_CONFIRM";
const CANCEL_BUTTON_ID = "MARKETPLACE_INTAKE_CANCEL";

function isCancelInput(input: IntakeInput): boolean {
  if (input.kind === "button") return input.buttonId === CANCEL_BUTTON_ID;
  return input.kind === "text" && input.text.trim().toUpperCase() === "CANCEL";
}

function isConfirmInput(input: IntakeInput): boolean {
  if (input.kind === "button") return input.buttonId === CONFIRM_BUTTON_ID;
  return input.kind === "text" && input.text.trim().toUpperCase() === "CONFIRM";
}

function isDoneInput(input: IntakeInput): boolean {
  return input.kind === "text" && input.text.trim().toUpperCase() === "DONE";
}

/** Pure — the prompt/reply shown for the current step, with no error prefix. Exported for the welcome message sent on first contact. */
export function promptForStep(state: IntakeState): IntakeReply {
  switch (state.step) {
    case "AWAITING_MAKE":
      return {
        kind: "text",
        text: "Let's list your car on the AutoFlow marketplace! What's the make? (e.g. Toyota)\n\nReply CANCEL anytime to stop.",
      };
    case "AWAITING_MODEL":
      return { kind: "text", text: "Got it. What's the model? (e.g. Corolla)" };
    case "AWAITING_YEAR":
      return { kind: "text", text: "What year is it? (e.g. 2020)" };
    case "AWAITING_MILEAGE":
      return { kind: "text", text: "What's the mileage in km?" };
    case "AWAITING_PRICE":
      return { kind: "text", text: "What's the asking price in JOD?" };
    case "AWAITING_PHOTOS":
      return {
        kind: "text",
        text: `Send 1-${MAX_PHOTOS} photos of the car (${state.photoCount}/${MAX_PHOTOS} received). Reply DONE when finished.`,
      };
    case "AWAITING_CONFIRM":
      return {
        kind: "buttons",
        text: [
          "Please confirm your listing:",
          `${state.year ?? "?"} ${state.make ?? "?"} ${state.model ?? "?"}`,
          `Mileage: ${state.mileage ?? "?"} km`,
          `Price: ${state.sellingPrice ?? "?"} JOD`,
          `Photos: ${state.photoCount}`,
        ].join("\n"),
        buttons: [
          { id: CONFIRM_BUTTON_ID, title: "Confirm" },
          { id: CANCEL_BUTTON_ID, title: "Cancel" },
        ],
      };
    case "COMPLETED":
      return {
        kind: "text",
        text: "Thanks! Your listing has been submitted for review and will go live once an owner or manager approves it.",
      };
    case "CANCELLED":
      return { kind: "text", text: "Listing cancelled. Send any message to start a new one." };
  }
}

function errorReply(message: string, state: IntakeState): IntakeReply {
  const prompt = promptForStep(state);
  if (prompt.kind === "text") return { kind: "text", text: `${message}\n\n${prompt.text}` };
  return { ...prompt, text: `${message}\n\n${prompt.text}` };
}

function parseText(input: IntakeInput, field: string, maxChars: number): { ok: true; value: string } | { ok: false; error: string } {
  if (input.kind !== "text") return { ok: false, error: `Please reply with the car's ${field} as text.` };
  const trimmed = input.text.trim();
  if (!trimmed) return { ok: false, error: `${field} cannot be empty.` };
  if (trimmed.length > maxChars) return { ok: false, error: `${field} is too long.` };
  return { ok: true, value: trimmed };
}

function parseInteger(input: IntakeInput, field: string, min: number, max: number): { ok: true; value: number } | { ok: false; error: string } {
  if (input.kind !== "text") return { ok: false, error: `Please reply with the ${field} as a number.` };
  const value = Number(input.text.trim().replace(/,/g, ""));
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: `Please send a valid ${field} (a whole number between ${min} and ${max}).` };
  }
  return { ok: true, value };
}

function parsePrice(input: IntakeInput): { ok: true; value: number } | { ok: false; error: string } {
  if (input.kind !== "text") return { ok: false, error: "Please reply with the price as a number." };
  const value = Number(input.text.trim().replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0 || value > MAX_PRICE_JOD) {
    return { ok: false, error: `Please send a valid price in JOD (between 1 and ${MAX_PRICE_JOD}).` };
  }
  return { ok: true, value };
}

/**
 * Pure state machine — one field collected per inbound message, matching
 * master plan A8 ("guided WhatsApp flow with structured replies, not
 * free-text parsing"): each step expects exactly one specific answer type,
 * validated and re-prompted on error, never an LLM extracting fields from
 * one free-form blob. CONFIRM/CANCEL accept both a genuine WhatsApp button
 * tap and the equivalent typed word, since a WhatsApp client not rendering
 * buttons shouldn't strand a dealer mid-flow.
 */
export function computeNextIntakeState(current: IntakeState, input: IntakeInput): { state: IntakeState; reply: IntakeReply } {
  if (current.step !== "COMPLETED" && current.step !== "CANCELLED" && isCancelInput(input)) {
    const state: IntakeState = { ...current, step: "CANCELLED" };
    return { state, reply: promptForStep(state) };
  }

  switch (current.step) {
    case "AWAITING_MAKE": {
      const result = parseText(input, "make", MAX_FIELD_CHARS);
      if (!result.ok) return { state: current, reply: errorReply(result.error, current) };
      const state: IntakeState = { ...current, make: result.value, step: "AWAITING_MODEL" };
      return { state, reply: promptForStep(state) };
    }
    case "AWAITING_MODEL": {
      const result = parseText(input, "model", MAX_FIELD_CHARS);
      if (!result.ok) return { state: current, reply: errorReply(result.error, current) };
      const state: IntakeState = { ...current, model: result.value, step: "AWAITING_YEAR" };
      return { state, reply: promptForStep(state) };
    }
    case "AWAITING_YEAR": {
      const result = parseInteger(input, "year", MIN_YEAR, new Date().getFullYear() + 1);
      if (!result.ok) return { state: current, reply: errorReply(result.error, current) };
      const state: IntakeState = { ...current, year: result.value, step: "AWAITING_MILEAGE" };
      return { state, reply: promptForStep(state) };
    }
    case "AWAITING_MILEAGE": {
      const result = parseInteger(input, "mileage", 0, MAX_MILEAGE_KM);
      if (!result.ok) return { state: current, reply: errorReply(result.error, current) };
      const state: IntakeState = { ...current, mileage: result.value, step: "AWAITING_PRICE" };
      return { state, reply: promptForStep(state) };
    }
    case "AWAITING_PRICE": {
      const result = parsePrice(input);
      if (!result.ok) return { state: current, reply: errorReply(result.error, current) };
      const state: IntakeState = { ...current, sellingPrice: result.value, step: "AWAITING_PHOTOS" };
      return { state, reply: promptForStep(state) };
    }
    case "AWAITING_PHOTOS": {
      if (input.kind === "image") {
        // photoCount is updated by the caller (which actually stores the
        // media) before this function runs; just re-show the prompt.
        return { state: current, reply: promptForStep(current) };
      }
      if (isDoneInput(input)) {
        if (current.photoCount === 0) {
          return { state: current, reply: errorReply("Please send at least one photo first.", current) };
        }
        const state: IntakeState = { ...current, step: "AWAITING_CONFIRM" };
        return { state, reply: promptForStep(state) };
      }
      return { state: current, reply: errorReply("Please send a photo, or reply DONE when finished.", current) };
    }
    case "AWAITING_CONFIRM": {
      if (isConfirmInput(input)) {
        const state: IntakeState = { ...current, step: "COMPLETED" };
        return { state, reply: promptForStep(state) };
      }
      return { state: current, reply: errorReply("Please tap Confirm or Cancel above.", current) };
    }
    case "COMPLETED":
    case "CANCELLED":
      // A terminal flow is never advanced — the caller starts a fresh one.
      return { state: current, reply: promptForStep(current) };
  }
}

function normalizePhoneDigits(value: string): string {
  return value.replace(/[^\d]/g, "");
}

/** Resolves an inbound WhatsApp sender to the opted-in marketplace dealer whose profile lists that number, if any. */
export const findDealerOrgByPhone = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const digits = normalizePhoneDigits(args.phone);
    if (!digits) return null;
    const profiles = await ctx.db
      .query("marketplaceDealerProfiles")
      .withIndex("by_opted_in", (q) => q.eq("isOptedIn", true))
      .take(MAX_CANDIDATE_PROFILES);
    const match = profiles.find(
      (profile) => !profile.isDeleted && profile.whatsappNumber && normalizePhoneDigits(profile.whatsappNumber) === digits
    );
    return match?.orgId ?? null;
  },
});

/** The most recent non-terminal flow for a phone number, or null if none is in progress. */
export const getActiveFlow = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const flows = await ctx.db
      .query("marketplaceWhatsAppFlows")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .order("desc")
      .take(1);
    const flow = flows[0];
    if (!flow || flow.step === "COMPLETED" || flow.step === "CANCELLED") return null;
    return flow;
  },
});

export const saveFlowState = internalMutation({
  args: {
    flowId: v.optional(v.id("marketplaceWhatsAppFlows")),
    orgId: v.id("organizations"),
    phone: v.string(),
    step: intakeStepValidator,
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    year: v.optional(v.number()),
    mileage: v.optional(v.number()),
    sellingPrice: v.optional(v.number()),
    photoStorageIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const fields = {
      step: args.step,
      make: args.make,
      model: args.model,
      year: args.year,
      mileage: args.mileage,
      sellingPrice: args.sellingPrice,
      photoStorageIds: args.photoStorageIds,
      updatedAt: now,
    };
    if (args.flowId) {
      await ctx.db.patch(args.flowId, fields);
      return args.flowId;
    }
    return await ctx.db.insert("marketplaceWhatsAppFlows", {
      orgId: args.orgId,
      phone: args.phone,
      ...fields,
      createdAt: now,
    });
  },
});

async function resolveOrgOwnerUserId(ctx: MutationCtx, orgId: Id<"organizations">): Promise<Id<"users"> | null> {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  for (const membership of memberships) {
    const role = await ctx.db.get(membership.roleId);
    if (role && !role.isDeleted && isSystemOwnerRole(role)) return membership.userId;
  }
  return null;
}

/** Confirmed flow -> a PENDING vehicleEdits CREATE request, the same approval-workflow table every other vehicle create/edit already goes through — nothing publishes directly from WhatsApp. */
export const finalizeFlow = internalMutation({
  args: { flowId: v.id("marketplaceWhatsAppFlows") },
  handler: async (ctx, args) => {
    const flow = await ctx.db.get(args.flowId);
    if (!flow || flow.vehicleEditId) return;

    const ownerUserId = await resolveOrgOwnerUserId(ctx, flow.orgId);
    if (!ownerUserId) {
      console.error(`marketplaceWhatsAppIntake.finalizeFlow: no OWNER found for org ${flow.orgId}`);
      return;
    }

    const vehicleEditId = await ctx.db.insert("vehicleEdits", {
      orgId: flow.orgId,
      requestedBy: ownerUserId,
      type: "CREATE",
      payload: {
        make: flow.make,
        model: flow.model,
        year: flow.year,
        mileage: flow.mileage,
        sellingPrice: flow.sellingPrice,
        color: UNSPECIFIED_FIELD,
        fuelType: UNSPECIFIED_FIELD,
        transmission: UNSPECIFIED_FIELD,
        status: "AVAILABLE",
        imageIds: flow.photoStorageIds,
        notes: "Submitted via WhatsApp marketplace intake — review make/model/year/mileage/price/photos and fill in color/fuel type/transmission.",
      },
      status: "PENDING",
      createdAt: Date.now(),
    });

    await ctx.db.patch(flow._id, { vehicleEditId, updatedAt: Date.now() });

    await notifyManagers(
      ctx,
      flow.orgId,
      "vehicle.create_requested",
      { actorName: "WhatsApp", vehicleLabel: `${flow.year ?? ""} ${flow.make ?? ""} ${flow.model ?? ""}`.trim() },
      { link: `/${flow.orgId}/vehicles?approvals=true` }
    );
  },
});

async function fetchAndStoreWhatsAppMedia(ctx: ActionCtx, mediaId: string, apiToken: string): Promise<Id<"_storage"> | null> {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as { url?: string };
    if (!meta.url) return null;

    const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${apiToken}` } });
    if (!fileRes.ok) return null;

    const contentType = fileRes.headers.get("content-type")?.toLowerCase() ?? "";
    if (!(VEHICLE_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) return null;

    const blob = await fileRes.blob();
    if (blob.size <= 0 || blob.size > MAX_MEDIA_BYTES) return null;

    return await ctx.storage.store(blob);
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function sendIntakeReply(phone: string, reply: IntakeReply, phoneNumberId: string, apiToken: string): Promise<void> {
  const body =
    reply.kind === "text"
      ? { messaging_product: "whatsapp", to: phone, type: "text", text: { body: reply.text } }
      : {
          messaging_product: "whatsapp",
          to: phone,
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: reply.text },
            action: {
              buttons: reply.buttons.map((button) => ({
                type: "reply",
                reply: { id: button.id, title: button.title },
              })),
            },
          },
        };

  try {
    const res = await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`marketplaceWhatsAppIntake send failed: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  } catch (error) {
    console.error(error);
  }
}

const intakeInputValidator = v.union(
  v.object({ kind: v.literal("text"), text: v.string() }),
  v.object({ kind: v.literal("button"), buttonId: v.string() }),
  v.object({ kind: v.literal("image"), mediaId: v.string() })
);

/**
 * Orchestrates one inbound WhatsApp message through the intake flow: resolve
 * the dealer's org, load/advance flow state, store any photo, finalize on
 * confirm, and send the next prompt back. Called from the
 * /marketplace-whatsapp-webhook HTTP route in http.ts.
 */
export const handleIntakeMessage = internalAction({
  args: { phone: v.string(), input: intakeInputValidator },
  handler: async (ctx, args) => {
    const env = getValidatedEnv();
    const phoneNumberId = env.MARKETPLACE_WHATSAPP_PHONE_NUMBER_ID;
    const apiToken = env.MARKETPLACE_WHATSAPP_API_TOKEN;
    // Quietly no-ops when unconfigured — same posture as sendNotificationWhatsapp
    // (whatsappSend.ts): real dealer reach is blocked on Meta Business
    // Verification (master plan A5b), not a reason to throw from a webhook handler.
    if (!phoneNumberId || !apiToken) return;

    const orgId: Id<"organizations"> | null = await ctx.runQuery(internal.marketplaceWhatsAppIntake.findDealerOrgByPhone, {
      phone: args.phone,
    });
    if (!orgId) {
      await sendIntakeReply(
        args.phone,
        { kind: "text", text: "This number isn't registered as an AutoFlow marketplace dealer. Contact AutoFlow support to get set up." },
        phoneNumberId,
        apiToken
      );
      return;
    }

    const existingFlow: Doc<"marketplaceWhatsAppFlows"> | null = await ctx.runQuery(
      internal.marketplaceWhatsAppIntake.getActiveFlow,
      { phone: args.phone }
    );

    if (!existingFlow) {
      const freshState: IntakeState = { step: "AWAITING_MAKE", photoCount: 0 };
      await ctx.runMutation(internal.marketplaceWhatsAppIntake.saveFlowState, {
        orgId,
        phone: args.phone,
        step: freshState.step,
        photoStorageIds: [],
      });
      await sendIntakeReply(args.phone, promptForStep(freshState), phoneNumberId, apiToken);
      return;
    }

    let photoStorageIds = existingFlow.photoStorageIds;
    if (args.input.kind === "image" && existingFlow.step === "AWAITING_PHOTOS" && photoStorageIds.length < MAX_PHOTOS) {
      const storageId = await fetchAndStoreWhatsAppMedia(ctx, args.input.mediaId, apiToken);
      if (storageId) photoStorageIds = [...photoStorageIds, storageId];
    }

    const currentState: IntakeState = {
      step: existingFlow.step,
      make: existingFlow.make,
      model: existingFlow.model,
      year: existingFlow.year,
      mileage: existingFlow.mileage,
      sellingPrice: existingFlow.sellingPrice,
      photoCount: photoStorageIds.length,
    };

    const transitionInput: IntakeInput =
      args.input.kind === "image" ? { kind: "image" } : args.input.kind === "button" ? { kind: "button", buttonId: args.input.buttonId } : { kind: "text", text: args.input.text };

    const { state, reply } = computeNextIntakeState(currentState, transitionInput);

    const flowId: Id<"marketplaceWhatsAppFlows"> = await ctx.runMutation(internal.marketplaceWhatsAppIntake.saveFlowState, {
      flowId: existingFlow._id,
      orgId,
      phone: args.phone,
      step: state.step,
      make: state.make,
      model: state.model,
      year: state.year,
      mileage: state.mileage,
      sellingPrice: state.sellingPrice,
      photoStorageIds,
    });

    if (state.step === "COMPLETED") {
      await ctx.runMutation(internal.marketplaceWhatsAppIntake.finalizeFlow, { flowId });
    }

    await sendIntakeReply(args.phone, reply, phoneNumberId, apiToken);
  },
});
