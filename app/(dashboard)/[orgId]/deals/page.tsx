import { DealQueueClient } from "./client";
import { RoleGuard } from "@/components/auth/RoleGuard";

export const metadata = {
  title: "Deals | AutoFlow",
  description: "Every deal on the floor, ranked by what needs attention",
};

export default function DealsPage() {
  // Same gate as the two lists this queue unifies. The projection re-checks it
  // server-side; this only keeps the route from rendering for someone who would
  // get nothing back.
  return (
    <RoleGuard permissions={["view:sales"]}>
      <DealQueueClient />
    </RoleGuard>
  );
}
