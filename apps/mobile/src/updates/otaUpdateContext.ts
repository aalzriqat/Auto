import { createContext, useContext } from "react";

// The lifecycle of an OTA update as the UI needs to see it. "ready" means a
// newer JS bundle has already been downloaded and is waiting for the user to
// apply it (or for the next cold start, which expo-updates applies on its own).
export type OtaUpdateStatus = "idle" | "checking" | "ready" | "upToDate" | "error";

export interface OtaUpdateContextValue {
  status: OtaUpdateStatus;
  // A fetched bundle is waiting to be activated.
  updateReady: boolean;
  // updateReady AND the user hasn't dismissed the prompt this session.
  promptVisible: boolean;
  // Manually re-check now (ignores the background throttle).
  checkForUpdate: () => Promise<void>;
  // Reload the JS bundle into the fetched update ("Update now").
  applyUpdate: () => Promise<void>;
  // Hide the prompt for now ("Later"); the update still applies on next launch.
  dismissPrompt: () => void;
}

const noop = async () => {};

// A working default so consumers (the account "Check for updates" row, the
// prompt) never crash when rendered without the provider — e.g. in unit tests
// that mount a screen in isolation. In the real app the provider supplies live
// values.
export const OtaUpdateContext = createContext<OtaUpdateContextValue>({
  status: "idle",
  updateReady: false,
  promptVisible: false,
  checkForUpdate: noop,
  applyUpdate: noop,
  dismissPrompt: () => {},
});

export function useOtaUpdate(): OtaUpdateContextValue {
  return useContext(OtaUpdateContext);
}
