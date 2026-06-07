"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export default function DashboardErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service like Sentry (Phase 4)
    console.error("Dashboard error boundary caught error:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] p-8 text-center bg-card rounded-lg border shadow-sm my-8">
      <div className="bg-destructive/10 p-4 rounded-full mb-4">
        <AlertTriangle className="h-10 w-10 text-destructive" />
      </div>
      <h2 className="text-2xl font-bold mb-2">Something went wrong!</h2>
      <p className="text-muted-foreground mb-6 max-w-md">
        An error occurred while loading this dashboard view. Your data is safe, but we couldn't display the page properly.
      </p>
      <div className="flex gap-4">
        <Button onClick={() => window.location.reload()} variant="outline">
          Refresh Page
        </Button>
        <Button onClick={() => reset()}>
          Try Again
        </Button>
      </div>
      {process.env.NODE_ENV === "development" && (
        <div className="mt-8 p-4 bg-muted rounded text-left max-w-2xl overflow-auto w-full">
          <p className="font-mono text-sm text-destructive font-semibold mb-2">{error.message}</p>
          <pre className="font-mono text-xs text-muted-foreground whitespace-pre-wrap">{error.stack}</pre>
        </div>
      )}
    </div>
  );
}
