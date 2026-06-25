import {
  buildHeaders,
  normalizeBaseUrl,
  pauseBetweenRequests,
  pickPath,
  requireAuthenticatedContext,
  requestConvexHealth,
  requestPath,
} from "./helpers.js";

if (__ENV.CONFIRM_1000_USER_TEST !== "yes") {
  throw new Error("Set CONFIRM_1000_USER_TEST=yes to run the 1,000-user load test.");
}

const baseUrl = normalizeBaseUrl(__ENV.BASE_URL, "BASE_URL");
const orgId =
  __ENV.ALLOW_PUBLIC_ONLY_TEST === "yes" ? __ENV.ORG_ID || "" : requireAuthenticatedContext();
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
      `/${orgId}/customers`,
      `/${orgId}/social-inbox`,
      `/${orgId}/messages`,
      `/${orgId}/reports`,
      `/${orgId}/settings/integrations`,
    ]
  : [];

export const options = {
  scenarios: {
    autoflow_read_path: {
      executor: "ramping-vus",
      gracefulRampDown: "2m",
      stages: [
        { duration: __ENV.RAMP_TO_100_DURATION || "5m", target: 100 },
        { duration: __ENV.RAMP_TO_500_DURATION || "10m", target: 500 },
        { duration: __ENV.RAMP_TO_1000_DURATION || "10m", target: 1000 },
        { duration: __ENV.HOLD_1000_DURATION || "10m", target: 1000 },
        { duration: __ENV.RAMP_DOWN_DURATION || "5m", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.03"],
    http_req_duration: ["p(95)<2500", "p(99)<6000"],
  },
};

export default function thousandUserScenario() {
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
