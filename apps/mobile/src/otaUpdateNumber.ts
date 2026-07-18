// Visible OTA build counter, rendered in the red banner on the home screen so
// you can confirm on-device that an over-the-air `eas update` actually landed.
//
// WORKFLOW: bump this by 1 EVERY time you publish a new `eas update`
// (e.g. `eas update --branch preview`). It's pure JS, so it ships over the air
// with that same update — no native rebuild, no cable. When the number on the
// phone changes to match, the OTA update has taken effect.
export const OTA_UPDATE_NUMBER = 7;
