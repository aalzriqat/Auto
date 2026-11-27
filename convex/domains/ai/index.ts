/**
 * AI provider key store and AI draft switches (SCRUM-980).
 *
 * Interface: `sealProviderKey` (action side, takes the untrusted request as
 * `unknown` and parses it by hand, because Convex prints the whole argument
 * object, key included, when argument validation fails) and
 * `storeSealedProviderKey` (mutation side) save a provider key; `sealedProviderKeyValidator` and the
 * `SealedProviderKey` type describe the value passed between them.
 * `removeProviderKey` deletes a key. `providerKeyStatusValidator` and the
 * `ProviderKeyStatus` type describe the client-safe status of a key: a `set`
 * variant with `last4` and `setAt`, or an `unset` variant. `readAiControlState`, `readOrgAiSettings`,
 * `setMasterSwitch`, `setOrgSwitch` and `isAiDraftEnabledForOrg` cover the
 * platform and per-dealership switches.
 *
 * Invariants: the plaintext key exists only in an action's memory and is never
 * a persisted function argument. No query returns ciphertext or IV. Every key
 * change is audited with the last four characters only. Saving fails closed
 * when the master key is missing or malformed.
 *
 * Error modes (fixed text, never echo the input): AI_KEY_FORMAT_INVALID,
 * AI_KEY_ENCRYPTION_NOT_CONFIGURED, AI_KEY_SAVE_FAILED.
 *
 * Configuration: env `AI_KEY_ENCRYPTION_KEY`, the base64 of 32 random bytes.
 *
 * Read costs: `isAiDraftEnabledForOrg` is three bounded reads: `.first()` on the
 * one-row platform switch table (no index), then the dealership switch and the
 * provider key row, each through an index.
 * `readAiControlState` reads at most 101 enabled dealerships (100 listed, the
 * extra row sets `truncated`).
 */
export {
  sealProviderKey,
  storeSealedProviderKey,
  sealedProviderKeyValidator,
  type SealedProviderKey,
  providerKeyStatusValidator,
  type ProviderKeyStatus,
  removeProviderKey,
  readSealedProviderKey,
} from "./keyStore";
export {
  readAiControlState,
  readOrgAiSettings,
  setMasterSwitch,
  setOrgSwitch,
  isAiDraftEnabledForOrg,
} from "./settings";
export { runGenerateDraft, testProviderConnection } from "./draftLifecycle";
export {
  DRAFT_EXPIRY_MS,
  completePendingDraft,
  expirePendingDraft,
  readDraftForStaff,
  requestDraftForStaff,
} from "./draftRequest";
export { loadDraftJobData } from "./draftJob";
export { dmSendArgs, linkReplyDraft, requireSendAccess } from "./draftSendLink";
export {
  draftJobValidator,
  draftOutcomeValidator,
  draftViewValidator,
} from "./draftValidators";
export { connectionTestResultValidator } from "./provider";
