import {
  buildTheme,
  getFontFamily,
  getTypographyStyle,
  resolveStatusBarStyle,
  theme,
  withAlpha,
} from "./theme";

/** Relative luminance per WCAG 2.1 §1.4.3. */
function relativeLuminance(hex: string): number {
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(hex.replace("#", "").substr(offset, 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Hue in degrees, so "five distinct accents" can be asserted as five hues. */
function hueOf(hex: string): number {
  const [red, green, blue] = [0, 2, 4].map(
    (offset) => parseInt(hex.replace("#", "").substr(offset, 2), 16) / 255,
  );
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const span = max - min;
  if (span === 0) return 0;
  if (max === red) return (60 * ((green - blue) / span) + 360) % 360;
  if (max === green) return 60 * ((blue - red) / span) + 120;
  return 60 * ((red - green) / span) + 240;
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Every background a foreground token can realistically land on, per mode.
const SURFACE_TOKENS = ["surface", "background", "surfaceAlt", "surfaceMuted"] as const;
// Tokens that render as TEXT. WCAG AA body text floor is 4.5:1.
const TEXT_TOKENS = ["text", "mutedText", "danger"] as const;
// Tokens that only ever render as icons/dots/dividers. WCAG 1.4.11 asks 3:1.
const NON_TEXT_TOKENS = ["subtleText"] as const;

/**
 * Home-screen tokens that render as TEXT on one of the four neutral surfaces.
 * Same 4.5:1 floor as TEXT_TOKENS — listed separately only because they arrived
 * with the dealer-home redesign.
 */
const HOME_TEXT_TOKENS = [
  "homeDeltaUp",
  "homeDeltaDown",
  "homeChipDangerText",
  "homeChipWarningText",
  "homeChipInfoText",
  "homeChipSuccessText",
] as const;

/**
 * Home-screen tokens that only ever render as an icon, an arc, or a divider.
 * 3:1 per WCAG 1.4.11.
 */
const HOME_NON_TEXT_TOKENS = [
  "homeKpiSalesIcon",
  "homeKpiExpenseIcon",
  "homeKpiProfitIcon",
  "homeTileViolet",
  "homeTileBlue",
  "homeTileAmber",
  "homeTileGreen",
  "homeTileIndigo",
  "homeRingArc",
] as const;

/**
 * Tone-on-its-own-tint pairs — the class the gate used to miss entirely.
 *
 * `warning` on `warningSoft` measured 2.86:1 in the light theme and nothing
 * caught it, because every check above compares a foreground against the four
 * NEUTRAL surfaces only. A tinted chip or panel is a surface too, and the tone
 * that fills it is usually the tone drawn on top of it.
 *
 * 3:1 here, not 4.5:1: these are the app-wide brand tones, and on their own
 * tints they appear as icons, borders and dots (WCAG 1.4.11). Tones that render
 * as TEXT on a tint are checked at 4.5:1 by HOME_TEXT_ON_TINT below.
 */
const TONE_ON_SOFT_PAIRS = [
  ["primary", "primarySoft"],
  ["accent", "accentSoft"],
  ["danger", "dangerSoft"],
  ["success", "successSoft"],
  ["info", "infoSoft"],
  ["indigo", "indigoSoft"],
  ["warning", "warningSoft"],
] as const;

/**
 * Home graphics measured against the tint they are actually drawn on, not
 * against the neutral surfaces. The KPI icons sit inside their own soft badge
 * and the ring arc sits on the ring track — checking them against `surface`
 * alone would be checking a background they never appear over. 3:1, per WCAG
 * 1.4.11.
 */
const HOME_NON_TEXT_ON_TINT = [
  ["homeKpiSalesIcon", "homeKpiSalesSoft"],
  ["homeKpiExpenseIcon", "homeKpiExpenseSoft"],
  ["homeKpiProfitIcon", "homeKpiProfitSoft"],
  ["homeRingArc", "homeRingTrack"],
] as const;

/** Home tones that render as TEXT on their own tint. WCAG AA, 4.5:1. */
const HOME_TEXT_ON_TINT = [
  ["homeChipDangerText", "homeChipDangerSurface"],
  ["homeChipWarningText", "homeChipWarningSurface"],
  ["homeChipInfoText", "homeChipInfoSurface"],
  ["homeChipSuccessText", "homeChipSuccessSurface"],
  ["homeAlertPanelTone", "homeAlertPanel"],
  ["homeAlertPanelTone", "homeAlertPanelRow"],
  ["homePaymentPanelTone", "homePaymentPanel"],
  ["homePaymentPanelTone", "homePaymentPanelRow"],
  ["homeBannerTitle", "homeBannerFrom"],
  ["homeBannerTitle", "homeBannerTo"],
  ["homeBannerBody", "homeBannerFrom"],
  ["homeBannerBody", "homeBannerTo"],
  ["homeBannerCtaText", "homeBannerFrom"],
  ["homeBannerCtaText", "homeBannerTo"],
] as const;

/** Every (foreground, background) pair below `floor`, named so a failure says which. */
function pairFailures(
  mode: "light" | "dark",
  pairs: ReadonlyArray<readonly [string, string]>,
  floor: number,
): string[] {
  const { colors } = buildTheme(mode) as { colors: Record<string, string> };
  const failures: string[] = [];
  for (const [foreground, background] of pairs) {
    const ratio = contrastRatio(colors[foreground], colors[background]);
    if (ratio < floor) {
      failures.push(`${mode}.${foreground} on ${background}: ${ratio.toFixed(2)}:1 < ${floor}:1`);
    }
  }
  return failures;
}

/** Every (token, surface) pair below `floor`, named so a regression says which. */
function contrastFailures(
  mode: "light" | "dark",
  tokens: readonly string[],
  floor: number,
): string[] {
  const { colors } = buildTheme(mode) as { colors: Record<string, string> };
  const failures: string[] = [];
  for (const token of tokens) {
    for (const surface of SURFACE_TOKENS) {
      const ratio = contrastRatio(colors[token], colors[surface]);
      if (ratio < floor) {
        failures.push(`${mode}.${token} on ${surface}: ${ratio.toFixed(2)}:1 < ${floor}:1`);
      }
    }
  }
  return failures;
}

describe("mobile theme tokens", () => {
  test.each(["light", "dark"] as const)(
    "%s text tokens clear the WCAG AA 4.5:1 floor on every surface",
    (mode) => {
      expect(contrastFailures(mode, TEXT_TOKENS, 4.5)).toEqual([]);
    },
  );

  test.each(["light", "dark"] as const)(
    "%s non-text tokens clear the WCAG 1.4.11 3:1 floor on every surface",
    (mode) => {
      expect(contrastFailures(mode, NON_TEXT_TOKENS, 3)).toEqual([]);
    },
  );

  test.each(["light", "dark"] as const)(
    "%s dealer-home text tokens clear the WCAG AA 4.5:1 floor on every surface",
    (mode) => {
      expect(contrastFailures(mode, HOME_TEXT_TOKENS, 4.5)).toEqual([]);
    },
  );

  test.each(["light", "dark"] as const)(
    "%s dealer-home icon tokens clear the WCAG 1.4.11 3:1 floor on every surface",
    (mode) => {
      expect(contrastFailures(mode, HOME_NON_TEXT_TOKENS, 3)).toEqual([]);
    },
  );

  // The hole this closes: nothing here compared a tone against its OWN tint, so
  // `warning` on `warningSoft` sat at 2.86:1 in the light theme unnoticed.
  test.each(["light", "dark"] as const)(
    "%s brand tones clear 3:1 against their own soft tint, not just the neutral surfaces",
    (mode) => {
      expect(pairFailures(mode, TONE_ON_SOFT_PAIRS, 3)).toEqual([]);
    },
  );

  test.each(["light", "dark"] as const)(
    "%s dealer-home tones that render as text on a tint clear 4.5:1 against that tint",
    (mode) => {
      expect(pairFailures(mode, HOME_TEXT_ON_TINT, 4.5)).toEqual([]);
    },
  );

  test.each(["light", "dark"] as const)(
    "%s dealer-home icons clear 3:1 against the tint they are drawn on",
    (mode) => {
      expect(pairFailures(mode, HOME_NON_TEXT_ON_TINT, 3)).toEqual([]);
    },
  );

  test("keeps subtleText visually lighter than mutedText so the hierarchy survives the contrast fix", () => {
    for (const mode of ["light", "dark"] as const) {
      const { colors } = buildTheme(mode);
      const towardCanvas = mode === "light" ? 1 : -1;
      expect(
        Math.sign(relativeLuminance(colors.subtleText) - relativeLuminance(colors.mutedText)),
      ).toBe(towardCanvas);
    }
  });


  // The previous pass at this screen reused the existing muted tones for all
  // five quick-action tiles, so they rendered as one pastel blue. The mock gives
  // each tile its own hue.
  test.each(["light", "dark"] as const)("%s gives every quick-action tile its own hue", (mode) => {
    const { colors } = buildTheme(mode);
    const accents = [
      colors.homeTileViolet,
      colors.homeTileBlue,
      colors.homeTileAmber,
      colors.homeTileGreen,
      colors.homeTileIndigo,
    ];

    expect(new Set(accents).size).toBe(accents.length);

    // Distinct *hues*, not five shades of one — and checked over EVERY pair, not
    // just adjacent ones. The mock uses violet twice, 3-5° apart, at opposite
    // ends of a fixed rail; AutoFlow's rail is permission-filtered, so those two
    // can land side by side and have to be told apart.
    const hues = accents.map(hueOf);
    const separations = hues.flatMap((hue, index) =>
      hues.slice(index + 1).map((other) => Math.abs(hue - other)),
    );
    expect(Math.min(...separations)).toBeGreaterThan(15);
  });

  test("ships the dark home palette exactly as measured from the design mock", () => {
    const { colors } = buildTheme("dark");

    // Not one dark token needed a contrast adjustment, so these are the mock's
    // own sampled values. A change here means the design drifted, not that a
    // WCAG floor moved.
    expect(colors.homeTileGreen).toBe("#47d25c");
    expect(colors.homeTileAmber).toBe("#faae27");
    expect(colors.homeRingArc).toBe("#3a6cf5");
    expect(colors.homeDeltaUp).toBe("#4fda57");
    expect(colors.homeBannerFrom).toBe("#262c82");
    expect(colors.homeBannerTo).toBe("#0a1939");
    // The dark mock washes these two panels; the light mock leaves them white.
    expect(colors.homeAlertPanel).toBe("#171714");
    expect(colors.homePaymentPanel).toBe("#0b1820");
    expect(buildTheme("light").colors.homeAlertPanel).toBe("#ffffff");
    expect(buildTheme("light").colors.homePaymentPanel).toBe("#ffffff");
  });

  test("renders a palette hex at an alpha for the icon glows", () => {
    expect(withAlpha("#47d25c", 0.35)).toBe("rgba(71, 210, 92, 0.35)");
    expect(withAlpha("#000000", 0)).toBe("rgba(0, 0, 0, 0)");
    expect(withAlpha("#ffffff", 1)).toBe("rgba(255, 255, 255, 1)");
  });

  test("keeps the brand color palette stable while expanding shape and depth tokens", () => {
    expect(theme.colors.primary).toBe("#2563eb");
    expect(theme.colors.accent).toBe("#ea580c");
    expect(theme.radius).toEqual({ sm: 10, md: 14, lg: 18, xl: 24, full: 999 });
    expect(theme.shadows.sm).toEqual(
      expect.objectContaining({
        shadowColor: "#0f172a",
        shadowOpacity: 0.05,
        elevation: 2,
      }),
    );
    expect(theme.shadows.md.elevation).toBe(4);
    expect(theme.shadows.lg.elevation).toBe(8);
  });

  test("builds both light and dark palettes, keeping brand hues, and maps the status bar", () => {
    const light = buildTheme("light");
    const dark = buildTheme("dark");

    // Default/active theme is light — the original app look.
    expect(theme.colors.background).toBe(light.colors.background);
    expect(light.colors.background).toBe("#f2f2f7");
    expect(light.colors.surface).toBe("#ffffff");
    // Dark flips the neutrals but keeps the brand blue/orange verbatim.
    expect(dark.colors.background).toBe("#0a0f1c");
    expect(dark.colors.primary).toBe("#3b82f6");
    expect(dark.colors.accent).toBe("#ea580c");
    // On-dark accent text uses a brighter same-hue glow; light keeps the base.
    expect(dark.colors.primaryGlow).toBe("#60a5fa");
    expect(light.colors.primaryGlow).toBe("#2563eb");
    // Non-color tokens are shared across themes.
    expect(dark.radius).toEqual(light.radius);

    expect(resolveStatusBarStyle("light")).toBe("dark");
    expect(resolveStatusBarStyle("dark")).toBe("light");
  });

  test("resolves typography families by locale and falls back when fonts are not ready", () => {
    expect(getFontFamily("en", "regular")).toBe("Inter_400Regular");
    expect(getFontFamily("ar", "bold")).toBe("Cairo_700Bold");
    expect(getFontFamily("en", "medium", false)).toBeUndefined();

    expect(getTypographyStyle("display", "en")).toEqual(
      expect.objectContaining({
        fontFamily: "Inter_700Bold",
        fontSize: 34,
        fontWeight: "700",
        lineHeight: 41,
      }),
    );
    expect(getTypographyStyle("heading", "ar")).toEqual(
      expect.objectContaining({
        fontFamily: "Cairo_600SemiBold",
        fontSize: 17,
        fontWeight: "600",
      }),
    );
    expect(getTypographyStyle("label", "en", false)).toEqual(
      expect.objectContaining({
        fontFamily: undefined,
        letterSpacing: 0.5,
        textTransform: "uppercase",
      }),
    );
  });
});
