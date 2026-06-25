#!/usr/bin/env node
/**
 * get_token.js — Refresh CLERK_JWT_TOKEN using a headless Playwright browser.
 *
 * Flow (no email/password needed):
 *   1. Clerk Backend API creates a one-time sign-in ticket for the user.
 *   2. Playwright opens http://localhost:3000 with ?__clerk_ticket=<ticket>.
 *      Clerk's JS SDK (running in the app) exchanges the ticket → issues __session.
 *   3. We extract the __session cookie.
 *   4. Write it to testsprite_tests/.env.test.
 *
 * Requires:
 *   - pnpm dev running (app must be at localhost:3000)
 *   - node testsprite_tests/get_token.js
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const CLERK_API = "https://api.clerk.com/v1";
const USER_ID = "user_3FF8Mj3Gj9AuoUYjQgOlR29TD13"; // dedicated autoflow_qa test account
const APP_URL = "http://localhost:3000";

const REPO_ROOT = path.resolve(__dirname, "..");
const ENV_LOCAL = path.join(REPO_ROOT, ".env.local");
const ENV_TEST = path.join(__dirname, ".env.test");

function readEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

function updateEnvTest(token) {
  let lines = fs.existsSync(ENV_TEST)
    ? fs.readFileSync(ENV_TEST, "utf8").split("\n")
    : [];
  let updated = false;
  lines = lines.map((line) => {
    if (line.startsWith("CLERK_JWT_TOKEN=")) {
      updated = true;
      return `CLERK_JWT_TOKEN=${token}`;
    }
    return line;
  });
  if (!updated) lines.push(`CLERK_JWT_TOKEN=${token}`);
  fs.writeFileSync(ENV_TEST, lines.join("\n") + "\n", "utf8");
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  // 1. Read secret key
  const envLocal = readEnvFile(ENV_LOCAL);
  const secretKey = process.env.CLERK_SECRET_KEY || envLocal.CLERK_SECRET_KEY;
  if (!secretKey) {
    console.error("ERROR: CLERK_SECRET_KEY not found in .env.local");
    process.exit(1);
  }

  // 2. Create a one-time sign-in ticket
  console.log("Creating Clerk sign-in ticket ...");
  const ticketRes = await httpPost(
    `${CLERK_API}/sign_in_tokens`,
    { user_id: USER_ID, expires_in_seconds: 300 },
    { Authorization: `Bearer ${secretKey}` }
  );
  if (ticketRes.status !== 200) {
    console.error("ERROR creating sign-in ticket:", ticketRes.body);
    process.exit(1);
  }
  // Extract just the ticket JWT from the full URL
  const ticketUrl = new URL(ticketRes.body.url);
  const ticket = ticketUrl.searchParams.get("__clerk_ticket");
  console.log("  Ticket obtained.");

  // 3. Launch Playwright browser
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    try { ({ chromium } = require("playwright-core")); }
    catch {
      console.error(
        "ERROR: playwright not installed.\n" +
        "  Run: pnpm add -D playwright && npx playwright install chromium"
      );
      process.exit(1);
    }
  }

  console.log("Launching headless browser → navigating to localhost:3000 ...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Navigate to the sign-in page with the ticket — Clerk exchanges it there
  const targetUrl = `${APP_URL}/sign-in?__clerk_ticket=${ticket}`;
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  } catch (e) {
    await browser.close();
    console.error(
      "ERROR: Could not reach localhost:3000.\n" +
      "  Make sure 'pnpm dev' is running before calling this script."
    );
    process.exit(1);
  }

  // Poll for __session cookie (appears after Clerk exchanges the ticket)
  let sessionCookie = null;
  for (let i = 0; i < 40; i++) {
    const cookies = await context.cookies("http://localhost:3000");
    const found = cookies.find((c) => c.name === "__session" && c.value);
    if (found) { sessionCookie = found.value; break; }
    if (i === 0) process.stdout.write("  Waiting for Clerk to exchange ticket");
    process.stdout.write(".");
    await page.waitForTimeout(500);
  }
  process.stdout.write("\n");

  await browser.close();

  if (!sessionCookie) {
    console.error(
      "ERROR: __session cookie not found after navigating to app.\n" +
      "  The ticket may have expired, or the app is not handling Clerk tickets."
    );
    process.exit(1);
  }

  // 4. Write to .env.test
  updateEnvTest(sessionCookie);
  console.log(`\n[OK] CLERK_JWT_TOKEN updated in ${ENV_TEST}`);
  console.log("     Run your tests now!");
})();
