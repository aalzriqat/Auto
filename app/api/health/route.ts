import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

export async function GET() {
  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: "autoflow-health", status: "in_progress" },
    { schedule: { type: "interval", value: 1, unit: "minute" } }
  );

  try {
    const body = {
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "AutoFlow Web App",
    };

    Sentry.captureCheckIn({ checkInId, monitorSlug: "autoflow-health", status: "ok" });

    return NextResponse.json(body, { status: 200 });
  } catch (error) {
    Sentry.captureCheckIn({ checkInId, monitorSlug: "autoflow-health", status: "error" });
    throw error;
  }
}
