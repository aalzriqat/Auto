# AutoFlow k6 Load Tests

These scripts are for controlled staging load tests. Do not run the 1,000-user
test against production unless the Vercel, Convex, Clerk, and database impact is
approved first.

## What This Covers

- Vercel / Next.js public pages and API routes.
- Clerk middleware and authenticated page rendering when a test session cookie
  or authorization header is provided.
- Convex HTTP availability through the protected `/load-test/health` endpoint.

k6 is HTTP-level by default. These scripts do not execute browser JavaScript,
so they do not fully simulate Convex React subscriptions or every client-side
interaction. Use them to measure server/API capacity, then add browser tests for
frontend interaction timing if needed.

## Setup

Install k6 from https://grafana.com/docs/k6/latest/set-up/install-k6/.

Set a Convex probe secret in the target Convex deployment:

```bash
npx convex env set LOAD_TEST_SECRET "<long-random-secret>"
```

Required for all runs:

```bash
BASE_URL="https://your-staging-vercel-url"
```

Optional:

```bash
CONVEX_SITE_URL="https://your-convex-site-url"
LOAD_TEST_SECRET="<same-long-random-secret>"
ORG_ID="<test-organization-id>"
AUTH_COOKIE="__session=..."
AUTH_HEADER="Bearer ..."
```

Use either `AUTH_COOKIE` or `AUTH_HEADER` for authenticated routes. Prefer a
dedicated Clerk test user in a staging organization with read-only test data.

To copy `AUTH_COOKIE`, sign in as the test user, open browser DevTools on
`autoflowdealer.com`, copy the full request `Cookie` header from a dashboard
page request, and set it as `AUTH_COOKIE`. It should include Clerk session
cookies for that domain.

## Commands

Smoke test:

```bash
BASE_URL="https://your-staging-vercel-url" pnpm load:smoke
```

PowerShell:

```powershell
$env:BASE_URL = "https://your-staging-vercel-url"
pnpm load:smoke
```

Authenticated smoke test:

```bash
BASE_URL="https://your-staging-vercel-url" \
CONVEX_SITE_URL="https://your-convex-site-url" \
LOAD_TEST_SECRET="<same-long-random-secret>" \
ORG_ID="<test-organization-id>" \
AUTH_COOKIE="__session=..." \
pnpm load:auth-smoke
```

PowerShell:

```powershell
$env:BASE_URL = "https://your-staging-vercel-url"
$env:CONVEX_SITE_URL = "https://your-convex-site-url"
$env:LOAD_TEST_SECRET = "<same-long-random-secret>"
$env:ORG_ID = "<test-organization-id>"
$env:AUTH_COOKIE = "__session=..."
pnpm load:auth-smoke
```

1,000-user ramp:

```bash
BASE_URL="https://your-staging-vercel-url" \
CONVEX_SITE_URL="https://your-convex-site-url" \
LOAD_TEST_SECRET="<same-long-random-secret>" \
ORG_ID="<test-organization-id>" \
AUTH_COOKIE="__session=..." \
CONFIRM_1000_USER_TEST=yes \
pnpm load:1000
```

PowerShell:

```powershell
$env:BASE_URL = "https://your-staging-vercel-url"
$env:CONVEX_SITE_URL = "https://your-convex-site-url"
$env:LOAD_TEST_SECRET = "<same-long-random-secret>"
$env:ORG_ID = "<test-organization-id>"
$env:AUTH_COOKIE = "__session=..."
$env:CONFIRM_1000_USER_TEST = "yes"
pnpm load:1000
```

## Safety Notes

- Run the smoke test first.
- Run the authenticated smoke test before the 1,000-user ramp.
- Use staging data and a staging Clerk instance when possible.
- Do not point the scripts at webhook URLs or production social integrations.
- Watch Vercel, Convex, Clerk, and Sentry dashboards during the run.
- Stop immediately if error rates, latency, or provider rate limits spike.
