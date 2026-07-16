import { nativeOrgTabs, type NativeOrgTab } from "@autoflow/shared";

export function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

export function normalizeOrgWorkspaceTab(value: string | string[] | undefined): NativeOrgTab {
  const candidate = firstParam(value);
  return nativeOrgTabs.find((tab) => tab === candidate) ?? "home";
}
