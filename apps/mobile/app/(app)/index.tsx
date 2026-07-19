import { BuyerShell } from "../../src/features/marketplace/BuyerShell";

// Marketplace-first: the app opens into the buyer shell (Browse · Request ·
// Saved · Account). Dealers reach their workspace via Account → Dealer sign in.
export default function HomeRoute() {
  return <BuyerShell />;
}
