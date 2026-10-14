/**
 * What of an `orgSettings` row may leave the backend through a PUBLIC query.
 *
 * `orgSettings.get` once returned the raw row to anyone with `view:settings`, so
 * every connected-account credential on it (WhatsApp, Instagram and Facebook
 * tokens, the webhook secret, pending Page tokens) reached every such browser and
 * phone. A public query returns this projection instead; code that needs a
 * credential reads the table itself, inside the backend.
 *
 * It is an ALLOWLIST, so a field added to the schema later is withheld until
 * someone puts it in the list on purpose. The check at the bottom makes that
 * decision unavoidable: a schema field in neither list stops the typecheck.
 */
import type { Doc } from "../_generated/dataModel";

type OrgSettingsField = Exclude<keyof Doc<"orgSettings">, "_id" | "_creationTime">;

/**
 * Non-secret configuration a client may receive. Not all of it is read from the
 * settings query today: the social and auto-reply settings are also served, with
 * their plan check, by the two `getConnectionStatus` queries.
 */
export const PUBLIC_ORG_SETTINGS_FIELDS = [
  "orgId",
  "currency",
  "currencySymbol",
  "vatRate",
  "country",
  "timezone",
  "enabledPaymentTypes",
  "logoStorageId",
  "primaryColor",
  "dealershipName",
  "legalCompanyName",
  "dealershipAddress",
  "dealershipPhone",
  "dealershipPhones",
  "approvalThresholdEnabled",
  "approvalMinProfitPercent",
  "commissionTiers",
  "commissionMode",
  "reservationHoldDays",
  "instagramPageName",
  "socialAutoPostEnabled",
  "instagramAutoReplyEnabled",
  "instagramAutoReplyMessages",
  "instagramAutoReplyMobileReceivedMessage",
  "instagramLeadFromCommentsEnabled",
  "instagramLeadFromDmsEnabled",
  "instagramLeadFromDmsRequiresMobile",
  "facebookPageName",
  "facebookAutoReplyEnabled",
  "facebookAutoReplyMessages",
  "facebookAutoReplyMobileReceivedMessage",
  "facebookLeadFromCommentsEnabled",
  "facebookLeadFromDmsEnabled",
  "facebookLeadFromDmsRequiresMobile",
  "generatedLeadAutoAssignmentEnabled",
  "smartReplyFinancingMode",
  "smartReplyDefaultDownPaymentPercent",
  "smartReplyDefaultFinanceCompanyId",
  "smartReplyVisibility",
  "facebookAutoReplyForDmsEnabled",
  "facebookAutoReplyForCommentsEnabled",
  "instagramAutoReplyForDmsEnabled",
  "instagramAutoReplyForCommentsEnabled",
  "facebookSmartReplyForDmsEnabled",
  "facebookSmartReplyForCommentsEnabled",
  "instagramSmartReplyForDmsEnabled",
  "instagramSmartReplyForCommentsEnabled",
  "smartReplyCustomTemplatesEn",
  "smartReplyCustomTemplatesAr",
  // The picker list of Pages (id + name only); the tokens beside it are not here.
  "facebookAvailablePages",
] as const satisfies readonly OrgSettingsField[];

/**
 * Fields that never leave the backend through a public query: the credentials,
 * and the account ids, token expiry times, rotation counters, flags and defaults
 * that only backend code reads. Moving one to the public list is a deliberate
 * change.
 */
export const SERVER_ONLY_ORG_SETTINGS_FIELDS = [
  // Credentials.
  "whatsappApiToken",
  "whatsappWebhookSecret",
  "instagramAccessToken",
  "facebookPageAccessToken",
  "facebookPendingCredentials",
  // Connected-account identifiers and token metadata.
  "whatsappPhoneNumberId",
  "instagramBusinessAccountId",
  "instagramWebhookAccountId",
  "instagramTokenExpiresAt",
  "facebookPageId",
  "facebookConnectedByUserId",
  "facebookTokenExpiresAt",
  // Facebook connection state that only the OAuth and disconnect code reads: when the
  // Owner last disconnected, and which OAuth attempt the pending Pages belong to.
  "facebookDisconnectedAt",
  "facebookPendingAttemptId",
  // Internal state.
  "instagramAutoReplyLastIndex",
  "facebookAutoReplyLastIndex",
  "instagramSmartReplyEnabled",
  "facebookSmartReplyEnabled",
  "smartReplyDefaultLocale",
] as const satisfies readonly OrgSettingsField[];

type PublicField = (typeof PUBLIC_ORG_SETTINGS_FIELDS)[number];
type ServerOnlyField = (typeof SERVER_ONLY_ORG_SETTINGS_FIELDS)[number];

// Each of these is an empty record only while its type is `never`. A schema field
// in neither list, or in both, makes the type non-empty and fails the typecheck,
// and the error names the field.
const everyOrgSettingsFieldIsClassified: Record<Exclude<OrgSettingsField, PublicField | ServerOnlyField>, never> = {};
const noOrgSettingsFieldIsInBothLists: Record<Extract<PublicField, ServerOnlyField>, never> = {};
void everyOrgSettingsFieldIsClassified;
void noOrgSettingsFieldIsInBothLists;

export type PublicOrgSettings = Pick<Doc<"orgSettings">, "_id" | "_creationTime" | PublicField>;

/** The row as a public query may return it: allowlisted fields only. */
export function toPublicOrgSettings(settings: Doc<"orgSettings">): PublicOrgSettings {
  const projected: Record<string, unknown> = {
    _id: settings._id,
    _creationTime: settings._creationTime,
  };
  for (const field of PUBLIC_ORG_SETTINGS_FIELDS) {
    if (settings[field] !== undefined) projected[field] = settings[field];
  }
  return projected as PublicOrgSettings;
}
