"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth, useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/sonner";
import { Headset } from "lucide-react";
import { LIVE_CHAT_ENABLED } from "@/lib/featureFlags";

const HEARTBEAT_INTERVAL_MS = 25_000;

export default function SupportLayout({ children }: { children: React.ReactNode }) {
  if (!LIVE_CHAT_ENABLED) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-500">Live chat is currently disabled.</p>
      </div>
    );
  }
  return <SupportLayoutImpl>{children}</SupportLayoutImpl>;
}

function SupportLayoutImpl({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const isSupportAgent = useQuery(api.supportAgentAuth.isSupportAgent, isAuthenticated ? {} : "skip");
  const myStatus = useQuery(api.liveChat.getMyAgentStatus, isAuthenticated && isSupportAgent ? {} : "skip");
  const heartbeat = useMutation(api.liveChat.heartbeat);
  const setAgentStatus = useMutation(api.liveChat.setAgentStatus);

  const status = myStatus?.status ?? "OFFLINE";
  const isOnline = status === "ONLINE";
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const isLoading = authLoading || (isAuthenticated && isSupportAgent === undefined);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated || !isSupportAgent) {
      router.replace("/dashboard");
    }
  }, [isLoading, isAuthenticated, isSupportAgent, router]);

  useEffect(() => {
    // Wait for myStatus to actually load before sending any heartbeat —
    // otherwise isOnlineRef.current is still its pre-load default (false)
    // and we'd incorrectly flip a genuinely online agent offline on every
    // mount (including React's dev-mode double-invoke on refresh).
    if (!isSupportAgent || myStatus === undefined) return;
    heartbeat({ isOnline: isOnlineRef.current });
    const interval = setInterval(() => heartbeat({ isOnline: isOnlineRef.current }), HEARTBEAT_INTERVAL_MS);
    // No "set offline" on cleanup: every consumer of isOnline already also
    // checks lastHeartbeatAt staleness (see ONLINE_THRESHOLD_MS), so simply
    // letting heartbeats stop is what marks a truly-gone agent as offline —
    // without misfiring on remounts that aren't really a disconnect.
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupportAgent, myStatus === undefined]);

  async function handleSetStatus(next: "ONLINE" | "BREAK" | "OFFLINE") {
    try {
      const result = await setAgentStatus({ status: next });
      if (!result.applied) {
        toast.info("You're still in an active chat — you'll switch to break once it ends.");
      }
    } catch (e: any) {
      toast.error(e?.data?.message ?? e?.message ?? "Failed to update status");
    }
  }

  if (isLoading || !isAuthenticated || !isSupportAgent) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 flex-col gap-4">
        <div className="w-10 h-10 rounded-full border-4 border-primary border-t-transparent animate-spin" />
        <p className="text-sm text-slate-500">Checking access...</p>
      </div>
    );
  }

  const hasActiveChats = (myStatus?.activeChatCount ?? 0) > 0;

  return (
    <div className="flex h-screen w-full flex-col bg-slate-50">
      <header className="h-16 flex items-center justify-between px-6 border-b border-slate-200 bg-white shadow-sm shrink-0">
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-900 tracking-wide">
          <Headset className="h-4 w-4 text-primary" />
          AutoFlow · Support Console
        </span>

        <div className="flex items-center gap-3">
          {myStatus?.pendingBreak && (
            <span className="text-xs text-amber-600">Break starts after this chat</span>
          )}

          {hasActiveChats ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> Online
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(myStatus?.pendingBreak)}
                onClick={() => handleSetStatus("BREAK")}
              >
                {myStatus?.pendingBreak ? "Break scheduled" : "Start break after this chat"}
              </Button>
            </div>
          ) : (
            <div className="flex items-center rounded-lg border border-slate-200 p-0.5 bg-slate-100">
              {(["ONLINE", "BREAK", "OFFLINE"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => handleSetStatus(s)}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5",
                    status === s ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-700"
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      s === "ONLINE" ? "bg-emerald-500" : s === "BREAK" ? "bg-amber-500" : "bg-slate-400"
                    )}
                  />
                  {s === "ONLINE" ? "Online" : s === "BREAK" ? "Break" : "Offline"}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      <main className="flex-1 overflow-hidden p-4 lg:p-6">{children}</main>
      <Toaster />
    </div>
  );
}
