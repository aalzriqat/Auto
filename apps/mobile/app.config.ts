import type { ConfigContext, ExpoConfig } from "expo/config";

const appScheme = process.env.EXPO_PUBLIC_APP_SCHEME || "autoflow";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "AutoFlow",
  slug: "autoflow-native",
  scheme: appScheme,
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  ios: {
    ...config.ios,
    bundleIdentifier: "com.autoflowdealer.mobile",
    supportsTablet: true,
  },
  android: {
    ...config.android,
    package: "com.autoflowdealer.mobile",
    adaptiveIcon: {
      backgroundColor: "#0f172a",
    },
  },
  web: {
    ...config.web,
    bundler: "metro",
  },
  plugins: ["expo-router", "expo-secure-store", "expo-splash-screen", "@clerk/expo"],
  experiments: {
    ...config.experiments,
    typedRoutes: true,
  },
});
