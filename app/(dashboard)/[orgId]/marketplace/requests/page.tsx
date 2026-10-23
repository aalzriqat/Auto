import { MarketplaceRequestsClient } from "./client";
import { RoleGuard } from "@/components/auth/RoleGuard";

export const metadata = {
  title: "Marketplace Requests | AutoFlow",
  description: "Buyer car requests matched to your dealership",
};

export default function MarketplaceRequestsPage() {
  return <RoleGuard permissions={["marketplace:respond"]}><MarketplaceRequestsClient /></RoleGuard>;
}
