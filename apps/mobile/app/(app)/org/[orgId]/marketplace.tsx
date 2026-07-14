import { useLocalSearchParams } from "expo-router";

import { DealerMarketplaceScreen } from "../../../../src/features/marketplace/DealerMarketplaceScreen";

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export default function DealerMarketplaceRoute() {
  const params = useLocalSearchParams<{ orgId?: string | string[] }>();
  return <DealerMarketplaceScreen orgId={firstParam(params.orgId)} />;
}
