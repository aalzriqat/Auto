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

export const theme = {
  colors: {
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
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
  },
  radius: {
    sm: 10,
    md: 14,
    lg: 18,
    xl: 24,
    full: 999,
  },
  shadows: {
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
  },
  fontFamilies,
  typography: {
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
  },
} as const;

const typographyWeights = {
  display: "bold",
  title: "bold",
  heading: "semibold",
  body: "regular",
  caption: "regular",
  label: "medium",
} as const satisfies Record<keyof typeof theme.typography, TypographyWeight>;

export type TypographyVariant = keyof typeof theme.typography;

export function getFontFamily(
  locale: FontLocale,
  weight: TypographyWeight,
  fontsLoaded = true,
): string | undefined {
  if (!fontsLoaded) {
    return theme.fontFamilies.system[weight];
  }

  return theme.fontFamilies[locale][weight];
}

export function getTypographyStyle(
  variant: TypographyVariant,
  locale: FontLocale,
  fontsLoaded = true,
) {
  return {
    ...theme.typography[variant],
    fontFamily: getFontFamily(locale, typographyWeights[variant], fontsLoaded),
  };
}
