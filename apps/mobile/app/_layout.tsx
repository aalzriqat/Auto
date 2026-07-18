import "react-native-gesture-handler";

import { Stack } from "expo-router";

import { RouteErrorState } from "../src/components/RouteState";
import { AppProviders } from "../src/providers/AppProviders";
import { buildTheme } from "../src/theme";
import { readInitialThemeMode } from "../src/themeMode";

// RootLayout renders above ThemeProvider, so it can't subscribe to live theme
// changes. Resolve the root Stack's background from the persisted mode at launch
// (nested (app)/(auth) layouts + Screen re-theme live once inside the provider).
const rootBackgroundColor = buildTheme(readInitialThemeMode()).colors.background;

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
          contentStyle: { backgroundColor: rootBackgroundColor },
        }}
      />
    </AppProviders>
  );
}
