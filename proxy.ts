import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
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

const VERCEL_ANALYTICS_SCRIPT_PATH = /^\/[a-f0-9]{16,}\/script\.js$/i;

function isDealerWebsiteRequest(req: Request): boolean {
  return isDealerWebsiteHost(req.headers.get("host"));
}

function dealerManifest(): Response {
  return NextResponse.json(
    {
      name: "AutoFlow Dealer Website",
      short_name: "Dealer Website",
      description: "Browse this dealership's vehicles, offers, and contact options.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#111827",
      icons: [
        {
          src: "/icon.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any",
        },
        {
          src: "/icon-maskable.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
        "Content-Type": "application/manifest+json; charset=utf-8",
      },
    },
  );
}

function emptyAnalyticsScript(): Response {
  return new NextResponse("", {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/javascript; charset=utf-8",
    },
  });
}

export default clerkMiddleware(async (auth, req) => {
  if (isDealerWebsiteRequest(req)) {
    const host = normalizedHost(req.headers.get("host"));

    if (req.nextUrl.pathname === "/manifest.webmanifest") {
      return dealerManifest();
    }

    if (VERCEL_ANALYTICS_SCRIPT_PATH.test(req.nextUrl.pathname)) {
      return emptyAnalyticsScript();
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
