import { HomeScreen } from "../../src/features/home/HomeScreen";

// Dealer workspace picker. Reached from Account → Dealer sign in (or directly by
// a signed-in dealer). Auto-enters the sole workspace when there's exactly one.
export default function DealerWorkspacesRoute() {
  return <HomeScreen />;
}
