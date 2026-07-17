# AutoFlow mobile — updates, push & permissions setup

This build adds native permissions, push notifications, over-the-air (OTA)
updates, and an APK-fallback updater. Most of it is code that's already wired;
the steps below are the **one-time / per-build actions only you can do** (they
need your Expo account, signing key, and a device build).

> ⚠️ All of these are **native** additions — they can't ship over-the-air. You
> must do **one fresh APK build** (from `C:\h-ui`, as usual) for any of it to
> take effect. After that, JS changes flow via OTA with no reinstall.

## 1. App icon / splash (see `assets/README.md`)
Drop `assets/icon.png`, `assets/adaptive-icon.png`, `assets/splash-logo.png`
(the AutoFlow logo) before building — the config already references them.

## 2. Over-the-air updates (EAS Update)
**Already wired:** the EAS project id (`bddc3f4c-6f00-402c-913f-380afbd7fa05`,
account `aalzriqat`), the `owner`/`slug`, and the update URL
(`https://u.expo.dev/<projectId>`) are baked into `app.config.ts` — so you do
**not** need `eas init` or `eas update:configure`. You only need to log in to
publish updates:
```bash
cd apps/mobile
npx eas login   # your Expo account (aalzriqat)
```
Then, to push a JS-only update after that first build:
```bash
npx eas update --branch production --message "what changed"
```
The app calls `checkForOtaUpdate()` on launch and reloads into the new bundle.
To point at a different project or a self-hosted server, override with the
`EXPO_PUBLIC_EAS_PROJECT_ID` / `EXPO_PUBLIC_UPDATES_URL` env vars.

## 3. Push notifications
- Uses the same wired EAS project id (Expo mints push tokens against it).
- On launch (once signed in) the app requests the notification permission,
  registers the device's Expo token via `mobilePushTokens.register`, and
  `dispatch()` then delivers to it for any lead/message/task notification.
- ⚠️ **Remote push reaches Android only through FCM**, so it will **not** arrive
  on Google-Play-less devices (Huawei/HMS). The permission prompt and *local*
  notifications still work there; remote delivery needs a GMS device (or a
  separate HMS Push Kit integration later).

## 4. Camera / photo-library / location
Declared in `app.config.ts`; request-on-use helpers live in
`src/permissions/mediaPermissions.ts` — call `ensureCameraPermission()` etc.
right before the action that needs them.

## 5. APK-fallback updater (for native changes)
When you ship a new native build:
1. Bump `EXPO_PUBLIC_BUILD_NUMBER` (and `version` in `app.config.ts` if the
   runtimeVersion should change) and build the APK.
2. Host the signed APK somewhere with an `https` URL.
3. Publish it so installed apps prompt to update — run as a super admin:
   ```bash
   CONVEX_DEPLOYMENT=prod:kindly-hound-172 npx convex run mobileReleases:publishRelease \
     '{"platform":"ANDROID","buildNumber":2,"versionName":"1.1.0","runtimeVersion":"1.0.0","apkUrl":"https://.../autoflow-1.1.0.apk"}'
   ```
   (`buildNumber` must exceed the current latest.) Older installs see the
   prompt on next launch and download via the browser.
