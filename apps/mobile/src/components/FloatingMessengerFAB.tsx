import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";

import { api } from "../convexApi";
import { MessagesModule } from "../features/workspace/modules/messages";
import { useLocale } from "../providers/LocaleProvider";
import { theme } from "../theme";
import { Icon } from "./Icon";

const FAB_SIZE = 58;

export function getFabPressedStyle(pressed: boolean) {
  return pressed ? styles.pressed : null;
}

export function FloatingMessengerFAB({
  bottomOffset,
  orgId,
}: Readonly<{ bottomOffset: number; orgId: string }>) {
  const { locale, textDirection } = useLocale();
  const conversations = useQuery(api.directMessages.listConversations, { orgId });
  const unreadCount = (conversations ?? []).filter((conversation) => conversation.hasUnread).length;
  const pulse = useRef(new Animated.Value(0)).current;
  const [open, setOpen] = useState(false);
  const closeMessenger = () => setOpen(false);

  useEffect(() => {
    if (unreadCount === 0) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, unreadCount]);

  return (
    <>
      <Animated.View
        style={[
          styles.shell,
          { bottom: bottomOffset, transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) }] },
        ]}
      >
        <Pressable
          accessibilityLabel={locale === "ar" ? "الرسائل" : "Messages"}
          accessibilityRole="button"
          style={({ pressed }) => [styles.pressable, getFabPressedStyle(pressed)]}
          onPress={() => setOpen(true)}
        >
          <Svg height={FAB_SIZE} width={FAB_SIZE} style={StyleSheet.absoluteFill}>
            <Defs>
              <LinearGradient id="fabGradient" x1="0" x2="1" y1="0" y2="1">
                <Stop offset="0" stopColor={theme.colors.indigo} />
                <Stop offset="1" stopColor={theme.colors.primary} />
              </LinearGradient>
            </Defs>
            <Circle cx={FAB_SIZE / 2} cy={FAB_SIZE / 2} fill="url(#fabGradient)" r={FAB_SIZE / 2} />
          </Svg>
          <Icon color="onPrimary" name="messages" size={24} />
          {unreadCount > 0 ? (
            <View style={styles.badge}>
              <Text numberOfLines={1} style={styles.badgeText}>{unreadCount > 9 ? "9+" : unreadCount}</Text>
            </View>
          ) : null}
        </Pressable>
      </Animated.View>

      <Modal animationType="slide" presentationStyle="pageSheet" visible={open} onRequestClose={closeMessenger}>
        <View style={[styles.modalRoot, { direction: textDirection }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{locale === "ar" ? "الرسائل" : "Messages"}</Text>
            <Pressable
              accessibilityLabel={locale === "ar" ? "إغلاق" : "Close"}
              accessibilityRole="button"
              style={({ pressed }) => [styles.closeButton, getFabPressedStyle(pressed)]}
              onPress={closeMessenger}
            >
              <Icon color="text" name="close" size={20} />
            </Pressable>
          </View>
          <MessagesModule orgId={orgId} />
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  shell: {
    position: "absolute",
    end: theme.spacing.lg,
    ...theme.shadows.lg,
  },
  pressable: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.88,
  },
  badge: {
    position: "absolute",
    top: -2,
    end: -2,
    minWidth: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 2,
    borderColor: theme.colors.surface,
    backgroundColor: theme.colors.danger,
    paddingHorizontal: 4,
  },
  badgeText: {
    color: theme.colors.onPrimary,
    fontSize: 10,
    fontWeight: "700",
  },
  modalRoot: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  modalTitle: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "700",
  },
  closeButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surfaceAlt,
  },
});
