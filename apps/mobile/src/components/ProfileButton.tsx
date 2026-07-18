import { useAuth, useUser } from "@clerk/expo";
import { Alert, Pressable, StyleSheet } from "react-native";

import { useLocale } from "../providers/LocaleProvider";
import { MemberAvatar } from "./Avatar";

/**
 * Account control for the app headers. Replaces Clerk's native <UserButton>,
 * whose native prebuilt view renders as a blank/zero-size element on this app
 * (the same broken native Clerk UI that made us swap the native sign-in for a
 * custom form) — which left users with no way to sign out. Tapping the avatar
 * opens an account sheet whose only action, Sign out, calls Clerk's signOut().
 */
export function ProfileButton() {
  const { isSignedIn, signOut } = useAuth();
  const { user } = useUser();
  const { t } = useLocale();

  if (!isSignedIn) return null;

  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const name = user?.fullName?.trim() || email || t("account");
  const body = email && email !== name ? `${email}\n\n${t("signOutConfirmBody")}` : t("signOutConfirmBody");

  const openAccountMenu = () => {
    Alert.alert(
      name,
      body,
      [
        { text: t("cancel"), style: "cancel" },
        { text: t("signOut"), style: "destructive", onPress: () => void signOut() },
      ],
      { cancelable: true },
    );
  };

  return (
    <Pressable
      accessibilityLabel={t("account")}
      accessibilityRole="button"
      hitSlop={6}
      style={({ pressed }) => (pressed ? styles.pressed : undefined)}
      onPress={openAccountMenu}
    >
      <MemberAvatar imageUrl={user?.imageUrl} name={name} size={40} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.82 },
});
