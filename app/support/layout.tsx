"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth, useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Toaster } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";

const HEARTBEAT_INTERVAL_MS = 25_000;

export default function SupportLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const isSupportAgent = useQuery(api.supportAgentAuth.isSupportAgent, isAuthenticated ? {} : "skip");
  const heartbeat = useMutation(api.liveChat.heartbeat);

  const [online, setOnline] = useState(false);
  const onlineRef = useRef(online);
  onlineRef.current = online;

  const isLoading = authLoading || (isAuthenticated && isSupportAgent === undefined);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated || !isSupportAgent) {
      router.replace("/dashboard");
    }
  }, [isLoading, isAuthenticated, isSupportAgent, router]);

  useEffect(() => {
    if (!isSupportAgent) return;
    heartbeat({ isOnline: onlineRef.current });
    const interval = setInterval(() => heartbeat({ isOnline: onlineRef.current }), HEARTBEAT_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      heartbeat({ isOnline: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupportAgent]);

  useEffect(() => {
    if (!isSupportAgent) return;
    heartbeat({ isOnline: online });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, isSupportAgent]);

  if (isLoading || !isAuthenticated || !isSupportAgent) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 flex-col gap-4">
        <div className="w-10 h-10 rounded-full border-4 border-amber-500 border-t-transparent animate-spin" />
        <p className="text-sm text-slate-400">Checking access...</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full flex-col bg-slate-950">
      <header className="h-16 flex items-center justify-between px-6 border-b border-slate-800 shrink-0">
        <span className="text-sm font-semibold text-white tracking-wide">AutoFlow · Support Console</span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400">{online ? "You're online" : "You're offline"}</span>
          <Switch checked={online} onCheckedChange={setOnline} />
        </div>
      </header>
      <main className="flex-1 overflow-hidden p-4 lg:p-6">{children}</main>
      <Toaster />
    </div>
  );
}
