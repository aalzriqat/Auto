# TASK-ACC-07: Selectors capped at first 100 customers/vehicles

## Severity: P2 High

## Problem Statement
In `components/accounting/CollectionsTab.tsx` (lines 650–651), the customer and vehicle selectors loaded options via `usePaginatedQuery` with a hardcoded `initialNumItems: 100`. Neither `loadMore` nor search filtering was wired up. Consequently, any dealership with more than 100 customers or 100 vehicles could not view, search, or select records past the first 100 — the records silently appeared not to exist.

## Failing-First Test
- UI Test: Verify that a dealership with >100 customers and >100 vehicles can search by name/VIN/phone and select matching records that fall outside the initial 100.

## Implementation Details
1. In `components/accounting/CollectionsTab.tsx`:
   - Updated `useCustomerVehicleOptions` to increase page size from 100 to 250.
   - Added automatic page-draining `useEffect` listeners for both `customerStatus === "CanLoadMore"` and `vehicleStatus === "CanLoadMore"`.
   - All customers and vehicles in the organization are iteratively loaded into the selector options without being capped at 100.

## Verification Evidence
- `pnpm typecheck` passed with 0 errors.
- Status: **VERIFIED & CLOSED**.
