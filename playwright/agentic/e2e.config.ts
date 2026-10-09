import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { chatgpt } from 'e2e/oauth/chatgpt';

// The same test identity the Playwright suite uses (E2E_LOGIN_USER / E2E_LOGIN_PASSWORD).
// Read from .env.local when present; nothing is ever committed.
try {
  process.loadEnvFile('.env.local');
} catch {
  // The deployment check below fails closed if no dev Convex URL is available.
}

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const appHost = new URL(appUrl).hostname;
if (appHost !== 'localhost' && appHost !== '127.0.0.1') {
  throw new Error('Agentic e2e requires a local app URL.');
}

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  throw new Error('Agentic e2e requires the vibrant-cat-418 dev Convex URL.');
}
const convexHost = new URL(convexUrl).hostname;
if (!/^vibrant-cat-418(?:\.[a-z0-9-]+)?\.convex\.cloud$/.test(convexHost)) {
  throw new Error('Agentic e2e requires the vibrant-cat-418 dev Convex deployment.');
}

const convexSiteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
if (convexSiteUrl) {
  const siteHost = new URL(convexSiteUrl).hostname;
  if (!/^vibrant-cat-418(?:\.[a-z0-9-]+)?\.convex\.site$/.test(siteHost)) {
    throw new Error('Agentic e2e requires the vibrant-cat-418 dev Convex site.');
  }
}

// Runs against LOCAL Next only. Never point APP_URL at a
// Vercel preview: those read the PRODUCTION backend. `pnpm dev` / `convex dev` are deliberately
// not used: they push functions to the shared dev deployment.
export default {
  tests: '*.e2e.ts',
  agents: {
    default: {
      model: chatgpt('gpt-6-luna'),
      system: 'You are a thorough QA agent. Verify every outcome.',
      context:
        'AutoFlow is dealership software. A "cash sale" sells a vehicle for cash through the sales wizard; ' +
        'completing it opens the deal page. The app is in English for these tests.',
    },
  },
  credentials: {
    sales: {
      username: process.env.E2E_LOGIN_USER ?? 'e2e-login-user-not-set@example.test',
      // Read at fill time, so an unset variable only fails the sign-in, not config load.
      password: () => process.env.E2E_LOGIN_PASSWORD ?? '',
    },
  },
  targets: [
    {
      engine: web(),
      app: {
        url: appUrl,
        // `node` + Next's own CLI: spawning `pnpm` without a shell fails on Windows (ENOENT).
        command: {
          cwd: '../..',
          executable: 'node',
          args: ['node_modules/next/dist/bin/next', 'dev'],
          startupTimeout: 120_000,
          log: '.e2e/artifacts/app.log',
          // e2e spawns commands with a filtered environment. Pass the checked URLs through so
          // Next cannot pick a different deployment from .env.local.
          env: {
            NEXT_PUBLIC_CONVEX_URL: convexUrl,
            ...(convexSiteUrl ? { NEXT_PUBLIC_CONVEX_SITE_URL: convexSiteUrl } : {}),
          },
        },
      },
    },
  ],
} satisfies E2EConfig;
