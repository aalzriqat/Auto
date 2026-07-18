import { Stack } from "expo-router";

import { useAppTheme } from "../../src/providers/ThemeProvider";

export default function AppLayout() {
  const theme = useAppTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );
}
