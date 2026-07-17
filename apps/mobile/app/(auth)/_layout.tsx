import { Stack } from "expo-router";

import { theme } from "../../src/theme";

export default function AuthLayout() {
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
