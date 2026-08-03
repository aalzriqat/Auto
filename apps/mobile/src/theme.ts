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
  // Secondary text. Must clear WCAG AA (4.5:1) against EVERY light surface it
  // can land on, not just white: the old #64748b measured 4.17:1 on surfaceAlt
  // (#eef0f5), so the app's most common secondary-text token was failing on the
  // card/chip backgrounds it appears on most. #5c6b80 is 4.76:1 at its worst.
  mutedText: "#5c6b80",
  // NON-TEXT only (icons, presence dots, chevrons) — WCAG 1.4.11 asks 3:1 for
  // those, which #94a3b8 (2.25:1 worst case) also failed. Anything that renders
  // as *text* uses mutedText instead; see the contrast gate in theme.test.ts.
  subtleText: "#7c8ba3",
  primary: "#2563eb",
  primaryDark: "#1e40af",
  primarySoft: "#dbeafe",
  onPrimary: "#ffffff",
  accent: "#ea580c",
  accentSoft: "#ffedd5",
  // Renders as text (inline field errors, destructive labels) as well as a
  // button fill. #e11d48 was 4.12:1 at worst on light surfaces and 3.91:1 on
  // dangerSoft — below AA in exactly the place a user must not miss.
  danger: "#be123c",
  dangerSoft: "#ffe4e6",
  success: "#16a34a",
  successSoft: "#dcfce7",
  info: "#0284c7",
  infoSoft: "#e0f2fe",
  indigo: "#4f46e5",
  indigoSoft: "#e0e7ff",
  // #d97706 measured 2.86:1 against its own warningSoft — under the 3:1 WCAG
  // 1.4.11 floor, and the reason HomePanels used to exclude `warning` from the
  // icon tones entirely. Two lightness steps down the same hue clears it (3.01:1)
  // without touching saturation. See the tone-on-soft gate in theme.test.ts.
  warning: "#d37406",
  warningSoft: "#fef3c7",
  hero: "#0f172a",
  heroAlt: "#1e3a8a",
  // On light surfaces the "glow" accents ARE the base brand colors (legible on
  // white); the gradient hero is dark in both themes so glass stays the same.
  primaryGlow: "#2563eb",
  accentGlow: "#ea580c",
  glassBg: "rgba(255,255,255,0.05)",
  glassStrong: "rgba(255,255,255,0.08)",
  glassBorder: "rgba(255,255,255,0.10)",
  overlayScrim: "rgba(15,23,42,0.42)",

  // ── Dealer-home visual language ────────────────────────────────────────────
  // Sampled from DESIGN-light.png with PIL (medians over flat regions, ink taken
  // as the most-different decile inside each glyph run). Every value below is
  // the mock's own, EXCEPT where it failed a WCAG floor as text — those carry
  // the before/after ratio inline and moved lightness only, never hue.
  //
  // The one deliberate departure from the mock is elevation, and it lives above,
  // not here: the mock paints card #fefefe on page #fdfdfe (1.009:1, invisible
  // in daylight), so `background`/`surface` keep the app's 1.116:1 pairing.
  homeCardBorder: "#eaecf2",
  homeKpiSalesIcon: "#0043f8",
  homeKpiSalesSoft: "#eef4fe",
  homeKpiExpenseIcon: "#f15800", // mock #fe5d00 — 2.72:1 on surfaceAlt, now 3.00:1
  homeKpiExpenseSoft: "#fef3e9",
  homeKpiProfitIcon: "#0aa028", // mock #0aa128 — 3.00:1, now 3.03:1
  homeKpiProfitSoft: "#eaf8ee",
  homeDeltaUp: "#067e3c", // mock #089c4a — 3.14:1, now 4.54:1
  homeDeltaDown: "#dc0515", // mock #f80618 — 3.66:1, now 4.52:1
  homeTileViolet: "#4524f3",
  homeTileBlue: "#007cd1",
  homeTileAmber: "#d76e00", // mock #fd8100 — 2.21:1, now 3.01:1
  homeTileGreen: "#09a123", // mock #09a624 — 2.84:1, now 3.00:1
  homeTileIndigo: "#4d1ff5",
  homeRingTrack: "#e7ecf6",
  homeRingArc: "#0957f9",
  homeChipDangerSurface: "#fdeaef",
  homeChipDangerText: "#db000d", // mock #f9000f — 3.61:1, now 4.53:1
  homeChipWarningSurface: "#fdf0e0",
  homeChipWarningText: "#b15201", // mock #fe7a08 — 2.30:1, now 4.52:1
  homeChipInfoSurface: "#eaf0fe",
  homeChipInfoText: "#0c52f8",
  homeChipSuccessSurface: "#e9f5ee",
  homeChipSuccessText: "#067e3c", // mock #089c4a — 3.14:1, now 4.54:1
  homeChipBorder: "#e7eaf1",
  // The banner is all but flat in the light mock (#eff3fe end to end); the two
  // deeper stops keep it a gradient rather than inventing one.
  homeBannerFrom: "#eff3fe",
  homeBannerMid: "#e7eefd",
  homeBannerTo: "#dce6fc",
  homeBannerIconFrom: "#dbe3fb",
  homeBannerIconTo: "#c3d1f8",
  homeBannerTitle: "#0f172a",
  homeBannerBody: "#4c5a6f",
  homeBannerCtaText: "#1d4fd8",
  homeBannerCtaBorder: "#b3c6f4",
  // The mock leaves both of these panels white in the light theme and washes
  // them amber / green only in the dark one — see darkColors below.
  homeAlertPanel: "#ffffff",
  homeAlertPanelRow: "#f7f9fc",
  homeAlertPanelBorder: "#e6e9f0",
  homeAlertPanelTone: "#b15201",
  homePaymentPanel: "#ffffff",
  homePaymentPanelRow: "#f2f6fe",
  homePaymentPanelBorder: "#e3e8f2",
  homePaymentPanelTone: "#067e3c",
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
  primary: "#3b82f6",
  primaryDark: "#1d4ed8",
  primarySoft: "#17233f",
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
  heroAlt: "#1e3a8a",
  primaryGlow: "#60a5fa",
  accentGlow: "#fb923c",
  glassBg: "rgba(255,255,255,0.05)",
  glassStrong: "rgba(255,255,255,0.08)",
  glassBorder: "rgba(255,255,255,0.10)",
  overlayScrim: "rgba(4,8,16,0.66)",

  // ── Dealer-home visual language ────────────────────────────────────────────
  // Sampled from DESIGN-dark.png. Not one of these needed a contrast
  // adjustment: every text token clears 4.5:1 and every icon token 3:1 on the
  // dark surfaces, so the dark theme ships the mock's palette verbatim.
  homeCardBorder: "#172031",
  homeKpiSalesIcon: "#5492fc",
  homeKpiSalesSoft: "#132443",
  homeKpiExpenseIcon: "#f87e16",
  homeKpiExpenseSoft: "#34271c",
  homeKpiProfitIcon: "#48c258",
  homeKpiProfitSoft: "#112226",
  homeDeltaUp: "#4fda57",
  homeDeltaDown: "#f45959",
  homeTileViolet: "#8561f4",
  homeTileBlue: "#2f86f5",
  homeTileAmber: "#faae27",
  homeTileGreen: "#47d25c",
  homeTileIndigo: "#7c63f2",
  homeRingTrack: "#1a2536",
  homeRingArc: "#3a6cf5",
  // Only the overdue chip is washed in the dark mock; the other three sit on a
  // neutral raised surface and take their identity from the numeral alone.
  homeChipDangerSurface: "#1e1a29",
  homeChipDangerText: "#ff706c",
  homeChipWarningSurface: "#151e2c",
  homeChipWarningText: "#ffb512",
  homeChipInfoSurface: "#131d2e",
  homeChipInfoText: "#7a9efa",
  homeChipSuccessSurface: "#121c2a",
  homeChipSuccessText: "#51da5e",
  homeChipBorder: "#1d2a3c",
  // Diagonal, top-start indigo to bottom-end navy. Sampled at t=0/0.5/1 along
  // the banner's own axis: #262c82 → #132256 → #0a1939.
  homeBannerFrom: "#262c82",
  homeBannerMid: "#132256",
  homeBannerTo: "#0a1939",
  homeBannerIconFrom: "#5b63ea",
  homeBannerIconTo: "#4247b4",
  homeBannerTitle: "#f5f7ff",
  homeBannerBody: "#c3c6d4",
  homeBannerCtaText: "#bbcefd",
  homeBannerCtaBorder: "#3a46a8",
  homeAlertPanel: "#171714",
  homeAlertPanelRow: "#29251b",
  homeAlertPanelBorder: "#3a3116",
  homeAlertPanelTone: "#ffc71e",
  homePaymentPanel: "#0b1820",
  homePaymentPanelRow: "#0e2123",
  homePaymentPanelBorder: "#16342c",
  homePaymentPanelTone: "#4fde59",
} as const;

const gradients = {
  // royal blue band: the signature hero (dark in both themes).
  hero: ["#1e3a8a", "#1d4ed8", "#2563eb"],
  heroDeep: ["#152449", "#0b1220"],
  price: ["#60a5fa", "#1d4ed8"],
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

/**
 * A palette hex as an `rgba()` string.
 *
 * The home screen's icon glows are radial-gradient stops that fade the tile's
 * own accent to nothing, so they need the accent at a series of alphas rather
 * than a second, pre-blended token per accent per theme.
 */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
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
