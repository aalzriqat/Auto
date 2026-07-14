export const nativeRoutes = {
  home: "/",
  marketplace: "/marketplace",
  signIn: "/sign-in",
} as const;

export type NativeRouteName = keyof typeof nativeRoutes;
export type NativeRoutePath = (typeof nativeRoutes)[NativeRouteName];
