import http from "k6/http";
import { check, sleep } from "k6";

const defaultHeaders = {
  "User-Agent": "autoflow-k6-load-test/1.0",
};

export function normalizeBaseUrl(value, name) {
  const rawValue = value || "";
  if (!rawValue) {
    throw new Error(`Set ${name} before running this load test.`);
  }

  if (!/^https?:\/\/[^/]+/.test(rawValue)) {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  return rawValue.replace(/\/+$/, "");
}

export function buildHeaders() {
  const headers = { ...defaultHeaders };
  const authHeader = __ENV.AUTH_HEADER || "";
  const authCookie = __ENV.AUTH_COOKIE || "";

  if (authHeader) headers.Authorization = authHeader;
  if (authCookie) headers.Cookie = authCookie;

  return headers;
}

export function requireAuthenticatedContext() {
  const orgId = __ENV.ORG_ID || "";
  const hasAuth = Boolean(__ENV.AUTH_COOKIE || __ENV.AUTH_HEADER);

  if (!orgId) {
    throw new Error("Set ORG_ID to the staging or test organization id for authenticated load tests.");
  }

  if (!hasAuth) {
    throw new Error("Set AUTH_COOKIE or AUTH_HEADER from a dedicated Clerk test user session.");
  }

  return orgId;
}

export function pickPath(paths) {
  return paths[Math.floor(Math.random() * paths.length)];
}

export function requestPath(baseUrl, path, headers, tags) {
  const response = http.get(`${baseUrl}${path}`, {
    headers,
    redirects: Number(__ENV.MAX_REDIRECTS || "2"),
    tags,
  });

  check(response, {
    "status is below 500": (res) => res.status < 500,
  });

  return response;
}

export function requestConvexHealth() {
  const convexSiteUrl = (__ENV.CONVEX_SITE_URL || "").replace(/\/+$/, "");
  const loadTestSecret = __ENV.LOAD_TEST_SECRET || "";
  if (!convexSiteUrl || !loadTestSecret) return;

  const response = http.get(`${convexSiteUrl}/load-test/health`, {
    headers: {
      ...defaultHeaders,
      "x-load-test-secret": loadTestSecret,
    },
    tags: {
      surface: "convex",
      route: "/load-test/health",
    },
  });

  check(response, {
    "convex probe is ok": (res) => res.status === 200,
  });
}

export function pauseBetweenRequests() {
  const minSleep = Number(__ENV.MIN_SLEEP_SECONDS || "1");
  const maxSleep = Number(__ENV.MAX_SLEEP_SECONDS || "4");
  const spread = Math.max(maxSleep - minSleep, 0);
  sleep(minSleep + Math.random() * spread);
}
