export const nativeRoutes = {
  home: "/",
  marketplace: "/marketplace",
  signIn: "/sign-in",
  orgHome: "/org/[orgId]/home",
  orgOperations: "/org/[orgId]/operations",
  orgPipeline: "/org/[orgId]/pipeline",
  orgFinance: "/org/[orgId]/finance",
  orgAdmin: "/org/[orgId]/admin",
  orgMarketplace: "/org/[orgId]/marketplace",
  orgModule: "/org/[orgId]/module/[moduleId]",
} as const;

export const nativeOrgTabs = ["home", "operations", "pipeline", "finance", "admin"] as const;

export type NativeRouteName = keyof typeof nativeRoutes;
export type NativeRoutePath = (typeof nativeRoutes)[NativeRouteName];
export type NativeOrgTab = (typeof nativeOrgTabs)[number];
