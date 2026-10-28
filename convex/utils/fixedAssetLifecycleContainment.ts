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
 * Gated queued work (the accounting outbox, `accountingOutbox.ts`): a fixed-asset posting
 * queued BEFORE the switch shipped must not post afterwards either. Every route that wakes
 * a queued row (the every-minute `dispatch-outbox-work` cron, a period open or reopen,
 * chart initialisation, `accountingOutbox.redrive`) ends in `postOutboxRow`, which asks
 * `fixedAssetPostingRefusal` for every POST row before the period hold and dead-letters
 * the row through `failOutboxRow` (not a hold: a held row would sit PENDING for ever and
 * block period close, the SCRUM-234 shape; the same disposition SCRUM-782 / PR #694 uses
 * for a refused queued consigned-VAT event). `retryFailed` and the prepaid redrive revive
 * through `reviveFailedEntry`, which refuses such a row via `isOutboxRowRevivable`, and the
 * failed-events list reports it as not retryable. REVERSE rows are exempt, as for every
 * other refusal there: a reversal unwinds something that already posted.
 *
 * NOT gated, on purpose: the read queries (`fixedAssets.list`, `listEvents`,
 * `listBankOptions`). They write nothing and show an org its own rows. The
 * opening-balance cutover (`accountingCutover.ts`) is NOT gated either: it never touches
 * the `fixedAssets` table, and it cannot write a fixed-asset balance in any case,
 * because `openingAccountPolicy.ts` classes the FIXED_ASSETS and ACCUMULATED_DEPRECIATION
 * system accounts as UNSUPPORTED for opening balances and the opening writer
 * (`accounting/openingAllocations.ts`) refuses an UNSUPPORTED account. So no supported
 * opening-balance path for fixed assets exists to protect or to omit.
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

/** The four accounting event types the fixed-asset lifecycle posts. */
const FIXED_ASSET_EVENT_TYPES: ReadonlySet<string> = new Set([
  "ASSET_CAPITALIZED",
  "DEPRECIATION_POSTED",
  "ASSET_IMPAIRED",
  "ASSET_DISPOSED",
]);

/** The `sourceType` every fixed-asset event is queued under (`postFixedAssetEvent`). */
const FIXED_ASSET_SOURCE_TYPE = "fixedAssets";

/**
 * Why a QUEUED forward posting may not post, or `null`. A fixed-asset posting is recognised by
 * its source or by any of its four event types. Pure and non-throwing: the outbox worker returns
 * the text through `failOutboxRow`. Callers apply it to POST rows only. Static text, no ids.
 */
export function fixedAssetPostingRefusal(
  cmd: { eventType: string; sourceType: string },
  disabled: boolean = FIXED_ASSET_LIFECYCLE_PILOT_DISABLED
): string | null {
  if (!disabled) return null;
  if (cmd.sourceType !== FIXED_ASSET_SOURCE_TYPE && !FIXED_ASSET_EVENT_TYPES.has(cmd.eventType)) {
    return null;
  }
  return (
    "Fixed-asset postings are off during the pilot, so this queued posting cannot post. " +
    "Nothing has been changed."
  );
}
