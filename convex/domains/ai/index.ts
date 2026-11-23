/**
 * AI provider key store and AI draft switches (SCRUM-980).
 *
 * Interface: `sealProviderKey` (action side) and `storeSealedProviderKey`
 * (mutation side) save a provider key; `sealedProviderKeyValidator` and the
 * `SealedProviderKey` type describe the value passed between them.
 * `removeProviderKey` deletes a key. `readAiControlState`, `readOrgAiSettings`,
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
 * Read costs: `isAiDraftEnabledForOrg` is three indexed point reads.
 * `readAiControlState` reads at most 100 enabled dealerships.
 */
export {
  sealProviderKey,
  storeSealedProviderKey,
  sealedProviderKeyValidator,
  type SealedProviderKey,
  removeProviderKey,
} from "./keyStore";
export {
  readAiControlState,
  readOrgAiSettings,
  setMasterSwitch,
  setOrgSwitch,
  isAiDraftEnabledForOrg,
} from "./settings";
