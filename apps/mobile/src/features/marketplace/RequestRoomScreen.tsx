import type { MobileFoundationStringKey } from "@autoflow/shared";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { api, type MobileBuyerOffer, type MobileBuyerRoom } from "../../convexApi";
import { FormField } from "../../components/FormField";
import { Icon } from "../../components/Icon";
import { RouteLoadingState } from "../../components/RouteState";
import { useLocale } from "../../providers/LocaleProvider";
import { theme } from "../../theme";
import { setRequestSeenOfferCount } from "./buyerRequestsStore";
import { formatMoney, formatNumber, getRequestStatusKey } from "./marketplaceUtils";
import {
  buildTimeline,
  computeCompareHighlights,
  computeOfferExpiry,
  getOfferKindLabelKey,
  isOfferActionable,
  type OfferExpiry,
  type TimelineStep,
} from "./requestRoomModel";

type Locale = "en" | "ar";

/** Local placeholder interpolation ({count}/{time}) — the shared t() only maps keys. */
function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (match, key: string) =>
    key in params ? String(params[key]) : match
  );
}

// Public web origin for the buyer-facing Request Room. Native deep-linking into
// the app is a later (R3) growth item; today the share link opens the web room.
const MARKETPLACE_WEB_ORIGIN = "https://autoflowdealer.com";

function getRequestRoomLink(publicId: string): string {
  return `${MARKETPLACE_WEB_ORIGIN}/marketplace/r/${publicId}`;
}

function LtrText({ children, style }: { children: React.ReactNode; style?: object }) {
  // Keep Latin/numeric strings (prices, terms) from scrambling inside RTL text.
  return <Text style={[{ writingDirection: "ltr" }, style]}>{children}</Text>;
}

function StatusPill({ status }: { status: MobileBuyerRoom["status"] }) {
  const { t } = useLocale();
  const tone =
    status === "OFFERS_RECEIVED" || status === "ACCEPTED" || status === "COMPLETED"
      ? styles.pillActive
      : status === "EXPIRED" || status === "SPAM"
        ? styles.pillMuted
        : styles.pillPending;
  return (
    <View style={[styles.pill, tone]}>
      <Text style={styles.pillText}>{t(getRequestStatusKey(status))}</Text>
    </View>
  );
}

