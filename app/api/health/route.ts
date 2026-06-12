import { NextResponse } from "next/server";

export async function GET() {
  // A basic health check endpoint for uptime monitoring tools (e.g., BetterStack, Datadog)
  return NextResponse.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "AutoFlow Web App",
    },
    { status: 200 }
  );
}
