import { MarketplaceScreen } from "../../src/features/marketplace/MarketplaceScreen";

// Marketplace-first: the app opens straight into the public buyer marketplace.
// Dealers reach their workspace via Account → Dealer sign in (/workspaces).
export default function HomeRoute() {
  return <MarketplaceScreen />;
}
