import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextFetchEvent, NextRequest } from "next/server";
import {
  decideOfflineSwarmClerk,
  offlineSwarmClerkOptions,
} from "@/lib/offlineSwarmClerk";
import {
  dealerManifestResponse,
  emptyAnalyticsScriptResponse,
  VERCEL_ANALYTICS_SCRIPT_PATH,
} from "@/lib/dealerAssets";
import { isDealerWebsiteHost, normalizedHost } from "@/lib/dealerHost";

const isPublicRoute = createRouteMatcher([
  "/",
  "/dealer-site(.*)",
  "/marketplace(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/privacy",
  "/terms",
  "/contact",
  // SCRUM-842: the status URL Meta's data-deletion callback hands to the end user.
  "/data-deletion-status",
  "/manifest.webmanifest",
  "/api/health",
  "/clerk-webhook",
]);

function isDealerWebsiteRequest(req: Request): boolean {
  return isDealerWebsiteHost(req.headers.get("host"));
}

const clerkProxy = clerkMiddleware(
  async (auth, req) => {
    if (isDealerWebsiteRequest(req)) {
      const host = normalizedHost(req.headers.get("host"));

      if (req.nextUrl.pathname === "/manifest.webmanifest") {
        return dealerManifestResponse();
      }

      if (VERCEL_ANALYTICS_SCRIPT_PATH.test(req.nextUrl.pathname)) {
        return emptyAnalyticsScriptResponse();
      }

      const url = req.nextUrl.clone();
      const originalPath = url.pathname === "/" ? "" : url.pathname;
      url.pathname = `/dealer-site${originalPath}`;
      url.searchParams.set("host", host);
      return NextResponse.rewrite(url);
    }

    if (VERCEL_ANALYTICS_SCRIPT_PATH.test(req.nextUrl.pathname)) {
      return NextResponse.next();
    }

    if (!isPublicRoute(req)) {
      await auth.protect();
    }
  },
  // SCRUM-350 G4: per-request options. `{}` (identical to passing none) unless
  // the trusted browser swarm's offline mode is fully and exactly requested, in
  // which case Clerk verifies sessions networklessly with the PUBLIC jwtKey.
  () => offlineSwarmClerkOptions(decideOfflineSwarmClerk(process.env)),
);

/**
 * Fail closed: if the offline swarm flag is set but any of its conditions
 * fails, answer 503 to everything this proxy handles, so no page is ever
 * served as authenticated and the swarm run fails loudly instead of testing a
 * degraded app. Without the flag this is a pass-through to Clerk.
 */
export default function proxy(req: NextRequest, event: NextFetchEvent) {
  const decision = decideOfflineSwarmClerk(process.env);
  if (decision.mode === "refused") {
    console.error(
      "Offline swarm Clerk mode refused: " + decision.reasons.join("; "),
    );
    return new NextResponse("Offline swarm Clerk configuration refused.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  return clerkProxy(req, event);
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!api/health(?:/|$)|_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/manifest.webmanifest",
    "/:analyticsId([a-f0-9]{16,})/script.js",
    // Always run for API routes except the public process-health endpoint.
    // Health must remain observable even when Clerk itself is unavailable.
    "/(api(?!/health(?:/|$))|trpc)(.*)",
  ],
};
