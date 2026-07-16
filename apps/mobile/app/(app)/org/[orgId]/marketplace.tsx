import { useLocalSearchParams } from "expo-router";

import { firstParam } from "../../../../src/navigation/routeParams";
import { DealerMarketplaceScreen } from "../../../../src/features/marketplace/DealerMarketplaceScreen";

export default function DealerMarketplaceRoute() {
  const params = useLocalSearchParams<{ orgId?: string | string[] }>();
  return <DealerMarketplaceScreen orgId={firstParam(params.orgId)} />;
}
