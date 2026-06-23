import { NextResponse } from "next/server";

// Always read fresh per request (no caching) so a deployed update is visible
// immediately, not after some CDN TTL.
export async function GET() {
  return NextResponse.json(
    { buildSha: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
