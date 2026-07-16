import { createContext, useContext, type ReactNode } from "react";

export type AppFontState = Readonly<{
  fontsLoaded: boolean;
}>;

const AppFontContext = createContext<AppFontState>({ fontsLoaded: false });

export function AppFontStateProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: AppFontState;
}) {
  return <AppFontContext.Provider value={value}>{children}</AppFontContext.Provider>;
}

export function useAppFontState(): AppFontState {
  return useContext(AppFontContext);
}
