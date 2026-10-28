/**
 * Test-only handle on the SCRUM-760 ruling 11 legacy collection REFUND switch
 * (convex/utils/legacyCollectionRefundContainment.ts).
 *
 * Production reads a `true as const` constant; nothing a client sends reaches it. A test file that
 * must drive the blocked refund door with the pilot block off (to exercise the behaviour that returns
 * when the door is activated, or because it uses an approved refund only as a FIXTURE) mocks the
 * module through this helper, so every such file is greppable for
 * `withLegacyCollectionRefundSwitch` / `openLegacyCollectionRefund`:
 *
 *   vi.mock("./utils/legacyCollectionRefundContainment", async (importOriginal) =>
 *     (await import("../test-utils/legacyCollectionRefundSwitches")).openLegacyCollectionRefund(await importOriginal()));
 *
 * The census in convex/legacyCollectionRefundContainment.test.ts allows only the files listed there.
 * The shipped value is pinned unmocked in that same file.
 */
type Original = typeof import("../convex/utils/legacyCollectionRefundContainment");

export type LegacyCollectionRefundSwitchState = {
  /** `true` = the pilot block is ON (the shipped state). */
  legacyCollectionRefund: boolean;
};

/** The door open: for files that test the deferred behaviour itself. */
export const LEGACY_COLLECTION_REFUND_OPEN: LegacyCollectionRefundSwitchState = {
  legacyCollectionRefund: false,
};

export function withLegacyCollectionRefundSwitch(
  original: Original,
  state: LegacyCollectionRefundSwitchState
): Original {
  // While the state is ON (the shipped state) the real guard runs with its own default, so the REAL
  // constant still decides. Flipping that constant in source therefore turns the expected-refusal
  // cells red. Only an explicit OFF state overrides the constant.
  return {
    ...original,
    isLegacyCollectionRefundDisabled: () =>
      state.legacyCollectionRefund && original.isLegacyCollectionRefundDisabled(),
    assertLegacyCollectionRefundAllowed: () =>
      state.legacyCollectionRefund
        ? original.assertLegacyCollectionRefundAllowed()
        : original.assertLegacyCollectionRefundAllowed(false),
  };
}

/** The door open, for suites that exercise (or use as a fixture) the deferred collection refund itself. */
export function openLegacyCollectionRefund(original: object): Original {
  return withLegacyCollectionRefundSwitch(original as Original, LEGACY_COLLECTION_REFUND_OPEN);
}
