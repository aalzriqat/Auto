// Convex supports arrays of at most 8192 entries. Read one extra row so an
// oversized configuration fails explicitly instead of silently losing choices.
// This read budget includes inactive rows; it is not a new settings write quota.
export const CONFIG_CHOICE_MAX_ROWS = 8192;
