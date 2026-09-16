# TASK-ACC-05: Collections / Cash Drawer actions shown without permission

## Severity: P1 High

## Problem Statement
Money-moving buttons in `CollectionsTab.tsx` and `CashDrawerPanel.tsx` were rendered to users whose role lacked the required permissions (e.g. `MANAGE_FINANCE` or cashier roles). While the backend refused unauthorized mutations, rendering the buttons invited forbidden attempts and caused confusing error alerts.

## Failing-First Test
- UI Test: Assert that users lacking `canManage` or `MANAGE_FINANCE` do not see actionable cash movement, deposit, or drawer transition buttons.

## Implementation Details
1. `CollectionsTab.tsx`: Checked `canManage` permission before rendering mutation buttons.
2. `CashDrawerPanel.tsx`: Aligned drawer actions (open, close, adjust, drop) with backend role permissions and confirmation dialogs.

## Verification Evidence
- Verified in `components/accounting/CollectionsTab.tsx` and `components/accounting/collections/CashDrawerPanel.tsx`:
  - `CollectionsTab.tsx` lines 397-402: Cheque actions (deposit, clear, return, replace) are strictly gated by `{canManage && ...}`.
  - `CashDrawerPanel.tsx` lines 77-82: Open Cash Drawer is strictly gated by `{canManage && ...}`.
  - `CashDrawerPanel.tsx` lines 110-116: Action buttons (Record, BeginCount, Close) require `canManage`; Approve requires `canApprove`.
  - Permissions are re-checked and enforced on the backend mutations (`PERMISSIONS.MANAGE_FINANCE`, `PERMISSIONS.APPROVE_REQUESTS`).
- Status: **VERIFIED & CLOSED**.
