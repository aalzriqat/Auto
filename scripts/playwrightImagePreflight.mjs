import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const expectedVersion = '1.61.1';

/** @param {import('@playwright/test').BrowserType} browserType */
async function probeBrowser(browserType) {
  const browser = await browserType.launch({ timeout: 15_000 });
  try {
    console.log(JSON.stringify({ browser: browserType.name(), version: browser.version(), status: 'LAUNCHED' }));
  } finally {
    await browser.close();
  }
}

/** Refuse package/image drift before loading or launching any browser. */
export async function runPlaywrightImagePreflight() {
  /** @type {unknown} */
  const installed = require('@playwright/test/package.json');
  /** @type {unknown} */
  const image = JSON.parse(await readFile('/ms-playwright/.docker-info', 'utf8'));
  if (typeof installed !== 'object' || !installed || !('version' in installed) ||
      installed.version !== expectedVersion || typeof image !== 'object' || !image ||
      !('driverVersion' in image) || image.driverVersion !== expectedVersion) {
    throw new Error('PLAYWRIGHT_IMAGE_VERSION_MISMATCH');
  }
  const { chromium, webkit } = await import('@playwright/test');
  await probeBrowser(chromium);
  await probeBrowser(webkit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runPlaywrightImagePreflight();
  } catch {
    console.error('PLAYWRIGHT_IMAGE_PREFLIGHT_REFUSED');
    process.exitCode = 1;
  }
}