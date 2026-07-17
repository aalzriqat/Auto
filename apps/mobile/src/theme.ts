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
  // Premium dark ("automotive") theme. The brand hues (teal `primary`, orange
  // `accent`) are preserved verbatim — only the neutral canvas/surfaces/tints
  // were flipped to dark, and brighter same-hue *Glow tokens were added for
  // accent TEXT that needs to stay legible on a near-black background.
  colors: {
    background: "#0a0f1c",
    surface: "#141b2b",
    surfaceAlt: "#1e2739",
    surfaceMuted: "#111828",
    border: "#28324a",
    borderStrong: "#3b475f",
    text: "#f2f5fb",
    mutedText: "#9db0cb",
    subtleText: "#6b7a95",
    // Brand teal — kept exactly. Used as a FILL (buttons/selected chips) with
    // white `onPrimary` text on top; `primaryGlow` is its on-dark text variant.
    primary: "#0f766e",
    primaryDark: "#134e4a",
    primarySoft: "#0f3a37",
    onPrimary: "#ffffff",
    // Brand orange — kept exactly. `accentGlow` is the on-dark text variant.
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
    // Premium dark-theme additions (same hues, tuned for dark contrast + depth).
    primaryGlow: "#2dd4bf",
    accentGlow: "#fb923c",
    glassBg: "rgba(255,255,255,0.05)",
    glassStrong: "rgba(255,255,255,0.08)",
    glassBorder: "rgba(255,255,255,0.10)",
    overlayScrim: "rgba(4,8,16,0.66)",
  },
  gradients: {
    // teal -> cyan -> indigo: the signature hero band used on first-launch surfaces.
    hero: ["#0f766e", "#0e7490", "#1e3a8a"],
    heroDeep: ["#0f2a2e", "#0b1220"],
    price: ["#2dd4bf", "#0f766e"],
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
