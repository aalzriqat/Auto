import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { chatgpt } from 'e2e/oauth/chatgpt';

// The same test identity the Playwright suite uses (E2E_LOGIN_USER / E2E_LOGIN_PASSWORD).
// Read from .env.local when present; nothing is ever committed.
try {
  process.loadEnvFile('.env.local');
} catch {
  // No .env.local: tests that need the `sales` session fail at sign-in, the rest still run.
}

// Runs against LOCAL Next only, which reads .env.local (dev Convex). Never point APP_URL at a
// Vercel preview: those read the PRODUCTION backend. `pnpm dev` / `convex dev` are deliberately
// not used: they push functions to the shared dev deployment.
export default {
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
        url: process.env.APP_URL ?? 'http://localhost:3000',
        // `node` + Next's own CLI: spawning `pnpm` without a shell fails on Windows (ENOENT).
        command: { executable: 'node', args: ['node_modules/next/dist/bin/next', 'dev'] },
      },
    },
  ],
} satisfies E2EConfig;
