import { Ionicons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import type { StyleProp, TextStyle } from "react-native";

import { useLocale } from "../providers/LocaleProvider";
import { useAppTheme } from "../providers/ThemeProvider";
import { type AppTheme } from "../theme";

export type IoniconGlyphName = ComponentProps<typeof Ionicons>["name"];

export const semanticIconGlyphs = {
  accounting: "calculator-outline",
  admin: "settings-outline",
  applications: "document-text-outline",
  approvals: "shield-checkmark-outline",
  approvalsFilled: "shield-checkmark",
  back: "chevron-back",
  billing: "card-outline",
  branches: "business-outline",
  calendar: "calendar-outline",
  call: "call-outline",
  check: "checkmark",
  checkDone: "checkmark-done",
  chevronDown: "chevron-down",
  chevronForward: "chevron-forward",
  chevronUp: "chevron-up",
  close: "close",
  commissionSettings: "options-outline",
  commissions: "medal-outline",
  customFields: "create-outline",
  customers: "people-outline",
  dashboard: "speedometer-outline",
  expenses: "receipt-outline",
  feedback: "chatbubble-ellipses-outline",
  calculator: "calculator-outline",
  compare: "git-compare-outline",
  finance: "wallet-outline",
  financeCompanies: "business-outline",
  filter: "filter-outline",
  heart: "heart-outline",
  heartFilled: "heart",
  home: "home-outline",
  person: "person-outline",
  inbox: "file-tray-full-outline",
  integrations: "extension-puzzle-outline",
  language: "language-outline",
  leadSources: "megaphone-outline",
  leads: "git-branch-outline",
  marketplace: "storefront-outline",
  marketplaceSettings: "storefront-outline",
  messages: "chatbubbles-outline",
  more: "ellipsis-horizontal-circle-outline",
  notifications: "notifications-outline",
  notificationsFilled: "notifications",
  photos: "images-outline",
  operations: "grid-outline",
  pipeline: "git-merge-outline",
  pipelineSettings: "git-network-outline",
  quotes: "document-text-outline",
  refresh: "refresh",
  reports: "bar-chart-outline",
  updateAvailable: "cloud-download-outline",
  roles: "key-outline",
  sales: "pricetags-outline",
  save: "save-outline",
  search: "search",
  settings: "settings-outline",
  share: "share-social-outline",
  socialInbox: "logo-instagram",
  sort: "swap-vertical-outline",
  sourcing: "cube-outline",
  tasks: "checkbox-outline",
  tasksFilled: "checkbox",
  team: "people-circle-outline",
  themeDark: "moon-outline",
  themeLight: "sunny-outline",
  today: "sunny-outline",
  valuationCompanies: "scale-outline",
  vehicles: "car-sport-outline",
  website: "globe-outline",
  whatsapp: "logo-whatsapp",
} as const satisfies Record<string, IoniconGlyphName>;

const rtlIconGlyphs: Partial<Record<IoniconGlyphName, IoniconGlyphName>> = {
  "arrow-back": "arrow-forward",
  "arrow-forward": "arrow-back",
  "chevron-back": "chevron-forward",
  "chevron-forward": "chevron-back",
} as const;

export type SemanticIconName = keyof typeof semanticIconGlyphs;
export type IconColorToken = keyof AppTheme["colors"];

type IconProps = Readonly<{
  accessibilityLabel?: string;
  color?: IconColorToken;
  name: SemanticIconName;
  size?: number;
  style?: StyleProp<TextStyle>;
  testID?: string;
}>;

export function resolveIconGlyph(name: SemanticIconName, isRtl: boolean): IoniconGlyphName {
  const glyph = semanticIconGlyphs[name];
  return isRtl ? (rtlIconGlyphs[glyph] ?? glyph) : glyph;
}

export function Icon({
  accessibilityLabel,
  color = "text",
  name,
  size = 20,
  style,
  testID,
}: IconProps) {
  const { isRtl } = useLocale();
  const theme = useAppTheme();

  return (
    <Ionicons
      accessibilityLabel={accessibilityLabel}
      accessible={Boolean(accessibilityLabel)}
      color={theme.colors[color]}
      name={resolveIconGlyph(name, isRtl)}
      size={size}
      style={style}
      testID={testID}
    />
  );
}
