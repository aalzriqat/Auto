import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";

import { useStoredViewPreference } from "./useStoredViewPreference";

const OPTIONS = ["table", "cards"] as const;
const STORAGE_KEY = "autoflow:test:view";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("useStoredViewPreference", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  test("invalid stored preference falls back to a supported default", () => {
    window.localStorage.setItem(STORAGE_KEY, "unsupported");
    const { result } = renderHook(() =>
      useStoredViewPreference(STORAGE_KEY, "table", OPTIONS)
    );

    expect(result.current[0]).toBe("table");
  });

  test("persists changes and synchronizes mounted consumers", () => {
    const first = renderHook(() =>
      useStoredViewPreference(STORAGE_KEY, "table", OPTIONS)
    );
    const second = renderHook(() =>
      useStoredViewPreference(STORAGE_KEY, "table", OPTIONS)
    );

    act(() => first.result.current[1]("cards"));

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("cards");
    expect(first.result.current[0]).toBe("cards");
    expect(second.result.current[0]).toBe("cards");
  });
});
