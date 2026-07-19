// Visible OTA build counter. It is surfaced in two low-key places so you can
// confirm on-device that an over-the-air `eas update` actually landed, WITHOUT
// the old full-width red banner that made production/preview builds look
// unfinished:
//   1. A subtle "OTA #N · dev" pill on the home screen, shown only when __DEV__.
//   2. A subtle "AutoFlow · Build N" line in the account sheet (all builds).
//
// WORKFLOW: bump this by 1 EVERY time you publish a new `eas update`
// (e.g. `eas update --branch preview`). It's pure JS, so it ships over the air
// with that same update — no native rebuild, no cable. When the number in the
// account sheet changes to match, the OTA update has taken effect.
export const OTA_UPDATE_NUMBER = 11;