function Timeline({ steps }: { steps: TimelineStep[] }) {
  const { t } = useLocale();

  function labelFor(step: TimelineStep): string {
    switch (step.id) {
      case "received":
        return t("marketplaceRoomStepReceived");
      case "notified":
        return step.state === "done"
          ? fill(t("marketplaceRoomStepNotified"), { count: step.count ?? 0 })
          : t("marketplaceRoomStepSearching");
      case "firstOffer":
        return step.state === "done"
          ? (step.count && step.count > 1
              ? fill(t("marketplaceRoomStepReplies"), { count: step.count })
              : t("marketplaceRoomStepFirstOffer"))
          : t("marketplaceRoomStepFirstOffer");
      case "accepted":
        return t("marketplaceRoomStepAccepted");
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardHeading}>{t("marketplaceRoomTimelineTitle")}</Text>
      <View style={styles.timeline}>
        {steps.map((step) => (
          <View key={step.id} style={styles.timelineRow}>
            <View
              style={[
                styles.timelineDot,
                step.state === "done" && styles.timelineDotDone,
                step.state === "active" && styles.timelineDotActive,
              ]}
            >
              {step.state === "done" ? <Icon name="check" size={12} color="onPrimary" /> : null}
            </View>
            <Text
              style={[
                styles.timelineLabel,
                step.state === "pending" && styles.timelineLabelPending,
              ]}
            >
              {labelFor(step)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function expiryLabel(expiry: OfferExpiry, t: (key: MobileFoundationStringKey) => string): string {
  if (expiry.expired) return t("marketplaceOfferExpired");
  const unitKey: MobileFoundationStringKey =
    expiry.unit === "days"
      ? "marketplaceOfferExpiryDays"
      : expiry.unit === "hours"
        ? "marketplaceOfferExpiryHours"
        : "marketplaceOfferExpiryMinutes";
  return fill(t("marketplaceOfferExpiresIn"), { time: fill(t(unitKey), { count: expiry.value }) });
}

function OfferCard({
  offer,
  locale,
  now,
  selectedForCompare,
  onToggleCompare,
  onShortlist,
  onDecline,
  onAllowContact,
  onAccept,
  busy,
}: {
  offer: MobileBuyerOffer;
  locale: Locale;
  now: number;
  selectedForCompare: boolean;
  onToggleCompare: () => void;
  onShortlist: () => void;
  onDecline: () => void;
  onAllowContact: () => void;
  onAccept: () => void;
  busy: boolean;
}) {
  const { t, textDirection } = useLocale();
  const expiry = computeOfferExpiry(offer.expiresAt, now);
  const actionable = isOfferActionable(offer);
  const finance = offer.financeOffer;
  const monthly = finance ? formatMoney(finance.monthlyInstallment, locale) : null;
  const cash = formatMoney(offer.cashPriceJod, locale);
  const title = offer.vehicle
    ? [offer.vehicle.year || null, offer.vehicle.make, offer.vehicle.model, offer.vehicle.trim].filter(Boolean).join(" ")
    : t("marketplaceOfferKindSource");

  return (
    <View style={[styles.offerCard, { direction: textDirection }, offer.buyerAction === "DECLINED" && styles.offerCardDimmed]}>
      <View style={styles.offerTopRow}>
        <View style={[styles.kindBadge, offer.kind === "HAVE_MATCH" && styles.kindBadgeStrong]}>
          <Text style={styles.kindBadgeText}>{t(getOfferKindLabelKey(offer.kind))}</Text>
        </View>
        {expiry ? (
          <Text style={[styles.expiryText, expiry.expired && styles.expiryExpired]}>{expiryLabel(expiry, t)}</Text>
        ) : null}
      </View>

      {offer.vehicle?.photoUrl ? (
        <Image source={{ uri: offer.vehicle.photoUrl }} style={styles.offerImage} resizeMode="cover" />
      ) : null}

      <Text style={styles.offerTitle}>{title}</Text>
      {offer.vehicle?.mileage != null ? (
        <Text style={styles.offerMeta}>
          <LtrText>{formatNumber(offer.vehicle.mileage, locale)}</LtrText> {t("marketplaceMileage")}
        </Text>
      ) : null}

      <View style={styles.priceRow}>
        {monthly ? (
          <View style={styles.priceBlock}>
            <Text style={styles.priceLabel}>{t("marketplaceOfferMonthly")}</Text>
            <LtrText style={styles.priceValue}>
              {monthly}
              <Text style={styles.priceSuffix}>{t("marketplaceOfferPerMonth")}</Text>
            </LtrText>
          </View>
        ) : null}
        {cash ? (
          <View style={styles.priceBlock}>
            <Text style={styles.priceLabel}>{t("marketplaceOfferCashPrice")}</Text>
            <LtrText style={styles.priceValue}>{cash}</LtrText>
          </View>
        ) : null}
      </View>

      {finance ? (
        <View style={styles.financeRow}>
          <Text style={styles.offerMeta}>
            {t("marketplaceOfferDown")}: <LtrText>{formatMoney(finance.downPayment, locale)}</LtrText>
          </Text>
          <Text style={styles.offerMeta}>
            {t("marketplaceOfferTerm")}: <LtrText>{formatNumber(finance.termMonths, locale)}</LtrText> {t("marketplaceOfferMonths")}
          </Text>
        </View>
      ) : null}

      {offer.sourcingRange ? (
        <Text style={styles.offerMeta}>
          <LtrText>{formatMoney(offer.sourcingRange.minJod, locale)} – {formatMoney(offer.sourcingRange.maxJod, locale)}</LtrText>
          {"  ·  "}
          {fill(t("marketplaceOfferSourceEta"), { count: offer.sourcingRange.etaDays })}
        </Text>
      ) : null}

      <View style={styles.dealerRow}>
        <Text style={styles.dealerName}>{offer.dealerName}</Text>
        {offer.dealerAvgResponseMinutes != null ? (
          <Text style={styles.offerMeta}>
            {fill(t("marketplaceRoomAvgResponse"), { count: Math.round(offer.dealerAvgResponseMinutes) })}
          </Text>
        ) : null}
      </View>

      {offer.contactUnlocked ? (
        <View style={styles.contactSharedBox}>
          <Icon name="check" size={14} color="success" />
          <Text style={styles.contactSharedText}>{t("marketplaceOfferContactShared")}</Text>
        </View>
      ) : null}

      {offer.buyerAction === "DECLINED" ? (
        <Text style={styles.statusNote}>{t("marketplaceOfferDeclined")}</Text>
      ) : offer.buyerAction === "ACCEPTED" ? (
        <Text style={[styles.statusNote, styles.statusNoteGood]}>{t("marketplaceOfferAccepted")}</Text>
      ) : actionable ? (
        <>
          <View style={styles.offerActionRow}>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.chipButton, selectedForCompare && styles.chipButtonSelected, pressed && styles.pressed]}
              onPress={onToggleCompare}
            >
              <Text style={[styles.chipButtonText, selectedForCompare && styles.chipButtonTextSelected]}>
                {t("marketplaceOfferActionCompare")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={({ pressed }) => [styles.chipButton, offer.buyerAction === "SHORTLISTED" && styles.chipButtonSelected, pressed && styles.pressed]}
              onPress={onShortlist}
            >
              <Text style={[styles.chipButtonText, offer.buyerAction === "SHORTLISTED" && styles.chipButtonTextSelected]}>
                {offer.buyerAction === "SHORTLISTED" ? t("marketplaceOfferActionShortlisted") : t("marketplaceOfferActionShortlist")}
              </Text>
            </Pressable>
          </View>
          <View style={styles.offerActionRow}>
            {offer.contactUnlocked ? null : (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                onPress={onAllowContact}
              >
                <Text style={styles.secondaryButtonText}>{t("marketplaceOfferActionAllowContact")}</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
              onPress={onAccept}
            >
              <Text style={styles.primaryButtonText}>{t("marketplaceOfferActionAccept")}</Text>
            </Pressable>
          </View>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onDecline} style={({ pressed }) => [styles.declineLink, pressed && styles.pressed]}>
            <Text style={styles.declineLinkText}>{t("marketplaceOfferActionDecline")}</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

function CompareModal({
  offers,
  locale,
  onClose,
}: {
  offers: MobileBuyerOffer[];
  locale: Locale;
  onClose: () => void;
}) {
  const { t, textDirection } = useLocale();
  const highlights = useMemo(() => computeCompareHighlights(offers), [offers]);

  return (
    <Modal animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={[styles.modalScreen, { direction: textDirection }]}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>{t("marketplaceCompareTitle")}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={t("marketplaceCompareClose")} onPress={onClose} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <Icon name="close" size={20} color="text" />
          </Pressable>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator style={styles.compareScroll}>
          <View style={styles.compareGrid}>
            {offers.map((offer) => {
              const finance = offer.financeOffer;
              return (
                <View key={offer.responseId} style={styles.compareColumn}>
                  <Text style={styles.compareDealer}>{offer.dealerName}</Text>
                  <Text style={styles.compareCarText}>
                    {offer.vehicle ? [offer.vehicle.make, offer.vehicle.model].filter(Boolean).join(" ") : t("marketplaceOfferKindSource")}
                  </Text>
                  <View style={[styles.compareCell, highlights.lowestMonthly.has(offer.responseId) && styles.compareCellWin]}>
                    <Text style={styles.compareCellLabel}>{t("marketplaceOfferMonthly")}</Text>
                    <LtrText style={styles.compareCellValue}>{finance ? formatMoney(finance.monthlyInstallment, locale) : "—"}</LtrText>
                    {highlights.lowestMonthly.has(offer.responseId) ? <Text style={styles.compareWinTag}>{t("marketplaceCompareLowestMonthly")}</Text> : null}
                  </View>
                  <View style={[styles.compareCell, highlights.lowestTotal.has(offer.responseId) && styles.compareCellWin]}>
                    <Text style={styles.compareCellLabel}>{t("marketplaceCompareTotal")}</Text>
                    <LtrText style={styles.compareCellValue}>{finance ? formatMoney(finance.totalContractValue, locale) : formatMoney(offer.cashPriceJod, locale) ?? "—"}</LtrText>
                    {highlights.lowestTotal.has(offer.responseId) ? <Text style={styles.compareWinTag}>{t("marketplaceCompareLowestTotal")}</Text> : null}
                  </View>
                  <View style={[styles.compareCell, highlights.lowestDown.has(offer.responseId) && styles.compareCellWin]}>
                    <Text style={styles.compareCellLabel}>{t("marketplaceOfferDown")}</Text>
                    <LtrText style={styles.compareCellValue}>{finance ? formatMoney(finance.downPayment, locale) : "—"}</LtrText>
                    {highlights.lowestDown.has(offer.responseId) ? <Text style={styles.compareWinTag}>{t("marketplaceCompareLowestDown")}</Text> : null}
                  </View>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function PhoneConfirmModal({
  mode,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  mode: "allow" | "accept";
  submitting: boolean;
  error: string | null;
  onSubmit: (phone: string) => void;
  onCancel: () => void;
}) {
  const { t, textDirection } = useLocale();
  const [phone, setPhone] = useState("");

  return (
    <Modal animationType="fade" transparent onRequestClose={onCancel}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.confirmCard, { direction: textDirection }]}>
          <Text style={styles.modalTitle}>{t("marketplaceConfirmPhoneTitle")}</Text>
          <Text style={styles.confirmBody}>
            {mode === "allow" ? t("marketplaceConfirmPhoneAllowBody") : t("marketplaceConfirmPhoneAcceptBody")}
          </Text>
          <FormField
            label={t("marketplaceConfirmPhoneField")}
            value={phone}
            keyboardType="phone-pad"
            onChangeText={setPhone}
          />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.confirmActions}>
            <Pressable accessibilityRole="button" disabled={submitting} onPress={onCancel} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
              <Text style={styles.secondaryButtonText}>{t("marketplaceConfirmPhoneCancel")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={submitting || phone.trim().length === 0}
              onPress={() => onSubmit(phone)}
              style={({ pressed }) => [styles.primaryButton, (submitting || phone.trim().length === 0) && styles.disabledButton, pressed && styles.pressed]}
            >
              <Text style={styles.primaryButtonText}>{t("marketplaceConfirmPhoneSubmit")}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function RequestRoomScreen({
  publicId,
  onBack,
}: Readonly<{ publicId: string; onBack: () => void }>) {
  const { locale, t, textDirection } = useLocale();
  const room = useQuery(api.marketplaceRequests.getBuyerOffers, { publicId }) as
    | MobileBuyerRoom
    | null
    | undefined;

  const shortlistOffer = useMutation(api.marketplaceBuyerActions.shortlistOffer);
  const declineOffer = useMutation(api.marketplaceBuyerActions.declineOffer);
  const allowContact = useMutation(api.marketplaceBuyerActions.allowContact);
  const acceptOffer = useMutation(api.marketplaceBuyerActions.acceptOffer);

  const [selected, setSelected] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [phonePrompt, setPhonePrompt] = useState<{ responseId: string; mode: "allow" | "accept" } | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const offerCount = room?.offers.length ?? 0;

  // Keep expiry countdowns fresh; the offer feed itself is already reactive.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  // Mark this room's current offers as seen so the Offers tab clears its badge.
  useEffect(() => {
    if (room) void setRequestSeenOfferCount(publicId, offerCount);
  }, [room, publicId, offerCount]);

  function reportActionFailure(error: unknown) {
    console.error("Request room action failed", error);
    Alert.alert("AutoFlow", t("marketplaceRoomActionFailed"));
  }

  function toggleCompare(responseId: string) {
    setSelected((current) => {
      if (current.includes(responseId)) return current.filter((id) => id !== responseId);
      if (current.length >= 3) return current;
      return [...current, responseId];
    });
  }

  async function runSimpleAction(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      reportActionFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function submitPhoneGated(phone: string) {
    if (!phonePrompt) return;
    setBusy(true);
    setPhoneError(null);
    try {
      const args = { publicId, responseId: phonePrompt.responseId as never, buyerPhone: phone.trim() };
      if (phonePrompt.mode === "allow") await allowContact(args);
      else await acceptOffer(args);
      setPhonePrompt(null);
    } catch (error) {
      // The backend rejects a non-matching phone; surface that specifically.
      setPhoneError(t("marketplaceConfirmPhoneMismatch"));
      console.error("Request room contact action failed", error);
    } finally {
      setBusy(false);
    }
  }

  async function onShare() {
    try {
      await Share.share({ message: `${t("marketplaceRoomShareMessage")} ${getRequestRoomLink(publicId)}` });
    } catch (error) {
      console.error("Failed to share request room link", error);
    }
  }

  if (room === undefined) {
    return <RouteLoadingState label={t("marketplaceRoomLoading")} />;
  }

  if (room === null) {
    return (
      <View style={[styles.container, { direction: textDirection }]}>
        <RoomHeader onBack={onBack} onShare={undefined} title={t("marketplaceRoomTitle")} />
        <Text style={styles.emptyText}>{t("marketplaceRoomNotFound")}</Text>
      </View>
    );
  }

  const steps = buildTimeline(room);
  const selectedOffers = room.offers.filter((offer) => selected.includes(offer.responseId));
  const vehicleLine = [room.make, room.model].filter(Boolean).join(" ");

  return (
    <View style={[styles.container, { direction: textDirection }]}>
      <RoomHeader onBack={onBack} onShare={onShare} title={t("marketplaceRoomTitle")} />

      <View style={styles.summaryCard}>
        <View style={styles.summaryTextWrap}>
          <Text style={styles.summaryTitle}>{vehicleLine || t("marketplaceRoomTitle")}</Text>
          <Text style={styles.summaryMeta}>{room.buyerCity}</Text>
        </View>
        <StatusPill status={room.status} />
      </View>

      <Timeline steps={steps} />

      <Text style={styles.sectionHeading}>
        {t("marketplaceRoomOffersTitle")}
        {offerCount > 0 ? <Text style={styles.sectionCount}> · {formatNumber(offerCount, locale)}</Text> : null}
      </Text>

      {offerCount === 0 ? (
        <View style={styles.emptyCard}>
          <Icon name="today" size={22} color="primary" />
          <Text style={styles.emptyTitle}>{t("marketplaceRoomEmptyTitle")}</Text>
          <Text style={styles.emptyBody}>{t("marketplaceRoomEmptyBody")}</Text>
        </View>
      ) : (
        room.offers.map((offer) => (
          <OfferCard
            key={offer.responseId}
            offer={offer}
            locale={locale}
            now={now}
            busy={busy}
            selectedForCompare={selected.includes(offer.responseId)}
            onToggleCompare={() => toggleCompare(offer.responseId)}
            onShortlist={() => void runSimpleAction(() => shortlistOffer({ publicId, responseId: offer.responseId as never }))}
            onDecline={() => void runSimpleAction(() => declineOffer({ publicId, responseId: offer.responseId as never }))}
            onAllowContact={() => {
              setPhoneError(null);
              setPhonePrompt({ responseId: offer.responseId, mode: "allow" });
            }}
            onAccept={() => {
              setPhoneError(null);
              setPhonePrompt({ responseId: offer.responseId, mode: "accept" });
            }}
          />
        ))
      )}

      {selected.length >= 1 ? (
        <View style={styles.compareBar}>
          <Text style={styles.compareBarText}>{fill(t("marketplaceCompareBarSelected"), { count: selected.length })}</Text>
          <View style={styles.compareBarActions}>
            <Pressable accessibilityRole="button" onPress={() => setSelected([])} style={({ pressed }) => [styles.compareBarClear, pressed && styles.pressed]}>
              <Text style={styles.compareBarClearText}>{t("marketplaceCompareBarClear")}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={selected.length < 2}
              onPress={() => setCompareOpen(true)}
              style={({ pressed }) => [styles.compareBarOpen, selected.length < 2 && styles.disabledButton, pressed && styles.pressed]}
            >
              <Text style={styles.compareBarOpenText}>{t("marketplaceCompareBarOpen")}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {compareOpen && selectedOffers.length >= 2 ? (
        <CompareModal offers={selectedOffers} locale={locale} onClose={() => setCompareOpen(false)} />
      ) : null}

      {phonePrompt ? (
        <PhoneConfirmModal
          mode={phonePrompt.mode}
          submitting={busy}
          error={phoneError}
          onSubmit={(phone) => void submitPhoneGated(phone)}
          onCancel={() => {
            setPhonePrompt(null);
            setPhoneError(null);
          }}
        />
      ) : null}
    </View>
  );
}

function RoomHeader({ onBack, onShare, title }: { onBack: () => void; onShare?: () => void; title: string }) {
  const { t } = useLocale();
  return (
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("marketplaceRoomBack")} onPress={onBack} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
        <Icon name="back" size={20} color="text" />
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
      {onShare ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t("marketplaceRoomShare")} onPress={onShare} style={({ pressed }) => [styles.shareButton, pressed && styles.pressed]}>
          <Icon name="chevronForward" size={16} color="primary" />
          <Text style={styles.shareButtonText}>{t("marketplaceRoomShare")}</Text>
        </Pressable>
      ) : (
        <View style={styles.iconButton} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: theme.spacing.md,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  headerTitle: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
  },
  iconButton: {
    minWidth: 40,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
  },
  shareButton: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.sm,
  },
  shareButtonText: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: "700",
  },
  summaryCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  summaryTextWrap: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing.xs,
  },
  summaryTitle: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  summaryMeta: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  pill: {
    borderRadius: theme.radius.full,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  pillActive: {
    backgroundColor: theme.colors.successSoft,
  },
  pillPending: {
    backgroundColor: theme.colors.infoSoft,
  },
  pillMuted: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  pillText: {
    color: theme.colors.text,
    fontSize: 11,
    fontWeight: "700",
  },
  card: {
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
  },
  cardHeading: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  timeline: {
    gap: theme.spacing.sm,
  },
  timelineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  timelineDot: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderStrong,
    backgroundColor: theme.colors.surfaceAlt,
  },
  timelineDotDone: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  timelineDotActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  timelineLabel: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  timelineLabelPending: {
    color: theme.colors.mutedText,
  },
  sectionHeading: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  sectionCount: {
    color: theme.colors.mutedText,
    fontWeight: "600",
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
  emptyText: {
    color: theme.colors.mutedText,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    paddingVertical: theme.spacing.lg,
  },
  offerCard: {
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.md,
    ...theme.shadows.sm,
  },
  offerCardDimmed: {
    opacity: 0.6,
  },
  offerTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
  },
  kindBadge: {
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.infoSoft,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  kindBadgeStrong: {
    backgroundColor: theme.colors.successSoft,
  },
  kindBadgeText: {
    color: theme.colors.text,
    fontSize: 11,
    fontWeight: "700",
  },
  expiryText: {
    color: theme.colors.mutedText,
    fontSize: 11,
    fontWeight: "600",
  },
  expiryExpired: {
    color: theme.colors.danger,
  },
  offerImage: {
    width: "100%",
    aspectRatio: 16 / 9,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  offerTitle: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: "700",
    lineHeight: 23,
  },
  offerMeta: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  priceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.lg,
  },
  priceBlock: {
    gap: 2,
  },
  priceLabel: {
    color: theme.colors.mutedText,
    fontSize: 11,
    fontWeight: "600",
  },
  priceValue: {
    color: theme.colors.text,
    fontSize: 20,
    fontWeight: "700",
  },
  priceSuffix: {
    color: theme.colors.mutedText,
    fontSize: 12,
    fontWeight: "600",
  },
  financeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.md,
  },
  dealerRow: {
    gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing.sm,
  },
  dealerName: {
    color: theme.colors.text,
    fontSize: 14,
    fontWeight: "700",
  },
  contactSharedBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.successSoft,
    padding: theme.spacing.sm,
  },
  contactSharedText: {
    color: theme.colors.text,
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
  },
  statusNote: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "700",
  },
  statusNoteGood: {
    color: theme.colors.success,
  },
  offerActionRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  chipButton: {
    minHeight: 40,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.sm,
  },
  chipButtonSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  chipButtonText: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "700",
  },
  chipButtonTextSelected: {
    color: theme.colors.text,
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
  declineLink: {
    alignItems: "center",
    paddingVertical: theme.spacing.xs,
  },
  declineLinkText: {
    color: theme.colors.mutedText,
    fontSize: 13,
    fontWeight: "600",
  },
  disabledButton: {
    opacity: 0.46,
  },
  compareBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.text,
    padding: theme.spacing.md,
  },
  compareBarText: {
    color: theme.colors.onPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  compareBarActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
  },
  compareBarClear: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  compareBarClearText: {
    color: theme.colors.onPrimary,
    fontSize: 13,
    fontWeight: "600",
    opacity: 0.8,
  },
  compareBarOpen: {
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  compareBarOpenText: {
    color: theme.colors.onPrimary,
    fontSize: 13,
    fontWeight: "700",
  },
  modalScreen: {
    flex: 1,
    gap: theme.spacing.md,
    backgroundColor: theme.colors.background,
    padding: theme.spacing.lg,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  modalTitle: {
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  compareScroll: {
    flexGrow: 0,
  },
  compareGrid: {
    flexDirection: "row",
    gap: theme.spacing.md,
  },
  compareColumn: {
    width: 180,
    gap: theme.spacing.sm,
  },
  compareDealer: {
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  compareCarText: {
    color: theme.colors.mutedText,
    fontSize: 13,
  },
  compareCell: {
    gap: 2,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.sm,
  },
  compareCellWin: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  compareCellLabel: {
    color: theme.colors.mutedText,
    fontSize: 11,
    fontWeight: "600",
  },
  compareCellValue: {
    color: theme.colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  compareWinTag: {
    color: theme.colors.primary,
    fontSize: 10,
    fontWeight: "700",
  },
  modalBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.45)",
    padding: theme.spacing.lg,
  },
  confirmCard: {
    width: "100%",
    gap: theme.spacing.md,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    padding: theme.spacing.lg,
  },
  confirmBody: {
    color: theme.colors.mutedText,
    fontSize: 13,
    lineHeight: 19,
  },
  confirmActions: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 13,
    lineHeight: 19,
  },
  pressed: {
    opacity: 0.82,
  },
});
