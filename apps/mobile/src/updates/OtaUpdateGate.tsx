import { useEffect, useRef, type ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { checkForOtaUpdate } from "./otaUpdates";

// Don't re-hit the update server on every quick app-switch. A user tabbing out
// to copy a phone number and straight back shouldn't trigger a check; a genuine
// "came back after a while" will be well past this window.
const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Runs the over-the-air update check on launch AND every time the app returns
 * to the foreground, then renders its children untouched. A side-effect gate,
 * like PushNotificationsGate — kept separate so OTA (no auth needed) and push
 * (auth needed) stay independent.
 *
 * The foreground check is what covers users who keep the app backgrounded for
 * days and never cold-launch it: without it, `checkForOtaUpdate` would only run
 * once at mount, so a long-lived background session would never pick up a new
 * JS bundle. `reloadAsync()` (inside checkForOtaUpdate) does an in-app bundle
 * reload — the OS process is never killed — so from the user's side there's no
 * "close and reopen the app".
 */
export function OtaUpdateGate({ children }: { children: ReactNode }) {
  const lastCheckAtRef = useRef(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const runThrottledCheck = () => {
      const now = Date.now();
      if (now - lastCheckAtRef.current < MIN_CHECK_INTERVAL_MS) return;
      lastCheckAtRef.current = now;
      void checkForOtaUpdate();
    };

    // On cold launch.
    runThrottledCheck();

    // And on each background/inactive -> active transition.
    const subscription = AppState.addEventListener("change", (next) => {
      const previous = appStateRef.current;
      appStateRef.current = next;
      const cameToForeground =
        next === "active" &&
        (previous === "background" || previous === "inactive");
      if (cameToForeground) runThrottledCheck();
    });

    return () => subscription.remove();
  }, []);

  return <>{children}</>;
}
