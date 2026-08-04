import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Splits a social profile name into first/last for a `customers` row.
 *
 * A mononym gets an empty surname rather than a copy of the first name.
 * Instagram handles are usually a single word, and duplicating produced
 * contacts displayed as "mhty7220 mhty7220" everywhere the two fields are
 * joined. Every join site trims, so an empty surname renders cleanly.
 */
export function splitDisplayName(displayName: string): { firstName: string; lastName: string } {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

/**
 * True when a contact's surname is just a copy of its first name.
 *
 * The old splitter wrote a mononym into both fields, and Instagram enrichment
 * prefers the account's `username` — always a single token — so essentially
 * every IG contact it touched ended up like "mhty7220 mhty7220".
 *
 * Used to make those rows eligible for a re-fetch, not to rewrite them blind.
 * Re-fetching is what makes this safe for someone genuinely named "Ali Ali":
 * Graph returns first_name "Ali" and last_name "Ali", which the fixed splitter
 * writes back unchanged, while a handle collapses to a single name.
 */
export function hasDuplicatedName(
  customer: { firstName: string; lastName: string }
): boolean {
  const first = customer.firstName.trim();
  return first.length > 0 && first === customer.lastName.trim();
}

/** The surname half of both platform placeholders. */
export const PLACEHOLDER_SURNAME = "Contact";

/**
 * True when a contact carries a real first name but the placeholder's surname.
 *
 * The old splitter read a single-token name as
 * `lastName: parts.slice(1).join(" ") || PLACEHOLDER_LAST_NAME`, so an
 * Instagram handle or a mononym came out as "kamalalia19 Contact" or
 * "Feras Contact". Those rows are invisible to every other repair: the first
 * name is genuine so they are not placeholders, and the two halves differ so
 * they are not duplicates — which left them stuck with a surname no one ever
 * had.
 *
 * `firstName` must not itself be a platform placeholder, so a true
 * "Facebook Contact" stays fully unresolved and still gets a name lookup
 * rather than being quietly shortened to "Facebook".
 *
 * Every placeholder is checked, not just the one for the platform being
 * repaired. A contact carrying both a Facebook and an Instagram id and named
 * "Facebook Contact" would otherwise clear the Instagram check — "Facebook" is
 * not "Instagram" — and be shortened, which is the one outcome this must never
 * produce: it looks repaired while having thrown away the marker that says a
 * real name is still missing.
 */
export function hasStrayPlaceholderSurname(
  customer: { firstName: string; lastName: string },
  placeholderFirstNames: readonly string[]
): boolean {
  const first = customer.firstName.trim();
  return (
    customer.lastName.trim() === PLACEHOLDER_SURNAME &&
    first.length > 0 &&
    !placeholderFirstNames.includes(first)
  );
}

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
 * The dealership's own numbers, in every format they might be written in.
 *
 * Instagram and Messenger include the post's caption in the payload when
 * someone replies to a post, so a dealer whose own advert lists their showroom
 * numbers had those numbers read back as "the customer shared their mobile" —
 * which saved the dealer's number onto the customer, satisfied the
 * lead-requires-a-mobile gate, and auto-replied "we received your number".
 * Their own numbers can never be the contact detail being collected.
 */
export function ownNumberExclusions(
  settings: { dealershipPhone?: string; dealershipPhones?: string[] } | null | undefined
): Set<string> {
  const excluded = new Set<string>();
  if (!settings) return excluded;

  const raw = [settings.dealershipPhone, ...(settings.dealershipPhones ?? [])];
  for (const value of raw) {
    if (!value?.trim()) continue;
    const normalized = normalizePhoneText(value).trim();
    // These settings are stored exactly as typed — `dealershipPhone` is not
    // even trimmed on write — so the same number turns up as "0799103353",
    // "+962799103353", "00962799103353" or a bare "962799103353". Only the
    // first three parse on their own; without the prefixed retries a dealer
    // who wrote their number the fourth way got an empty exclusion set and
    // the original bug back, silently.
    const localNumber =
      localNumberFromCandidate(normalized) ??
      localNumberFromCandidate(`+${normalized}`) ??
      localNumberFromCandidate(`00${normalized}`);
    if (!localNumber) continue;
    for (const variant of variantsFromLocalNumber(localNumber)) excluded.add(variant);
  }
  return excluded;
}

/**
 * Extracts Jordanian contact numbers dealers asked to qualify social DMs by:
 * +962/00962 international formats, or direct 079/077/078/06 local formats.
 *
 * `excluded` holds the org's own numbers (see `ownNumberExclusions`). A match
 * against one of those is skipped rather than aborting the scan, so a message
 * that quotes the dealer's advert *and* adds the sender's own number still
 * finds the sender's.
 */
export function extractSharedMobileNumber(
  text: string | undefined,
  excluded?: ReadonlySet<string>
): SharedMobileNumber | null {
  if (!text) return null;

  const candidates = normalizePhoneText(text).match(PHONE_CANDIDATE_RE) ?? [];
  for (const candidate of candidates) {
    const localNumber = localNumberFromCandidate(candidate);
    if (!localNumber) continue;
    if (excluded?.has(localNumber)) continue;

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

/**
 * Writes a freshly-looked-up profile name onto a social contact.
 *
 * Only overwrites a name nobody chose: the platform placeholder, a record
 * still holding the raw PSID/IGSID, or one whose surname merely repeats its
 * first name (the old splitter's artifact). A name a staff member edited is
 * never clobbered. `isUnresolved` is supplied per platform because each knows
 * its own placeholder and id.
 */
export async function applyResolvedDisplayName(
  ctx: MutationCtx,
  customerId: Id<"customers">,
  displayName: string,
  isUnresolved: (customer: Pick<Doc<"customers">, "firstName" | "lastName">) => boolean
): Promise<void> {
  // Guarded here rather than in each caller: this is the only write path, and
  // a blank name would clear the contact's name outright — strictly worse than
  // leaving the placeholder that prompted the lookup.
  if (!displayName.trim()) return;
  const customer = await ctx.db.get(customerId);
  // Deliberately does NOT accept a duplicated name as rewritable. Instagram
  // often returns only a handle, so treating "Ali Ali" as repairable here
  // would replace a real (possibly staff-entered) name with "ali_1990".
  // Duplicated rows are repaired by `collapseDuplicatedName`, which can only
  // drop the repeated surname and can never invent a different name.
  if (!customer || !isUnresolved(customer)) return;
  await ctx.db.patch(customerId, splitDisplayName(displayName));
}

/**
 * Loads the org's settings and, for a DM, the mobile number its sender shared.
 *
 * The two are read together because the exclusion set comes from the settings:
 * extraction has to run *after* them, and both social handlers need the
 * settings anyway. Shared rather than mirrored so the Facebook and Instagram
 * intake paths cannot drift on which numbers they ignore.
 */
export async function readSettingsAndSharedMobile(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  kind: "comment" | "dm",
  text: string | undefined
): Promise<{
  settings: Doc<"orgSettings"> | null;
  sharedMobileNumber: SharedMobileNumber | null;
}> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();

  return {
    settings,
    sharedMobileNumber:
      kind === "dm" ? extractSharedMobileNumber(text, ownNumberExclusions(settings)) : null,
  };
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
