import type { ConfigContext, ExpoConfig } from "expo/config";

const appScheme = process.env.EXPO_PUBLIC_APP_SCHEME || "autoflow";

// Expo push needs the EAS project id to mint tokens. Set once via `eas init`
// (writes extra.eas.projectId) or the EXPO_PUBLIC_EAS_PROJECT_ID env var. When
// absent, push-token registration is skipped gracefully (see usePushRegistration).
const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;

// OTA update endpoint. `eas update:configure` writes this as
// https://u.expo.dev/<projectId>; the env var is the self-host / manual escape
// hatch. When unset, OTA is simply off (the in-app checker no-ops).
const updatesUrl = process.env.EXPO_PUBLIC_UPDATES_URL;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "AutoFlow",
  slug: "autoflow-native",
  scheme: appScheme,
  // Drives the "appVersion" runtimeVersion policy below: OTA JS bundles only
  // load onto a native build with a matching runtimeVersion, so bump this
  // whenever you ship a NATIVE change (new module/permission) to force a fresh
  // APK instead of pushing an incompatible bundle over-the-air.
  version: "1.0.0",
  runtimeVersion: { policy: "appVersion" },
  ...(updatesUrl
    ? {
        updates: {
          url: updatesUrl,
          // Don't stall the splash waiting on the update server; apply a fetched
          // update on the next launch instead (see checkForOtaUpdate).
          fallbackToCacheTimeout: 0,
        },
      }
    : {}),
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  // Square 1024x1024 app icon (see assets/README.md for the source-of-truth
  // logo and how these are generated).
  icon: "./assets/icon.png",
  ios: {
    ...config.ios,
    bundleIdentifier: "com.autoflowdealer.mobile",
    supportsTablet: true,
  },
  android: {
    ...config.android,
    package: "com.autoflowdealer.mobile",
    adaptiveIcon: {
      // Android crops the foreground to a circle/squircle and only shows the
      // centre ~66%, so this must be the AF/car MARK (no wordmark), centred on
      // transparency, over a white plate matching the logo background.
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#FFFFFF",
    },
    // Declared here for clarity; the config plugins below also inject the ones
    // they own. Expo dedupes, so listing them is safe and self-documenting.
    permissions: [
      "POST_NOTIFICATIONS",
      "CAMERA",
      "READ_MEDIA_IMAGES",
      "ACCESS_COARSE_LOCATION",
      "ACCESS_FINE_LOCATION",
    ],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    [
      "expo-splash-screen",
      {
        // Full horizontal AutoFlow logo (car + wordmark) is fine here — the
        // splash isn't cropped like the icon is.
        image: "./assets/splash-logo.png",
        imageWidth: 240,
        resizeMode: "contain",
        backgroundColor: "#FFFFFF",
      },
    ],
    "@clerk/expo",
    // Local + remote notifications. Icon/colour left default to avoid a
    // missing-asset build failure; add an icon later if desired.
    "expo-notifications",
    [
      "expo-camera",
      {
        cameraPermission: "AutoFlow uses the camera to capture vehicle photos.",
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: "AutoFlow accesses your photos so you can attach vehicle and document images.",
        cameraPermission: "AutoFlow uses the camera to capture vehicle photos.",
      },
    ],
    [
      "expo-location",
      {
        locationWhenInUsePermission: "AutoFlow uses your location to tag branch visits and nearby inventory.",
      },
    ],
  ],
  extra: {
    ...config.extra,
    // Monotonic native build ordinal the app compares against the server's
    // latest published release (mobileReleases) to decide whether to prompt for
    // a new APK. Bump via EXPO_PUBLIC_BUILD_NUMBER on every native build, in
    // step with the buildNumber you publish through mobileReleases.publishRelease.
    buildNumber: Number(process.env.EXPO_PUBLIC_BUILD_NUMBER ?? "1"),
    eas: {
      ...(config.extra?.eas as Record<string, unknown> | undefined),
      ...(easProjectId ? { projectId: easProjectId } : {}),
    },
  },
  experiments: {
    ...config.experiments,
    typedRoutes: true,
  },
});
