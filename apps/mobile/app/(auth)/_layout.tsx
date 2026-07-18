import { Stack } from "expo-router";

import { useAppTheme } from "../../src/providers/ThemeProvider";

export default function AuthLayout() {
  const theme = useAppTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        presentation: "modal",
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    />
  );
}
