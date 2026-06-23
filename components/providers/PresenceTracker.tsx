"use client";

import { useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

// Mirrors the server-side floor in memberships.touchLastSeen, slightly looser
// so the client is normally the one deciding not to call, not the server.
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

// Deliberately NOT a setInterval heartbeat — it only writes in response to a
// real usage signal (tab opened, tab refocused), each throttled per-org via
// localStorage, so an idle/backgrounded tab never generates writes at all.
export function PresenceTracker({ orgId }: { orgId: Id<"organizations"> }) {
  const touchLastSeen = useMutation(api.memberships.touchLastSeen);

  useEffect(() => {
    const storageKey = `autoflow:lastSeenTouch:${orgId}`;

    const maybeTouch = () => {
      const last = Number(localStorage.getItem(storageKey) ?? 0);
      if (Date.now() - last < TOUCH_THROTTLE_MS) return;
      localStorage.setItem(storageKey, String(Date.now()));
      touchLastSeen({ orgId }).catch(() => {});
    };

    maybeTouch();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") maybeTouch();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", maybeTouch);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", maybeTouch);
    };
  }, [orgId, touchLastSeen]);

  return null;
}
