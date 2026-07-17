import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";

export type PermissionOutcome = { granted: boolean; canAskAgain: boolean };

/**
 * Request-on-use permission helpers. Call each right before the action that
 * needs it (opening the camera, the gallery, reading location) rather than up
 * front — that's both the platform-recommended pattern and what keeps the OS
 * prompts meaningful. Each checks the current grant first so a
 * already-authorized user is never re-prompted.
 */

export async function ensureCameraPermission(): Promise<PermissionOutcome> {
  const current = await ImagePicker.getCameraPermissionsAsync();
  if (current.granted) return { granted: true, canAskAgain: current.canAskAgain };
  const next = await ImagePicker.requestCameraPermissionsAsync();
  return { granted: next.granted, canAskAgain: next.canAskAgain };
}

export async function ensurePhotoLibraryPermission(): Promise<PermissionOutcome> {
  const current = await ImagePicker.getMediaLibraryPermissionsAsync();
  if (current.granted) return { granted: true, canAskAgain: current.canAskAgain };
  const next = await ImagePicker.requestMediaLibraryPermissionsAsync();
  return { granted: next.granted, canAskAgain: next.canAskAgain };
}

export async function ensureLocationPermission(): Promise<PermissionOutcome> {
  const current = await Location.getForegroundPermissionsAsync();
  if (current.granted) return { granted: true, canAskAgain: current.canAskAgain };
  const next = await Location.requestForegroundPermissionsAsync();
  return { granted: next.granted, canAskAgain: next.canAskAgain };
}
