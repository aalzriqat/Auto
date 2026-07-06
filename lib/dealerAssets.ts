import { NextResponse } from "next/server";

export const VERCEL_ANALYTICS_SCRIPT_PATH = /^\/[a-f0-9]{16,}\/script\.js$/i;

export function dealerManifestResponse(): Response {
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

export function emptyAnalyticsScriptResponse(): Response {
  return new NextResponse("", {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/javascript; charset=utf-8",
    },
  });
}
