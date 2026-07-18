import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { api, type MobileBuyerRoom } from "../../convexApi";
import { FormField } from "../../components/FormField";
import { Icon } from "../../components/Icon";
import { RouteLoadingState } from "../../components/RouteState";
import { useLocale } from "../../providers/LocaleProvider";
import { theme } from "../../theme";
import {
  computeUnreadCount,
  loadSavedRequests,
  parsePublicIdFromInput,
  removeBuyerRequest,
  type SavedBuyerRequest,
} from "./buyerRequestsStore";
import { formatMoney, formatNumber, getRequestStatusKey, getTradeInStatusKey } from "./marketplaceUtils";

function SavedRequestRow({
  request,
  locale,
  onOpen,
  onRemove,
}: {
  request: SavedBuyerRequest;
  locale: "en" | "ar";
  onOpen: () => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  const room = useQuery(api.marketplaceRequests.getBuyerOffers, { publicId: request.publicId }) as
    | MobileBuyerRoom
    | null
    | undefined;

  const offerCount = room?.offers.length ?? 0;
  const unread = computeUnreadCount(request.seenOfferCount, offerCount);
  const vehicleLine = [request.make, request.model].filter(Boolean).join(" ");

  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [styles.roomRow, pressed && styles.pressed]}
      onPress={onOpen}
    >
      <View style={styles.roomRowText}>
        <Text style={styles.roomRowTitle}>{vehicleLine || t("marketplaceRoomTitle")}</Text>
        {room === undefined ? (
          <Text style={styles.roomRowMeta}>…</Text>
        ) : room === null ? (
          <Text style={styles.roomRowMeta}>{t("marketplaceRoomNotFound")}</Text>
        ) : (
          <Text style={styles.roomRowMeta}>
            {t(getRequestStatusKey(room.status))}
            {offerCount > 0 ? ` · ${formatNumber(offerCount, locale)} ${t("marketplaceOffersOfferCount")}` : ""}
          </Text>
        )}
      </View>
      {unread > 0 ? (
        <View style={styles.unreadBadge}>
          <Text style={styles.unreadBadgeText}>
            {formatNumber(unread, locale)} {t("marketplaceOffersNewOffers")}
          </Text>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={onRemove}
        style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}
      >
        <Icon name="close" size={16} color="mutedText" />
      </Pressable>
    </Pressable>
  );
}

function FindRequestSection({ onOpen }: { onOpen: (publicId: string) => void }) {
  const { t, textDirection } = useLocale();
  const [value, setValue] = useState("");
  const canOpen = parsePublicIdFromInput(value) !== null;

  return (
    <View style={[styles.card, { direction: textDirection }]}>
      <Text style={styles.cardTitle}>{t("marketplaceOffersFindTitle")}</Text>
      <Text style={styles.cardBody}>{t("marketplaceOffersFindBody")}</Text>
      <FormField label="" value={value} onChangeText={setValue} />
      <Pressable
        accessibilityRole="button"
        disabled={!canOpen}
        style={({ pressed }) => [styles.primaryButton, !canOpen && styles.disabledButton, pressed && styles.pressed]}
        onPress={() => {
          const publicId = parsePublicIdFromInput(value);
          if (publicId) onOpen(publicId);
        }}
      >
        <Text style={styles.primaryButtonText}>{t("marketplaceOffersFindOpen")}</Text>
      </Pressable>
    </View>
  );
}

