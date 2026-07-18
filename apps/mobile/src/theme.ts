import { type ThemeMode } from "./themeMode";

export type { ThemeMode };
export type FontLocale = "en" | "ar";
export type TypographyWeight = "regular" | "medium" | "semibold" | "bold";

const fontFamilies = {
  en: {
    regular: "Inter_400Regular",
    medium: "Inter_500Medium",
    semibold: "Inter_600SemiBold",
    bold: "Inter_700Bold",
  },
  ar: {
    regular: "Cairo_400Regular",
    medium: "Cairo_600SemiBold",
    semibold: "Cairo_600SemiBold",
    bold: "Cairo_700Bold",
  },
  system: {
    regular: undefined,
    medium: undefined,
    semibold: undefined,
    bold: undefined,
  },
} as const;

// The original light theme — the app's default. Brand hues (teal primary,
// orange accent) are the source of truth; the *Glow tokens here equal the base
// brand colors so accent text reads exactly as it did before dark mode existed.
const lightColors = {
  background: "#f2f2f7",
  surface: "#ffffff",
  surfaceAlt: "#eef0f5",
  surfaceMuted: "#f7f7fa",
  border: "#e3e3e9",
  borderStrong: "#d1d1d6",
  text: "#0f172a",
  mutedText: "#64748b",
  subtleText: "#94a3b8",
  primary: "#0f766e",
  primaryDark: "#134e4a",
  primarySoft: "#ccfbf1",
  onPrimary: "#ffffff",
  accent: "#ea580c",
  accentSoft: "#ffedd5",
  danger: "#e11d48",
  dangerSoft: "#ffe4e6",
  success: "#16a34a",
  successSoft: "#dcfce7",
  info: "#0284c7",
  infoSoft: "#e0f2fe",
  indigo: "#4f46e5",
  indigoSoft: "#e0e7ff",
  warning: "#d97706",
  warningSoft: "#fef3c7",
  hero: "#0f172a",
  heroAlt: "#0e7490",
  // On light surfaces the "glow" accents ARE the base brand colors (legible on
  // white); the gradient hero is dark in both themes so glass stays the same.
  primaryGlow: "#0f766e",
  accentGlow: "#ea580c",
  glassBg: "rgba(255,255,255,0.05)",
  glassStrong: "rgba(255,255,255,0.08)",
  glassBorder: "rgba(255,255,255,0.10)",
  overlayScrim: "rgba(15,23,42,0.42)",
} as const;

// Premium dark ("automotive") theme. Same brand hues; only the neutral canvas /
// surfaces / tints move to dark, plus brighter same-hue *Glow accents so text
// stays legible on near-black.
const darkColors = {
  background: "#0a0f1c",
  surface: "#141b2b",
  surfaceAlt: "#1e2739",
  surfaceMuted: "#111828",
  border: "#28324a",
  borderStrong: "#3b475f",
  text: "#f2f5fb",
  mutedText: "#9db0cb",
  subtleText: "#6b7a95",
  primary: "#0f766e",
  primaryDark: "#134e4a",
  primarySoft: "#0f3a37",
  onPrimary: "#ffffff",
  accent: "#ea580c",
  accentSoft: "#3a2414",
  danger: "#fb7185",
  dangerSoft: "#3a1c23",
  success: "#34d399",
  successSoft: "#123528",
  info: "#38bdf8",
  infoSoft: "#0e2b3e",
  indigo: "#818cf8",
  indigoSoft: "#20264a",
  warning: "#fbbf24",
  warningSoft: "#332a10",
  hero: "#0b1220",
  heroAlt: "#0e7490",
  primaryGlow: "#2dd4bf",
  accentGlow: "#fb923c",
  glassBg: "rgba(255,255,255,0.05)",
  glassStrong: "rgba(255,255,255,0.08)",
  glassBorder: "rgba(255,255,255,0.10)",
  overlayScrim: "rgba(4,8,16,0.66)",
} as const;

const gradients = {
  // teal -> cyan -> indigo: the signature hero band (dark in both themes).
  hero: ["#0f766e", "#0e7490", "#1e3a8a"],
  heroDeep: ["#0f2a2e", "#0b1220"],
  price: ["#2dd4bf", "#0f766e"],
} as const;

const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  full: 999,
} as const;

const shadows = {
  sm: {
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 2,
  },
  md: {
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.07,
    shadowRadius: 18,
    elevation: 4,
  },
  lg: {
    shadowColor: "#0f172a",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.1,
    shadowRadius: 26,
    elevation: 8,
  },
} as const;

const typography = {
  display: {
    fontFamily: fontFamilies.en.bold,
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -0.6,
    lineHeight: 41,
  },
  title: {
    fontFamily: fontFamilies.en.bold,
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.3,
    lineHeight: 30,
  },
  heading: {
    fontFamily: fontFamilies.en.semibold,
    fontSize: 17,
    fontWeight: "600",
    lineHeight: 24,
  },
  body: {
    fontFamily: fontFamilies.en.regular,
    fontSize: 16,
    fontWeight: "400",
    lineHeight: 23,
  },
  caption: {
    fontFamily: fontFamilies.en.regular,
    fontSize: 13,
    fontWeight: "400",
    lineHeight: 18,
  },
  label: {
    fontFamily: fontFamilies.en.medium,
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: 0.5,
    lineHeight: 16,
    textTransform: "uppercase",
  },
} as const;

/** Assemble the theme for a given mode. Non-color tokens are shared. */
export function buildTheme(mode: ThemeMode) {
  return {
    colors: mode === "dark" ? darkColors : lightColors,
    gradients,
    spacing,
    radius,
    shadows,
    fontFamilies,
    typography,
  };
}

/** StatusBar content color: dark glyphs on the light theme, light on dark. */
export function resolveStatusBarStyle(mode: ThemeMode): "light" | "dark" {
  return mode === "dark" ? "light" : "dark";
}

export type AppTheme = ReturnType<typeof buildTheme>;

// Static fallback (light). The LIVE theme comes from ThemeProvider / useAppTheme;
// this remains for mode-independent tokens (spacing/radius/typography/gradients)
// and any static stylesheet not yet migrated to the reactive hook.
export const theme = buildTheme("light");

const typographyWeights = {
  display: "bold",
  title: "bold",
  heading: "semibold",
  body: "regular",
  caption: "regular",
  label: "medium",
} as const satisfies Record<keyof typeof typography, TypographyWeight>;

export type TypographyVariant = keyof typeof typography;

export function getFontFamily(
  locale: FontLocale,
  weight: TypographyWeight,
  fontsLoaded = true,
): string | undefined {
  if (!fontsLoaded) {
    return fontFamilies.system[weight];
  }

  return fontFamilies[locale][weight];
}

export function getTypographyStyle(
  variant: TypographyVariant,
  locale: FontLocale,
  fontsLoaded = true,
) {
  return {
    ...typography[variant],
    fontFamily: getFontFamily(locale, typographyWeights[variant], fontsLoaded),
  };
}
