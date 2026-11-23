/**
 * The only data the draft writer may see.
 *
 * `buildDraftContext` copies named fields one by one into new objects. Nothing
 * is spread and no input is ever returned or stored as it came in, so a whole
 * document handed over by mistake (it still type-checks, because TypeScript is
 * structural) cannot leak fields the provider must not receive: costs, notes,
 * VIN, supplier, tokens, custom templates, sender identity.
 */

import { v, type Infer } from "convex/values";

export const MAX_CONTEXT_MESSAGES = 12;
export const MAX_MESSAGE_CHARACTERS = 1500;

const draftMessageValidator = v.object({
  direction: v.union(v.literal("customer"), v.literal("dealership")),
  text: v.string(),
});
export type DraftMessage = Infer<typeof draftMessageValidator>;
export type DraftMessageDirection = DraftMessage["direction"];

/**
 * The projected context the draft job hands from the query to the action. The
 * TypeScript type is derived from it, so the wire shape and the type are one
 * definition.
 */
export const draftContextValidator = v.object({
  org: v.object({
    name: v.optional(v.string()),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    currency: v.string(),
  }),
  vehicle: v.union(
    v.null(),
    v.object({
      year: v.number(),
      make: v.string(),
      model: v.string(),
      trim: v.optional(v.string()),
      mileage: v.number(),
      color: v.string(),
      fuelType: v.string(),
      transmission: v.string(),
      status: v.string(),
      /** Present only while the vehicle is AVAILABLE. */
      listedPrice: v.optional(v.number()),
    })
  ),
  /** Present only while the vehicle is AVAILABLE. */
  financing: v.union(
    v.null(),
    v.object({ monthlyAmount: v.number(), termMonths: v.number(), downPaymentPercent: v.number() })
  ),
  conversation: v.array(draftMessageValidator),
});
export type DraftContext = Infer<typeof draftContextValidator>;

export interface DraftOrgInput {
  dealershipName?: string;
  dealershipAddress?: string;
  dealershipPhone?: string;
  currencySymbol?: string;
  currency?: string;
}

export interface DraftVehicleInput {
  year: number;
  make: string;
  model: string;
  trim?: string;
  mileage: number;
  color: string;
  fuelType: string;
  transmission: string;
  sellingPrice: number;
  status: string;
}

export interface DraftFinancingInput {
  monthlyAmount: number;
  termMonths: number;
  downPaymentPercent: number;
}

export interface DraftContextInput {
  org: DraftOrgInput;
  vehicle: DraftVehicleInput | null;
  /** The number from `calculateFinancingEstimate`, or null. */
  financing: DraftFinancingInput | null;
  /** Chronological, oldest first. */
  messages: readonly DraftMessage[];
}

/** Event fields that carry message text, and nothing else. */
export interface DraftEventTextInput {
  text?: string;
  autoReplyText?: string;
  manualReplyText?: string;
}

/**
 * One social DM event becomes up to three messages: what the customer wrote,
 * then the automatic reply, then the staff reply. Events are chronological.
 */
export function flattenSocialEvents(events: readonly DraftEventTextInput[]): DraftMessage[] {
  const messages: DraftMessage[] = [];
  for (const event of events) {
    if (event.text) messages.push({ direction: "customer", text: event.text });
    if (event.autoReplyText) messages.push({ direction: "dealership", text: event.autoReplyText });
    if (event.manualReplyText) messages.push({ direction: "dealership", text: event.manualReplyText });
  }
  return messages;
}

function cutToCharacters(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() ? value : undefined;
}

export function buildDraftContext(input: DraftContextInput): DraftContext {
  const org: DraftContext["org"] = {
    currency: input.org.currencySymbol || input.org.currency || "",
  };
  const name = nonEmpty(input.org.dealershipName);
  const address = nonEmpty(input.org.dealershipAddress);
  const phone = nonEmpty(input.org.dealershipPhone);
  if (name) org.name = name;
  if (address) org.address = address;
  if (phone) org.phone = phone;

  const source = input.vehicle;
  let vehicle: DraftContext["vehicle"] = null;
  let financing: DraftContext["financing"] = null;
  if (source) {
    vehicle = {
      year: source.year,
      make: source.make,
      model: source.model,
      mileage: source.mileage,
      color: source.color,
      fuelType: source.fuelType,
      transmission: source.transmission,
      status: source.status,
    };
    if (source.trim) vehicle.trim = source.trim;
    if (source.status === "AVAILABLE") {
      vehicle.listedPrice = source.sellingPrice;
      if (input.financing) {
        financing = {
          monthlyAmount: input.financing.monthlyAmount,
          termMonths: input.financing.termMonths,
          downPaymentPercent: input.financing.downPaymentPercent,
        };
      }
    }
  }

  const conversation: DraftMessage[] = [];
  for (const message of input.messages) {
    const text = cutToCharacters(message.text ?? "", MAX_MESSAGE_CHARACTERS);
    if (!text.trim()) continue;
    conversation.push({ direction: message.direction, text });
  }

  return { org, vehicle, financing, conversation: conversation.slice(-MAX_CONTEXT_MESSAGES) };
}
