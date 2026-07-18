import { Image, StyleSheet, Text, View, type ImageStyle, type StyleProp, type ViewStyle } from "react-native";

import { useThemedStyles } from "../providers/ThemeProvider";
import { type AppTheme } from "../theme";

export function MemberAvatar({
  imageUrl,
  name,
  size = 44,
  style,
  testID,
}: Readonly<{ imageUrl?: string; name: string; size?: number; style?: StyleProp<ViewStyle>; testID?: string }>) {
  const styles = useThemedStyles(makeStyles);
  const dimensionStyle = { width: size, height: size, borderRadius: size / 2 };

  if (imageUrl) {
    return (
      <Image
        source={{ uri: imageUrl }}
        style={[styles.avatarImage, dimensionStyle, style as StyleProp<ImageStyle>]}
        testID={testID}
      />
    );
  }

  return (
    <View style={[styles.avatar, dimensionStyle, style]} testID={testID}>
      <Text style={[styles.avatarText, { fontSize: Math.max(10, size / 3) }]}>{name.slice(0, 2).toUpperCase() || "?"}</Text>
    </View>
  );
}

const makeStyles = (theme: AppTheme) => StyleSheet.create({
  avatar: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceAlt,
  },
  avatarImage: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  avatarText: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: "700",
  },
});
