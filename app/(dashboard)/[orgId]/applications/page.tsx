import { Suspense } from "react";
import { ApplicationClient } from "./client";
import { RoleGuard } from "@/components/auth/RoleGuard";

export const metadata = {
  title: "Applications | AutoFlow",
  description: "Manage finance applications",
};

export default function ApplicationsPage() {
  return (
    // TODO: "view:applications" permission doesn't exist, using "view:sales" as it accurately represents the intended audience
    <RoleGuard permissions={["view:sales"]}>
      {/* ApplicationClient reads ?application=<id> to open a deal directly, and
          useSearchParams needs a boundary for this route to prerender. */}
      <Suspense>
        <ApplicationClient />
      </Suspense>
    </RoleGuard>
  );
}
