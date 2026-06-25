import {
  buildHeaders,
  normalizeBaseUrl,
  pauseBetweenRequests,
  pickPath,
  requireAuthenticatedContext,
  requestConvexHealth,
  requestPath,
} from "./helpers.js";

const baseUrl = normalizeBaseUrl(__ENV.BASE_URL, "BASE_URL");
const orgId = requireAuthenticatedContext();
const headers = buildHeaders();

const authenticatedPaths = [
  `/${orgId}/dashboard`,
  `/${orgId}/vehicles`,
  `/${orgId}/leads`,
  `/${orgId}/customers`,
  `/${orgId}/social-inbox`,
  `/${orgId}/messages`,
  `/${orgId}/reports`,
  `/${orgId}/settings/integrations`,
];

export const options = {
  vus: Number(__ENV.AUTH_SMOKE_VUS || "5"),
  duration: __ENV.AUTH_SMOKE_DURATION || "1m",
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2500", "p(99)<6000"],
  },
};

export default function authenticatedSmokeScenario() {
  requestPath(baseUrl, pickPath(authenticatedPaths), headers, {
    surface: "clerk",
    route_group: "authenticated",
  });

  requestConvexHealth();
  pauseBetweenRequests();
}
