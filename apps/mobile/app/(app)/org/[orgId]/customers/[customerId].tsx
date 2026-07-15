import { useLocalSearchParams } from "expo-router";

import { firstParam } from "../../../../../src/navigation/routeParams";
import { CustomerDetailScreen } from "../../../../../src/features/workspace/CustomerDetailScreen";

export default function CustomerDetailRoute() {
  const params = useLocalSearchParams<{
    customerId?: string | string[];
    orgId?: string | string[];
  }>();

  return (
    <CustomerDetailScreen
      customerId={firstParam(params.customerId)}
      orgId={firstParam(params.orgId)}
    />
  );
}
