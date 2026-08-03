/**
 * Geometry of the floating messenger FAB, in its own module so screens can
 * reserve space for it without importing the component (and with it Convex, the
 * messages module, and half the workspace tree).
 *
 * The FAB is absolutely positioned over whatever screen is mounted. Any
 * scrollable screen underneath has to pad its content by at least
 * `FAB_SIZE + <the FAB's offset above the tab bar>` or its last control ends up
 * unreachable beneath it.
 */
export const FAB_SIZE = 58;
