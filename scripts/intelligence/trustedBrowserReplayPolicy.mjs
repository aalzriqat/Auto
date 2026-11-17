export const EXPLORER_SPEC = "playwright/scenarios/jev-explorer.spec.ts";

// Only these fields of a trusted authenticated suite receipt are replay claims.
export const TRUSTED_REPLAY_BINDINGS = Object.freeze({
  browserReplay: { id: "g8-owned-cash-delivery-screen", definition: "sales.spec.ts" },
  financedReplay: { id: "g8-owned-financed-delivery-screen", definition: "financed-deal-economics.spec.ts" },
  supplierArabicReplay: { id: "supplier-p7-browser-ar", definition: "supplier-identity.spec.ts" },
  supplierEnglishReplay: { id: "supplier-p7-browser-en", definition: "supplier-identity.spec.ts" },
});

export function isTrustedReplayBinding(record) {
  const file = record?.impl?.file;
  return file === EXPLORER_SPEC || Object.values(TRUSTED_REPLAY_BINDINGS).some(binding =>
    binding.id === record?.id && file === `playwright/tests/${binding.definition}`);
}
