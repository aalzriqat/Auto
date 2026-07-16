import { Image, StyleSheet, Text, View } from "react-native";

import { theme } from "../theme";

export function MemberAvatar({
  imageUrl,
  name,
  size = 44,
  testID,
}: Readonly<{ imageUrl?: string; name: string; size?: number; testID?: string }>) {
  const dimensionStyle = { width: size, height: size, borderRadius: size / 2 };

  if (imageUrl) {
    return <Image source={{ uri: imageUrl }} style={[styles.avatarImage, dimensionStyle]} testID={testID} />;
  }

  return (
    <View style={[styles.avatar, dimensionStyle]} testID={testID}>
      <Text style={styles.avatarText}>{name.slice(0, 2).toUpperCase() || "?"}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
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
