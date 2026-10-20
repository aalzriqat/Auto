# How to test a change in a real browser without touching production

Use this when a change needs a real-browser check. Production (`clever-mockingbird-719`) is never a test target. The cloud sessions cannot run the app themselves, because their network policy blocks Convex and Clerk.

## Run the browser suite on a throwaway backend

1. Merge the change to `main`. CI never deploys branch code with secrets, so only `main` is tested this way.
2. In GitHub, open Actions, choose **Trusted Main E2E (Playwright)**, and select **Run workflow** on `main`. The workflow must be enabled. It was disabled on 2026-10-16.
3. The workflow creates a disposable Convex preview with `CONVEX_PREVIEW_DEPLOY_KEY`, seeds the QA dealership, runs `pnpm exec playwright test`, and deletes the preview. The preview key cannot address production.
4. Open the run and download the `trusted-main-playwright-report` artifact. Each screenshot a spec attaches is in the HTML report.

The Deal Scenarios E2E workflow (`deal-scenarios-e2e.yml`) runs the ledger-checked scenarios the same way. It takes about 45 minutes.

## Add a check for a new change

Put a spec in `playwright/tests/`, drive the screens an operator uses, and attach screenshots with `testInfo.attach`. `playwright/tests/pilot-commissions-cash.spec.ts` is an example. It covers cash pay-first (SCRUM-802) and deal commissions (SCRUM-783).

## Limits

- Previews on Vercel have no Convex backend (SCRUM-767), so they are not a test target.
- Cloud sessions cannot download the report artifact, because the artifact host is blocked. Read the run summary there and open the report yourself.
- Code that is not on `main` cannot be browser-tested with CI secrets. Its proof is its unit test until it merges.
