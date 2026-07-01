"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useMutation } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/convex/_generated/api";

type AcceptState = "loading" | "success" | "error";

export default function AcceptInvitePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isLoaded, isSignedIn } = useAuth();
  const acceptInvitation = useMutation(api.memberships.acceptInvitation);
  const attempted = useRef(false);
  const [state, setState] = useState<AcceptState>("loading");
  const [message, setMessage] = useState("Accepting invitation...");

  useEffect(() => {
    const token = searchParams.get("token")?.trim();

    if (!token) {
      setState("error");
      setMessage("This invitation link is missing its token.");
      return;
    }

    if (!isLoaded) return;

    if (!isSignedIn) {
      router.replace(`/sign-in?redirect_url=${encodeURIComponent(`/accept-invite?token=${token}`)}`);
      return;
    }

    if (attempted.current) return;
    attempted.current = true;

    let cancelled = false;
    acceptInvitation({ token })
      .then((result) => {
        if (cancelled) return;
        if (result.status !== "accepted") {
          setState("error");
          setMessage("This invitation has expired. Ask your administrator for a new invite.");
          return;
        }
        setState("success");
        setMessage("Invitation accepted. Opening your dashboard...");
        window.setTimeout(() => {
          router.replace(`/${result.orgId}/dashboard`);
        }, 700);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState("error");
        setMessage(error instanceof Error ? error.message : "Invitation could not be accepted.");
      });

    return () => {
      cancelled = true;
    };
  }, [acceptInvitation, isLoaded, isSignedIn, router, searchParams]);

  return (
    <main className="flex min-h-screen items-center justify-center px-6 text-center">
      <div className="max-w-sm space-y-3">
        <div
          className={`mx-auto h-2 w-24 rounded-full ${
            state === "error" ? "bg-destructive" : state === "success" ? "bg-green-500" : "bg-primary"
          }`}
        />
        <h1 className="text-xl font-semibold">Team invitation</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </main>
  );
}
