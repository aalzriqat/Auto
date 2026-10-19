/**
 * Test-only handle on the SCRUM-760 cleared-cheque return switch
 * (convex/utils/postDeliveryDoorContainment.ts).
 *
 * Production reads a `true as const` constant; nothing a client sends reaches
 * it. A test file that must drive the blocked door with the pilot block off (to
 * exercise the behaviour that returns when the door is activated) mocks the
 * module through this helper, so every such file is greppable for
 * `withPostDeliverySwitches` / `openPostDeliveryDoors`:
 *
 *   vi.mock("./utils/postDeliveryDoorContainment", async (importOriginal) =>
 *     (await import("../test-utils/postDeliveryDoorSwitches")).openPostDeliveryDoors(await importOriginal()));
 *
 * The shipped value is pinned unmocked in convex/postDeliveryDoorContainment.test.ts.
 */
type Original = typeof import("../convex/utils/postDeliveryDoorContainment");

export type PostDeliverySwitchState = {
  /** `true` = the pilot block is ON (the shipped state). */
  clearedChequeReturn: boolean;
  financeChequeReturn: boolean;
};

/** The door open: for files that test the deferred behaviour itself. */
export const PILOT_DOORS_OPEN: PostDeliverySwitchState = {
  clearedChequeReturn: false,
  financeChequeReturn: false,
};

export function withPostDeliverySwitches(original: Original, state: PostDeliverySwitchState): Original {
  // While the state is ON (the shipped state) the real guard runs with its own default, so the REAL
  // constant still decides. Flipping that constant in source therefore turns the expected-refusal
  // cells red. Only an explicit OFF state overrides the constant.
  return {
    ...original,
    isClearedChequeReturnDisabled: () => state.clearedChequeReturn && original.isClearedChequeReturnDisabled(),
    isFinanceChequeReturnDisabled: () => state.financeChequeReturn && original.isFinanceChequeReturnDisabled(),
    assertFinanceChequeReturnAllowed: () =>
      state.financeChequeReturn
        ? original.assertFinanceChequeReturnAllowed()
        : original.assertFinanceChequeReturnAllowed(false),
    assertClearedChequeReturnAllowed: () =>
      state.clearedChequeReturn
        ? original.assertClearedChequeReturnAllowed()
        : original.assertClearedChequeReturnAllowed(false),
  };
}

/** The door open, for suites that exercise the deferred cleared-cheque return itself. */
export function openPostDeliveryDoors(original: object): Original {
  return withPostDeliverySwitches(original as Original, PILOT_DOORS_OPEN);
}
