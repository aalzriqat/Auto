// EAS Build pre-install hook.
//
// Our android/ directory is committed (a "bare" project), so EAS Build skips
// `expo prebuild` and never processes app.config's `android.googleServicesFile`.
// google-services.json is gitignored (it carries the Android Firebase key), so
// it isn't in the build's git archive. This copies it from the
// GOOGLE_SERVICES_JSON file secret into android/app/, where the Gradle
// google-services plugin (applied conditionally in android/app/build.gradle)
// expects it. Without this, the cloud build would silently ship without FCM.
const fs = require("fs");

const src = process.env.GOOGLE_SERVICES_JSON;
if (src && fs.existsSync(src)) {
  fs.mkdirSync("android/app", { recursive: true });
  fs.copyFileSync(src, "android/app/google-services.json");
  console.log("[eas] placed android/app/google-services.json from GOOGLE_SERVICES_JSON");
} else {
  console.log("[eas] GOOGLE_SERVICES_JSON not set or file missing; skipping FCM placement:", src);
}