/** Preserved trade-in offer lookup (moved from the old Status tab). */
function TradeInLookupSection() {
  const { locale, t, textDirection } = useLocale();
  const acceptOffer = useMutation(api.marketplaceTradeIns.acceptOfferByPublicId);
  const declineOffer = useMutation(api.marketplaceTradeIns.declineOfferByPublicId);
  const [tradeInId, setTradeInId] = useState("");
  const [tradeInPhone, setTradeInPhone] = useState("");
  const [submitted, setSubmitted] = useState<{ id: string; phone: string } | null>(null);
  const [offerUpdating, setOfferUpdating] = useState(false);
  const [offerMessage, setOfferMessage] = useState<string | null>(null);

  const tradeInStatus = useQuery(
    api.marketplaceTradeIns.getStatusForBuyerByPublicId,
    submitted ? { tradeInRequestId: submitted.id, buyerPhone: submitted.phone } : "skip",
  );
  const canCheck = tradeInId.trim().length > 0 && tradeInPhone.trim().length > 0;

  async function updateOffer(action: "accept" | "decline") {
    if (!submitted) return;
    setOfferUpdating(true);
    setOfferMessage(null);
    try {
      const result =
        action === "accept"
          ? await acceptOffer({ tradeInRequestId: submitted.id, buyerPhone: submitted.phone })
          : await declineOffer({ tradeInRequestId: submitted.id, buyerPhone: submitted.phone });
      if (!result.success) {
        Alert.alert("AutoFlow", t("marketplaceOfferUpdateFailed"));
        return;
      }
      setOfferMessage(t("marketplaceOfferUpdated"));
    } catch (error) {
      console.error("Failed to update marketplace trade-in offer", error);
      Alert.alert("AutoFlow", t("marketplaceOfferUpdateFailed"));
    } finally {
      setOfferUpdating(false);
    }
  }

  return (
    <View style={[styles.card, { direction: textDirection }]}>
      <Text style={styles.cardTitle}>{t("marketplaceStatusCheckTradeIn")}</Text>
      <FormField label={t("marketplaceStatusTradeInId")} value={tradeInId} onChangeText={setTradeInId} />
      <FormField label={t("marketplaceStatusPhone")} value={tradeInPhone} onChangeText={setTradeInPhone} keyboardType="phone-pad" />
      <Pressable
        disabled={!canCheck}
        style={({ pressed }) => [styles.primaryButton, !canCheck && styles.disabledButton, pressed && styles.pressed]}
        onPress={() => {
          setOfferMessage(null);
          setSubmitted({ id: tradeInId.trim(), phone: tradeInPhone.trim() });
        }}
      >
        <Text style={styles.primaryButtonText}>{t("marketplaceStatusCheckTradeIn")}</Text>
      </Pressable>
      {submitted && tradeInStatus === undefined ? <RouteLoadingState label={t("marketplaceStatusCheckTradeIn")} /> : null}
      {submitted && tradeInStatus === null ? <Text style={styles.roomRowMeta}>{t("marketplaceStatusNotFound")}</Text> : null}
      {tradeInStatus ? (
        <View style={styles.statusResult}>
          <Text style={styles.roomRowTitle}>{t(getTradeInStatusKey(tradeInStatus.status))}</Text>
          <Text style={styles.roomRowMeta}>
            {tradeInStatus.currentYear} {tradeInStatus.currentMake} {tradeInStatus.currentModel}
          </Text>
          {tradeInStatus.offerAmountJod != null ? (
            <Text style={styles.offerAmount}>
              {t("marketplaceOfferAmount")}: {formatMoney(tradeInStatus.offerAmountJod, locale)}
            </Text>
          ) : null}
          {tradeInStatus.status === "OFFERED" ? (
            <View style={styles.tradeInActions}>
              <Pressable
                disabled={offerUpdating}
                style={({ pressed }) => [styles.primaryButton, offerUpdating && styles.disabledButton, pressed && styles.pressed]}
                onPress={() => void updateOffer("accept")}
              >
                <Text style={styles.primaryButtonText}>{t("marketplaceAcceptOffer")}</Text>
              </Pressable>
              <Pressable
                disabled={offerUpdating}
                style={({ pressed }) => [styles.secondaryButton, offerUpdating && styles.disabledButton, pressed && styles.pressed]}
                onPress={() => void updateOffer("decline")}
              >
                <Text style={styles.secondaryButtonText}>{t("marketplaceDeclineOffer")}</Text>
              </Pressable>
            </View>
          ) : null}
          {offerMessage ? <Text style={styles.successText}>{offerMessage}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

export function OffersTab({
  reloadToken,
  onOpenRoom,
}: Readonly<{ reloadToken: number; onOpenRoom: (publicId: string) => void }>) {
  const { locale, t, textDirection } = useLocale();
  const [saved, setSaved] = useState<SavedBuyerRequest[] | null>(null);

  const reload = useCallback(() => {
    void loadSavedRequests().then(setSaved);
  }, []);

  useEffect(() => {
    reload();
  }, [reload, reloadToken]);

  async function handleRemove(publicId: string) {
    setSaved(await removeBuyerRequest(publicId));
  }

  return (
    <View style={[styles.container, { direction: textDirection }]}>
      <View style={styles.headerBlock}>
        <Text style={styles.title}>{t("marketplaceOffersTabTitle")}</Text>
        <Text style={styles.subtitle}>{t("marketplaceOffersTabSubtitle")}</Text>
      </View>

      {saved === null ? (
        <RouteLoadingState label={t("marketplaceRoomLoading")} />
      ) : saved.length === 0 ? (
        <View style={styles.emptyCard}>
          <Icon name="marketplace" size={22} color="primary" />
          <Text style={styles.emptyTitle}>{t("marketplaceOffersEmptyTitle")}</Text>
          <Text style={styles.emptyBody}>{t("marketplaceOffersEmptyBody")}</Text>
        </View>
      ) : (
        <View style={styles.roomList}>
          {saved.map((request) => (
            <SavedRequestRow
              key={request.publicId}
              request={request}
              locale={locale}
              onOpen={() => onOpenRoom(request.publicId)}
              onRemove={() => void handleRemove(request.publicId)}
            />
          ))}
        </View>
      )}

      <FindRequestSection onOpen={onOpenRoom} />
      <TradeInLookupSection />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.spacing.md,
  },
  headerBlock: {
    gap: theme.spacing.xs,
  },
  title: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "700",
  },
  subtitle: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  roomList: {
    gap: theme.spacing.sm,
  },
  roomRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  roomRowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  roomRowTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  roomRowMeta: {
    color: theme.colors.mutedText,
    fontSize: 12,
    lineHeight: 17,
  },
  unreadBadge: {
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  unreadBadgeText: {
    color: theme.colors.onPrimary,
    fontSize: 11,
    fontWeight: "700",
  },
  removeButton: {
    minWidth: 32,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  cardTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  cardBody: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  emptyCard: {
    alignItems: "center",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.lg,
  },
  emptyTitle: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  emptyBody: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  statusResult: {
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.spacing.md,
  },
  offerAmount: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  tradeInActions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  primaryButton: {
    minHeight: 44,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.md,
  },
  primaryButtonText: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  secondaryButton: {
    minHeight: 44,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.md,
  },
  secondaryButtonText: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
  disabledButton: {
    opacity: 0.46,
  },
  successText: {
    color: theme.colors.success,
    fontSize: 13,
    fontWeight: "600",
  },
  pressed: {
    opacity: 0.82,
  },
});
