import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type SharedMobileNumber = {
  normalized: string;
  variants: string[];
};

const JORDAN_COUNTRY_CODE = "962";
const INTERNATIONAL_PREFIX = `00${JORDAN_COUNTRY_CODE}`;
const PHONE_CANDIDATE_RE = /(?:\+\s*|00\s*)?\d(?:[\d\s().\-\/\\_,:;،٬٫]*\d){6,}/g;
const BIDI_CONTROL_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function normalizePhoneText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(BIDI_CONTROL_RE, "")
    .replace(/[\ufe62\uff0b]/g, "+")
    .replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (digit) => {
      const code = digit.charCodeAt(0);
      const offset = code >= 0x06f0 ? 0x06f0 : 0x0660;
      return String(code - offset);
    });
}

function isAllowedLocalNumber(localNumber: string): boolean {
  return /^(?:07[789]\d{7}|06\d{7})$/.test(localNumber);
}

function localNumberFromCandidate(candidate: string): string | null {
  const trimmed = candidate.trim();
  const digits = trimmed.replace(/\D/g, "");

  if (trimmed.startsWith("+") && digits.startsWith(JORDAN_COUNTRY_CODE)) {
    const nationalNumber = digits.slice(JORDAN_COUNTRY_CODE.length);
    const localNumber = nationalNumber.startsWith("0") ? nationalNumber : `0${nationalNumber}`;
    return isAllowedLocalNumber(localNumber) ? localNumber : null;
  }

  if (digits.startsWith(INTERNATIONAL_PREFIX)) {
    const nationalNumber = digits.slice(INTERNATIONAL_PREFIX.length);
    const localNumber = nationalNumber.startsWith("0") ? nationalNumber : `0${nationalNumber}`;
    return isAllowedLocalNumber(localNumber) ? localNumber : null;
  }

  return isAllowedLocalNumber(digits) ? digits : null;
}

function variantsFromLocalNumber(localNumber: string): string[] {
  const nationalNumber = localNumber.slice(1);
  return [
    localNumber,
    `+${JORDAN_COUNTRY_CODE}${nationalNumber}`,
    `${INTERNATIONAL_PREFIX}${nationalNumber}`,
  ];
}

/**
 * Extracts Jordanian contact numbers dealers asked to qualify social DMs by:
 * +962/00962 international formats, or direct 079/077/078/06 local formats.
 */
export function extractSharedMobileNumber(text: string | undefined): SharedMobileNumber | null {
  if (!text) return null;

  const candidates = normalizePhoneText(text).match(PHONE_CANDIDATE_RE) ?? [];
  for (const candidate of candidates) {
    const localNumber = localNumberFromCandidate(candidate);
    if (!localNumber) continue;

    const variants = variantsFromLocalNumber(localNumber);
    const trimmedCandidate = candidate.trim();
    const candidateDigits = trimmedCandidate.replace(/\D/g, "");
    const usesInternationalPrefix =
      trimmedCandidate.startsWith("+") || candidateDigits.startsWith(INTERNATIONAL_PREFIX);
    const normalized = usesInternationalPrefix ? variants[1] : localNumber;
    return { normalized, variants };
  }

  return null;
}

export async function attachSharedMobileNumberToCustomer(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  customer: Doc<"customers">,
  sharedMobileNumber: SharedMobileNumber | null
): Promise<void> {
  if (!sharedMobileNumber || customer.phone) return;

  for (const variant of sharedMobileNumber.variants) {
    const matches = await ctx.db
      .query("customers")
      .withIndex("by_org_phone", (q) => q.eq("orgId", orgId).eq("phone", variant))
      .take(2);
    const conflictingCustomer = matches.find((match) => match._id !== customer._id && !match.isDeleted);
    if (conflictingCustomer) return;
  }

  await ctx.db.patch(customer._id, { phone: sharedMobileNumber.normalized });
}
