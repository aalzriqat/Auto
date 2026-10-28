import { AppErrorCode, throwAppError } from "./errors";

/**
 * SCRUM-560 / SCRUM-760 owner ruling c23812 (2026-10-28), ruling 4: the fixed-asset
 * lifecycle is OFF for the Bloom Cars pilot, "including backend mutations and
 * scheduled posting/derecognition, until independently certified for later
 * activation". The lifecycle is capitalization, update, removal, impairment and
 * disposal of an asset, the monthly depreciation posting, and the minor-unit
 * backfill of legacy asset rows.
 *
 * Why it is off: `impair`/`dispose` skip un-posted depreciation months so their
 * amount lands in gain/loss, and a capitalization queued into a CLOSED period can
 * be LOCKED behind and stay unposted (SCRUM-542, SCRUM-560). The integrity fix is
 * post-pilot work; this switch is the containment until it ships.
 *
 * Gated doors (each calls `assertFixedAssetLifecycleAllowed()` after tenant
 * authorization and BEFORE any read of the asset or any write, so a stored
 * idempotent replay is refused too):
 *   - fixedAssets.capitalize, update, remove, impair, dispose
 *   - accountingMigration.backfillFixedAssetMinorUnits
 * Gated background work (no throw, so a cross-tenant cron batch is never poisoned):
 *   - crons.triggerFixedAssetDepreciation returns before it scans any asset
 *   - fixedAssets.depreciateAssetForMonth returns `lifecycle_disabled` and posts nothing
 *
 * NOT gated, on purpose: the read queries (`fixedAssets.list`, `listEvents`,
 * `listBankOptions`). They write nothing and show an org its own rows. The
 * opening-balance cutover (`accountingCutover.ts`) is NOT gated either: it posts
 * generic opening lines by chart-of-accounts id and never touches the
 * `fixedAssets` table, so a genuine opening asset balance keeps its supported,
 * accountant-approved path.
 *
 * To activate (a reviewed code change plus a manual Convex deploy, never an env
 * var, org setting or database flag; needs the independent certification and a
 * separate owner approval): set the switch to `false` and convert the
 * expected-refusal cells in `convex/fixedAssetLifecycleContainment.scrum560.test.ts`
 * into full-behaviour cells in the same change. Convex re-evaluates cron
 * definitions only at deploy, so this module also decides at run time.
 *
 * LEAF MODULE: imports only `./errors`.
 */
export const FIXED_ASSET_LIFECYCLE_PILOT_DISABLED = true as const;

/** Static text, no amounts or ids. Arabic lives under `ServerError_<code>` in `lib/i18n/domains/common.ts`. */
export const FIXED_ASSET_LIFECYCLE_REFUSALS = {
  FIXED_ASSET_LIFECYCLE_DISABLED:
    "Fixed assets are not available during the pilot. Nothing has been changed.",
} as const satisfies Record<string, string>;

export type FixedAssetLifecycleRefusalCode = keyof typeof FIXED_ASSET_LIFECYCLE_REFUSALS;

export function refuseFixedAssetLifecycle(code: FixedAssetLifecycleRefusalCode): never {
  return throwAppError(AppErrorCode[code], FIXED_ASSET_LIFECYCLE_REFUSALS[code]);
}

/** Refuses any fixed-asset write while the pilot switch is on. `disabled` is for tests of the pure guard only. */
export function assertFixedAssetLifecycleAllowed(
  disabled: boolean = FIXED_ASSET_LIFECYCLE_PILOT_DISABLED
): void {
  if (disabled) refuseFixedAssetLifecycle("FIXED_ASSET_LIFECYCLE_DISABLED");
}

/**
 * Non-throwing form of the switch, for background work that must no-op rather than throw
 * (the monthly depreciation cron) and for any screen that wants to disable a blocked action.
 * The server refusal stays the guarantee.
 */
export function isFixedAssetLifecycleDisabled(
  disabled: boolean = FIXED_ASSET_LIFECYCLE_PILOT_DISABLED
): boolean {
  return disabled;
}
