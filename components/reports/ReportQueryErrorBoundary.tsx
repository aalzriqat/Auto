"use client";

import { Component, type ReactNode } from "react";
import { ConvexError } from "convex/values";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";

/**
 * Convex's `useQuery` rethrows a failed query during render. The report queries refuse on purpose (a range with too
 * many deals, the rate limit) with a ConvexError carrying a plain-language message: show that message. Anything else
 * is logged and replaced by a generic line, never shown raw.
 */
function ReportFailure({ error, onRetry }: Readonly<{ error: unknown; onRetry: () => void }>) {
  const { t } = useLanguage();
  const message = error instanceof ConvexError && typeof error.data === "string" ? error.data : t("ReportLoadFailed");
  return (
    <div role="alert" className="space-y-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
      <p>{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>{t("ReportTryAgain")}</Button>
    </div>
  );
}

export class ReportQueryErrorBoundary extends Component<{ children: ReactNode }, { error: unknown; failed: boolean }> {
  state = { error: undefined as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <ReportFailure error={this.state.error} onRetry={() => this.setState({ error: undefined, failed: false })} />;
  }
}
