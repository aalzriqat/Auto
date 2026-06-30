const NEXT_APP_ORIGIN = "https://autoflowdealer.com";

const SYSTEM_SUBDOMAINS = new Set([
  "www", "app", "api", "admin", "clerk", "auth", "login", "signup",
  "mail", "static", "assets", "cdn", "status", "support", "billing",
  "dashboard", "sites",
]);

// Headers that must never be forwarded to the upstream origin.
// Forwarding large cookies (Clerk JWTs set at .autoflowdealer.com) or
// hop-by-hop headers causes Cloudflare subrequest failures (Error 1101).
const STRIP_REQUEST_HEADERS = new Set([
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-proto",
  "x-real-ip",
]);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const pathname = url.pathname;
    const search = url.search;

    const parts = hostname.split(".");
    const subdomain = parts.length >= 3 ? parts[0] : null;

    if (!subdomain || SYSTEM_SUBDOMAINS.has(subdomain)) {
      return fetch(request);
    }

    // Build a clean header set — strip cookies and hop-by-hop headers
    const cleanHeaders = new Headers();
    for (const [key, value] of request.headers) {
      if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
        cleanHeaders.set(key, value);
      }
    }
    cleanHeaders.set("X-Forwarded-Host", hostname);
    cleanHeaders.set("X-Dealer-Subdomain", subdomain);

    // Static assets and API routes: proxy directly, no path rewrite
    if (
      pathname.startsWith("/_next/") ||
      pathname.startsWith("/api/") ||
      pathname === "/favicon.ico" ||
      pathname.startsWith("/favicon") ||
      pathname.endsWith(".txt") ||
      pathname.endsWith(".xml")
    ) {
      return fetch(NEXT_APP_ORIGIN + pathname + search, {
        method: request.method,
        headers: cleanHeaders,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
        redirect: "follow",
      });
    }

    // Dealer site pages: /<path> → /dealer-site/<path>
    const dealerPath = pathname === "/" ? "" : pathname;
    const targetUrl = `${NEXT_APP_ORIGIN}/dealer-site${dealerPath}${search}`;

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: cleanHeaders,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      redirect: "follow",
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("X-Frame-Options");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
} satisfies ExportedHandler;
