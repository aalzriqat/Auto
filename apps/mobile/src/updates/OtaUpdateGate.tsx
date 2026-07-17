import { useEffect, type ReactNode } from "react";

import { checkForOtaUpdate } from "./otaUpdates";

/**
 * Runs the over-the-air update check once on launch, then renders its children
 * untouched. A side-effect gate, like PushNotificationsGate — kept separate so
 * OTA (no auth needed) and push (auth needed) stay independent.
 */
export function OtaUpdateGate({ children }: { children: ReactNode }) {
  useEffect(() => {
    void checkForOtaUpdate();
  }, []);

  return <>{children}</>;
}
