import "react-native-gesture-handler";

import { Stack } from "expo-router";

import { RouteErrorState } from "../src/components/RouteState";
import { AppProviders } from "../src/providers/AppProviders";
import { theme } from "../src/theme";

type ExpoRouteErrorBoundaryProps = {
  error: Error;
  retry: () => void;
};

export function ErrorBoundary({ error, retry }: ExpoRouteErrorBoundaryProps) {
  return <RouteErrorState message={error.message} onRetry={retry} />;
}

export default function RootLayout() {
  return (
    <AppProviders>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      />
    </AppProviders>
  );
}
