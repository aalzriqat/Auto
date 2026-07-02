"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useAuth, useUser } from "@clerk/nextjs";
// The signals-based useSignIn shipped in @clerk/nextjs 7 doesn't expose the
// ticket-strategy custom flow yet — the documented custom-flow hook lives in
// the legacy entrypoint.
import { useSignIn } from "@clerk/nextjs/legacy";
import { useRouter, useSearchParams } from "next/navigation";

type SetupState = "loading" | "set-password" | "success" | "error";

function clerkErrorMessage(error: unknown): string {
  const maybeClerkError = error as { errors?: Array<{ longMessage?: string; message?: string }> };
  return (
    maybeClerkError?.errors?.[0]?.longMessage ||
    maybeClerkError?.errors?.[0]?.message ||
    (error instanceof Error ? error.message : "Something went wrong. Please try again.")
  );
}

function SetupAccountContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const { isLoaded: signInLoaded, signIn, setActive } = useSignIn();
  const { user } = useUser();
  const attempted = useRef(false);

  const [state, setState] = useState<SetupState>("loading");
  const [message, setMessage] = useState("Activating your account...");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const ticket = searchParams.get("ticket")?.trim();

    if (!ticket) {
      setState("error");
      setMessage("This setup link is missing its token. Ask your administrator to re-create your account.");
      return;
    }

    if (!authLoaded || !signInLoaded || !signIn || !setActive) return;

    if (isSignedIn) {
      // Already signed in (link opened twice, or a different session is
      // active) — the one-time ticket can't be consumed from here.
      router.replace("/");
      return;
    }

    if (attempted.current) return;
    attempted.current = true;

    let cancelled = false;
    signIn
      .create({ strategy: "ticket", ticket })
      .then(async (result) => {
        if (cancelled) return;
        if (result.status !== "complete" || !result.createdSessionId) {
          setState("error");
          setMessage("This setup link is invalid or has expired. Ask your administrator to re-create your account, or use \"Forgot password\" on the sign-in page.");
          return;
        }
        await setActive({ session: result.createdSessionId });
        setState("set-password");
        setMessage("");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState("error");
        setMessage(
          `${clerkErrorMessage(error)} — if the link expired, ask your administrator to re-create your account, or use "Forgot password" on the sign-in page.`
        );
      });

    return () => {
      cancelled = true;
    };
  }, [authLoaded, signInLoaded, isSignedIn, signIn, setActive, searchParams, router]);

  const onSubmitPassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordError(null);

    if (newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match.");
      return;
    }
    if (!user) {
      setPasswordError("Your session is still loading — try again in a moment.");
      return;
    }

    setIsSaving(true);
    try {
      await user.updatePassword({ newPassword });
      setState("success");
      setMessage("Your account is ready. Opening AutoFlow...");
      window.setTimeout(() => {
        router.replace("/");
      }, 900);
    } catch (error: unknown) {
      setPasswordError(clerkErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 shadow-sm">
        <h1 className="mb-2 text-xl font-semibold">Set up your AutoFlow account</h1>

        {state === "loading" && (
          <p className="text-sm text-muted-foreground">{message}</p>
        )}

        {state === "error" && (
          <p className="text-sm text-destructive">{message}</p>
        )}

        {state === "success" && (
          <p className="text-sm text-muted-foreground">{message}</p>
        )}

        {state === "set-password" && (
          <form onSubmit={onSubmitPassword} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              You&apos;re signed in. Choose a password to finish setting up your account.
            </p>
            <div className="space-y-2">
              <label htmlFor="new-password" className="text-sm font-medium">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="confirm-password" className="text-sm font-medium">
                Confirm password
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
            <button
              type="submit"
              disabled={isSaving}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {isSaving ? "Saving..." : "Save password & continue"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function SetupAccountPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      }
    >
      <SetupAccountContent />
    </Suspense>
  );
}
