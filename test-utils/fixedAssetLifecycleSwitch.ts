/**
 * Test-only handle on the SCRUM-560 / SCRUM-760 fixed-asset lifecycle switch
 * (convex/utils/fixedAssetLifecycleContainment.ts).
 *
 * Production reads a `true as const` constant; nothing a client sends reaches it. A test file
 * that must drive the blocked lifecycle with the pilot block off (to exercise the behaviour that
 * returns when the lifecycle is activated) mocks the module through this helper, so every such
 * file is greppable for `withFixedAssetLifecycleSwitch` / `openFixedAssetLifecycle`:
 *
 *   vi.mock("./utils/fixedAssetLifecycleContainment", async (importOriginal) =>
 *     (await import("../test-utils/fixedAssetLifecycleSwitch")).openFixedAssetLifecycle(await importOriginal()));
 *
 * The shipped value is pinned unmocked in convex/fixedAssetLifecycleContainment.scrum560.test.ts.
 */
type Original = typeof import("../convex/utils/fixedAssetLifecycleContainment");

export type FixedAssetLifecycleSwitchState = {
  /** `true` = the pilot block is ON (the shipped state). */
  lifecycleDisabled: boolean;
};

/** The lifecycle open: for files that test the deferred behaviour itself. */
export const FIXED_ASSET_LIFECYCLE_OPEN: FixedAssetLifecycleSwitchState = {
  lifecycleDisabled: false,
};

export function withFixedAssetLifecycleSwitch(
  original: Original,
  state: FixedAssetLifecycleSwitchState
): Original {
  // While the state is ON (the shipped state) the real guard runs with its own default, so the REAL
  // constant still decides. Flipping that constant in source therefore turns the expected-refusal
  // cells red. Only an explicit OFF state overrides the constant.
  return {
    ...original,
    isFixedAssetLifecycleDisabled: () =>
      state.lifecycleDisabled && original.isFixedAssetLifecycleDisabled(),
    assertFixedAssetLifecycleAllowed: () =>
      state.lifecycleDisabled
        ? original.assertFixedAssetLifecycleAllowed()
        : original.assertFixedAssetLifecycleAllowed(false),
  };
}

/** The lifecycle open, for suites that exercise the deferred fixed-asset behaviour itself. */
export function openFixedAssetLifecycle(original: object): Original {
  return withFixedAssetLifecycleSwitch(original as Original, FIXED_ASSET_LIFECYCLE_OPEN);
}
