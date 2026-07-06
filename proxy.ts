import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  dealerManifestResponse,
  emptyAnalyticsScriptResponse,
  VERCEL_ANALYTICS_SCRIPT_PATH,
} from "@/lib/dealerAssets";
import { isDealerWebsiteHost, normalizedHost } from "@/lib/dealerHost";

const isPublicRoute = createRouteMatcher([
  "/",
  "/dealer-site(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/privacy",
  "/terms",
  "/contact",
  "/manifest.webmanifest",
  "/api/health",
  "/clerk-webhook",
]);

function isDealerWebsiteRequest(req: Request): boolean {
  return isDealerWebsiteHost(req.headers.get("host"));
}

export default clerkMiddleware(async (auth, req) => {
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
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/manifest.webmanifest",
    "/:analyticsId([a-f0-9]{16,})/script.js",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
