import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/dealer-site(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/privacy",
  "/terms",
  "/contact",
  "/api/health",
  "/clerk-webhook",
]);

function normalizedHost(host: string | null): string {
  return (host ?? "").toLowerCase().replace(/:\d+$/, "");
}

function appHost(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) return null;
  try {
    return new URL(configured).host.toLowerCase().replace(/:\d+$/, "");
  } catch {
    return null;
  }
}

function isDealerWebsiteRequest(req: Request): boolean {
  const host = normalizedHost(req.headers.get("host"));
  if (!host || host === "localhost" || host === "127.0.0.1") return false;
  if (host === appHost()) return false;
  if (host === "autoflowdealer.com" || host === "www.autoflowdealer.com") return false;
  if (host.endsWith(".autoflowdealer.com")) return true;
  return !host.endsWith(".vercel.app");
}

export default clerkMiddleware(async (auth, req) => {
  if (isDealerWebsiteRequest(req)) {
    const url = req.nextUrl.clone();
    const originalPath = url.pathname === "/" ? "" : url.pathname;
    url.pathname = `/dealer-site${originalPath}`;
    url.searchParams.set("host", normalizedHost(req.headers.get("host")));
    return NextResponse.rewrite(url);
  }

  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
