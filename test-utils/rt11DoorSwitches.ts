/** Historical lifecycle tests only; never imported by shipped-state RT11 tests. */
type Original = typeof import("../convex/utils/rt11DoorContainment");

export function openRt11Doors(original: Original): Original {
  return {
    ...original,
    assertRt11DoorAllowed: () => undefined,
    isRt11DoorDisabled: () => false,
  };
}
