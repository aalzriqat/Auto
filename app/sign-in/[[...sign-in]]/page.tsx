import { SignIn } from "@clerk/nextjs";
import { SiteVisitorTracker } from "@/components/analytics/SiteVisitorTracker";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <SiteVisitorTracker path="/sign-in" />
      <SignIn fallbackRedirectUrl="/dashboard" />
    </div>
  );
}
