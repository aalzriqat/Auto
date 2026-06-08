import { ApplicationClient } from "./client";
import { RoleGuard } from "@/components/auth/RoleGuard";

export const metadata = {
  title: "Applications | Bloom Cars",
  description: "Manage finance applications",
};

export default function ApplicationsPage() {
  return (
    // TODO: "view:applications" permission doesn't exist, using "view:sales" as it accurately represents the intended audience
    <RoleGuard permissions={["view:sales"]}>
      <ApplicationClient />
    </RoleGuard>
  );
}
