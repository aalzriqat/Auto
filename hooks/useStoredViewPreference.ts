"use client";

import { useCallback, useSyncExternalStore } from "react";

const PREFERENCE_CHANGE_EVENT = "autoflow:preference-change";
const memoryPreferences = new Map<string, string>();

export function useStoredViewPreference<T extends string>(
  storageKey: string,
  defaultValue: T,
  allowedValues: readonly T[]
) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const handleStorage = (event: StorageEvent) => {
        if (event.key !== storageKey) return;
        if (event.newValue === null) memoryPreferences.delete(storageKey);
        else memoryPreferences.set(storageKey, event.newValue);
        onStoreChange();
      };
      const handlePreferenceChange = (event: Event) => {
        if (event instanceof CustomEvent && event.detail === storageKey) {
          onStoreChange();
        }
      };

      window.addEventListener("storage", handleStorage);
      window.addEventListener(PREFERENCE_CHANGE_EVENT, handlePreferenceChange);
      return () => {
        window.removeEventListener("storage", handleStorage);
        window.removeEventListener(PREFERENCE_CHANGE_EVENT, handlePreferenceChange);
      };
    },
    [storageKey]
  );

  const getSnapshot = useCallback(() => {
    let storedValue = memoryPreferences.get(storageKey) ?? null;
    if (storedValue === null) {
      try {
        storedValue = window.localStorage.getItem(storageKey);
      } catch {
        // The default keeps the control usable when browser storage is unavailable.
      }
    }
    return storedValue && allowedValues.some((allowedValue) => allowedValue === storedValue)
      ? (storedValue as T)
      : defaultValue;
  }, [allowedValues, defaultValue, storageKey]);

  const getServerSnapshot = useCallback(() => defaultValue, [defaultValue]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setStoredValue = useCallback(
    (nextValue: T) => {
      memoryPreferences.set(storageKey, nextValue);
      try {
        window.localStorage.setItem(storageKey, nextValue);
      } catch {
        // The preference remains active for this session through the in-memory store.
      }
      window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGE_EVENT, { detail: storageKey }));
    },
    [storageKey]
  );

  return [value, setStoredValue] as const;
}
