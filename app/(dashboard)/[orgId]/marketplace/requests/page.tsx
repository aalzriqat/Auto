import { MarketplaceRequestsClient } from "./client";

export const metadata = {
  title: "Marketplace Requests | AutoFlow",
  description: "Buyer car requests matched to your dealership",
};

export default function MarketplaceRequestsPage() {
  return <MarketplaceRequestsClient />;
}
