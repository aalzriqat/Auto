import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";

import {
  OtaUpdateContext,
  type OtaUpdateContextValue,
  type OtaUpdateStatus,
} from "./otaUpdateContext";
import { fetchOtaUpdateIfAvailable, reloadIntoOtaUpdate } from "./otaUpdates";

// Don't re-hit the update server on every quick app-switch. A user tabbing out
// to copy a phone number and straight back shouldn't trigger a check; a genuine
// "came back after a while" will be well past this window.
const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Runs the over-the-air update check on launch AND every time the app returns
 * to the foreground, and exposes the result through {@link OtaUpdateContext} so
 * the UI can prompt the user instead of yanking them into a reload.
 *
 * The behavior deliberately differs from a silent auto-reload: when a new bundle
 * is found it is downloaded and held in "ready" state. The user then chooses to
 * apply it now (via the prompt / the account "Check for updates" row) or later —
 * and expo-updates activates the already-fetched bundle on the next cold start
 * regardless, so "Later" defers the update, it never discards it.
 *
 * The foreground check covers users who keep the app backgrounded for days and
 * never cold-launch it: without it, the check would only run once at mount.
 */
export function OtaUpdateGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<OtaUpdateStatus>("idle");
  const [updateReady, setUpdateReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const lastCheckAtRef = useRef(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const inFlightRef = useRef(false);

  // The single source of truth for a check. Guards against overlapping runs
  // (e.g. a manual tap racing a foreground check) so status can't thrash.
  const runCheck = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStatus("checking");
    try {
      const ready = await fetchOtaUpdateIfAvailable();
      if (ready) {
        setUpdateReady(true);
        // A freshly fetched bundle re-surfaces the prompt even if the user
        // dismissed a previous one.
        setDismissed(false);
        setStatus("ready");
      } else {
        setStatus("upToDate");
      }
    } catch {
      setStatus("error");
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  const checkForUpdate = useCallback(async () => {
    lastCheckAtRef.current = Date.now();
    await runCheck();
  }, [runCheck]);

  const applyUpdate = useCallback(async () => {
    await reloadIntoOtaUpdate();
  }, []);

  const dismissPrompt = useCallback(() => setDismissed(true), []);

  useEffect(() => {
    const runThrottledCheck = () => {
      const now = Date.now();
      if (now - lastCheckAtRef.current < MIN_CHECK_INTERVAL_MS) return;
      lastCheckAtRef.current = now;
      void runCheck();
    };

    // On cold launch.
    runThrottledCheck();

    // And on each background/inactive -> active transition.
    const subscription = AppState.addEventListener("change", (next) => {
      const previous = appStateRef.current;
      appStateRef.current = next;
      const cameToForeground =
        next === "active" && (previous === "background" || previous === "inactive");
      if (cameToForeground) runThrottledCheck();
    });

    return () => subscription.remove();
  }, [runCheck]);

  const value = useMemo<OtaUpdateContextValue>(
    () => ({
      status,
      updateReady,
      promptVisible: updateReady && !dismissed,
      checkForUpdate,
      applyUpdate,
      dismissPrompt,
    }),
    [status, updateReady, dismissed, checkForUpdate, applyUpdate, dismissPrompt],
  );

  return <OtaUpdateContext.Provider value={value}>{children}</OtaUpdateContext.Provider>;
}
