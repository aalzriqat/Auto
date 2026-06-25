import {
  buildHeaders,
  normalizeBaseUrl,
  pauseBetweenRequests,
  pickPath,
  requestConvexHealth,
  requestPath,
} from "./helpers.js";

const baseUrl = normalizeBaseUrl(__ENV.BASE_URL, "BASE_URL");
const orgId = __ENV.ORG_ID || "";
const headers = buildHeaders();

const publicPaths = [
  "/",
  "/contact",
  "/privacy",
  "/terms",
  "/api/health",
];

const authenticatedPaths = orgId
  ? [
      `/${orgId}/dashboard`,
      `/${orgId}/vehicles`,
      `/${orgId}/leads`,
      `/${orgId}/social-inbox`,
      `/${orgId}/messages`,
      `/${orgId}/settings/integrations`,
    ]
  : [];

export const options = {
  vus: Number(__ENV.SMOKE_VUS || "5"),
  duration: __ENV.SMOKE_DURATION || "1m",
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2000", "p(99)<5000"],
  },
};

export default function smokeScenario() {
  requestPath(baseUrl, pickPath(publicPaths), headers, {
    surface: "vercel",
    route_group: "public",
  });

  if (authenticatedPaths.length > 0 && (__ENV.AUTH_COOKIE || __ENV.AUTH_HEADER)) {
    requestPath(baseUrl, pickPath(authenticatedPaths), headers, {
      surface: "clerk",
      route_group: "authenticated",
    });
  }

  requestConvexHealth();
  pauseBetweenRequests();
}
