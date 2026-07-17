# AutoFlow mobile brand assets

The app icon, adaptive icon, and splash logo referenced by `app.config.ts` live
here. Drop the AutoFlow logo (the silver car + blue/orange "AF" flourish +
AUTOFLOW wordmark) into these three files:

| File | Size | What it should contain |
|------|------|------------------------|
| `icon.png` | 1024×1024 PNG | Square app icon. **Use a cropped square of the car + AF mark** — the full horizontal logo with the AUTOFLOW wordmark looks cramped and text-heavy at icon size. White or transparent background. |
| `adaptive-icon.png` | 1024×1024 PNG | Android adaptive-icon **foreground**: the AF/car MARK only (no wordmark), centred within the middle ~66% (Android crops the outer edges to a circle/squircle), on a **transparent** background. The white plate comes from `adaptiveIcon.backgroundColor`. |
| `splash-logo.png` | ~1200px wide PNG | The **full** horizontal logo (car + AUTOFLOW wordmark). Transparent background preferred; it sits on a white splash. |

## Applying the icon — important, this app has a customized native `android/` dir

Because `android/` is committed and hand-tuned (autolinking excludes, gradle
tweaks), do **not** blindly run `npx expo prebuild --clean` — it will wipe those
native changes. Two safe options:

1. **Icon generator (recommended, no prebuild):** feed a 1024×1024 source to an
   icon generator (Android Studio → *Image Asset Studio*, or `npx @expo/image-utils`,
   or an online app-icon generator) and drop the produced density buckets into
   `android/app/src/main/res/mipmap-*/` (`ic_launcher.png` + `ic_launcher_round.png`)
   and the splash into `drawable-*/splashscreen_logo.png`. No native changes touched.
2. **Prebuild (only if you can re-apply native tweaks):** with these three files
   in place, `npx expo prebuild --platform android` regenerates icons/splash from
   the config — but re-verify the gradle/manifest customizations afterward.

After either path, rebuild the APK from `C:\h-ui` as usual and verify on-device.
