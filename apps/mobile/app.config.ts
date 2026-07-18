import type { ConfigContext, ExpoConfig } from "expo/config";

const appScheme = process.env.EXPO_PUBLIC_APP_SCHEME || "autoflow";

// FCM config for Expo push (remote notifications on Android). Kept out of git
// (it carries the Android Firebase key); provide it locally as
// apps/mobile/google-services.json or via the GOOGLE_SERVICES_JSON env / EAS
// secret. Only consumed by `expo prebuild` / EAS; a plain Gradle build ignores
// it and applies the Firebase plugin only when the file is actually present
// (see android/app/build.gradle), so a checkout without FCM creds still builds.
const googleServicesFile = process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json";

// The EAS project created for AutoFlow (expo.dev, account "aalzriqat"). This id
// is what both EAS Update (OTA) and the Expo push service route by. It's public
// (it ships in the app bundle), so it's fine hardcoded; the env var only exists
// to point a different build at a different project / self-hosted server.
const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? "bddc3f4c-6f00-402c-913f-380afbd7fa05";

// OTA update endpoint — EAS Update serves each project at u.expo.dev/<projectId>.
const updatesUrl = process.env.EXPO_PUBLIC_UPDATES_URL ?? `https://u.expo.dev/${easProjectId}`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "AutoFlow",
  // Must match the EAS project's slug + owning account for `eas` commands and
  // the update/push services to resolve to the right project.
  slug: "autoflow",
  owner: "aalzriqat",
  scheme: appScheme,
  version: "1.0.0",
  // Bare workflow (android/ is committed) → eas update can't resolve a policy,
  // so pin the runtime version concretely. Must equal the value the installed
  // APK embeds (the old "appVersion" policy resolved to `version` = "1.0.0").
  // Bump this in lockstep whenever you ship a NATIVE change + build a fresh APK.
  runtimeVersion: "1.0.0",
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
    googleServicesFile,
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
