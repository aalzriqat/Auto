import { nativeRoutes, type MobileFoundationStringKey } from "@autoflow/shared";
import { useConvexAuth, useMutation } from "convex/react";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useState, type ReactNode } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import {
  api,
  type MobileMarketplaceListingCondition,
  type MobileMarketplaceListingSellerKind,
} from "../../convexApi";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { FormField } from "../../components/FormField";
import { Icon } from "../../components/Icon";
import { RouteLoadingState } from "../../components/RouteState";
import { Screen } from "../../components/Screen";
import { SearchableSelectField } from "../../components/SearchableSelectField";
import { getFuelTypeOptions, getTransmissionOptions } from "../../data/mobileOptions";
import { ensurePhotoLibraryPermission } from "../../permissions/mediaPermissions";
import { useLocale } from "../../providers/LocaleProvider";
import { useThemedStyles } from "../../providers/ThemeProvider";
import { type AppTheme } from "../../theme";
import { getMarketplaceSelectOptions } from "./marketplaceSelectOptions";
import { getTradeInConditionKey, trimOrUndefined } from "./marketplaceUtils";

// Mirrors convex/marketplaceListings.ts's ALLOWED_CURRENCIES exactly.
const ALLOWED_CURRENCIES = ["JOD", "USD", "SAR", "AED", "KWD", "EGP", "QAR", "BHD", "OMR"] as const;
const LISTING_CONDITIONS: readonly MobileMarketplaceListingCondition[] = [
  "EXCELLENT",
  "GOOD",
  "FAIR",
  "POOR",
];

// Same bounds createListing enforces server-side (convex/marketplaceListings.ts)
// — checked here too so a seller sees the problem before the mutation rejects
// it. Validation here is UX only; the backend remains the enforcement point.
const MAX_LISTING_IMAGES = 20;
const MIN_LISTING_YEAR = 1980;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

type UploadedImage = {
  storageId: string;
  /** URL of the image as actually stored in Convex (from confirmListingImageUpload), not a local preview — proves the upload landed. */
  previewUrl: string | null;
};

type SellCarFields = {
  sellerKind: MobileMarketplaceListingSellerKind;
  sellerDisplayName: string;
  sellerPhone: string;
  sellerWhatsapp: string;
  make: string;
  model: string;
  year: string;
  mileage: string;
  price: string;
  currency: string;
  transmission: string;
  fuelType: string;
  city: string;
  description: string;
  condition: MobileMarketplaceListingCondition;
};

function defaultFields(): SellCarFields {
  return {
    sellerKind: "INDIVIDUAL",
    sellerDisplayName: "",
    sellerPhone: "",
    sellerWhatsapp: "",
    make: "",
    model: "",
    year: String(new Date().getFullYear()),
    mileage: "",
    price: "",
    currency: "JOD",
    transmission: "Automatic",
    fuelType: "Gasoline",
    city: "",
    description: "",
    condition: "GOOD",
  };
}

/** Mirrors createListing's assertValidYear/assertValidMileage/assertValidPrice and the required-text checks — same bounds, client-side. */
function validateSellCarFields(
  fields: SellCarFields,
  t: (key: MobileFoundationStringKey) => string,
): string | null {
  if (
    !trimOrUndefined(fields.sellerDisplayName) ||
    !trimOrUndefined(fields.sellerPhone) ||
    !trimOrUndefined(fields.make) ||
    !trimOrUndefined(fields.model) ||
    !trimOrUndefined(fields.city) ||
    !trimOrUndefined(fields.description)
  ) {
    return t("marketplaceRequiredFields");
  }

  const year = Number(fields.year);
  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(year) || year < MIN_LISTING_YEAR || year > maxYear) {
    return t("sellCarYearInvalid")
      .replace("{min}", String(MIN_LISTING_YEAR))
      .replace("{max}", String(maxYear));
  }

  const mileage = Number(fields.mileage);
  if (!Number.isFinite(mileage) || mileage < 0) {
    return t("sellCarMileageInvalid");
  }

  const price = Number(fields.price);
  if (!Number.isFinite(price) || price <= 0) {
    return t("sellCarPriceInvalid");
  }

  return null;
}

function ChoiceGroup<TValue extends string>({
  label,
  value,
  options,
  onChange,
}: Readonly<{
  label: string;
  value: TValue;
  options: ReadonlyArray<{ value: TValue; label: string }>;
  onChange: (value: TValue) => void;
}>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.choiceWrap}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.choiceButton,
                selected && styles.choiceButtonSelected,
                pressed && styles.pressed,
              ]}
              onPress={() => onChange(option.value)}
            >
              <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function SellCarScreen({
  embedded = false,
  onViewMyListings,
}: Readonly<{ embedded?: boolean; onViewMyListings?: () => void }> = {}) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { locale, t, textDirection } = useLocale();
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth();

  const generateUploadUrl = useMutation(api.marketplaceListings.generateListingImageUploadUrl);
  const confirmUpload = useMutation(api.marketplaceListings.confirmListingImageUpload);
  const createListing = useMutation(api.marketplaceListings.createListing);

  const [fields, setFields] = useState<SellCarFields>(defaultFields);
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [imagesError, setImagesError] = useState<string | null>(null);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedListingId, setSubmittedListingId] = useState<string | null>(null);

  const selectOptions = getMarketplaceSelectOptions(locale);
  const transmissionOptions = getTransmissionOptions(locale).map((option) => ({
    value: option.value,
    label: option.label,
  }));
  const fuelOptions = getFuelTypeOptions(locale).map((option) => ({
    value: option.value,
    label: option.label,
  }));
  const conditionOptions = LISTING_CONDITIONS.map((condition) => ({
    value: condition,
    label: t(getTradeInConditionKey(condition)),
  }));

  function setField<TKey extends keyof SellCarFields>(key: TKey, value: SellCarFields[TKey]) {
    setFormError(null);
    setFields((current) => ({ ...current, [key]: value }));
  }

  function removeImage(storageId: string) {
    setImages((prev) => prev.filter((image) => image.storageId !== storageId));
  }

  async function pickAndUploadPhotos() {
    const remaining = MAX_LISTING_IMAGES - images.length;
    if (remaining <= 0) {
      setImagesError(t("sellCarTooManyImages"));
      return;
    }

    try {
      const permission = await ensurePhotoLibraryPermission();
      if (!permission.granted) {
        Alert.alert(
          locale === "ar" ? "الإذن مطلوب" : "Permission needed",
          locale === "ar"
            ? "امنح التطبيق صلاحية الوصول إلى الصور لإضافة صور السيارة."
            : "Allow photo access to add pictures of the car.",
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        // Keep original resolution — the marketplace renders these full-size.
        quality: 1,
        selectionLimit: remaining,
      });
      if (result.canceled || result.assets.length === 0) return;

      setUploadingPhotos(true);
      setImagesError(null);
      for (const asset of result.assets) {
        const response = await fetch(asset.uri);
        const blob = await response.blob();
        const mimeType = (asset.mimeType || blob.type || "image/jpeg").toLowerCase();
        const sizeInBytes = asset.fileSize ?? blob.size;

        if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
          setImagesError(t("sellCarInvalidImageType"));
          continue;
        }
        if (sizeInBytes > MAX_IMAGE_SIZE_BYTES) {
          setImagesError(t("sellCarImageTooLarge"));
          continue;
        }

        const postUrl = await generateUploadUrl({ mimeType, sizeInBytes });
        const uploadResult = await fetch(postUrl, {
          method: "POST",
          headers: { "Content-Type": mimeType },
          body: blob,
        });
        if (!uploadResult.ok) {
          throw new Error(`Upload failed with status ${uploadResult.status}`);
        }
        const { storageId } = (await uploadResult.json()) as { storageId: string };
        const { url } = await confirmUpload({ storageId });
        setImages((prev) => [...prev, { storageId, previewUrl: url }]);
      }
    } catch (error) {
      console.error("Mobile listing photo upload failed", error);
      Alert.alert("AutoFlow", t("marketplaceListingGenericError"));
    } finally {
      setUploadingPhotos(false);
    }
  }

  async function handleSubmit() {
    setFormError(null);

    const validationError = validateSellCarFields(fields, t);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    if (images.length === 0) {
      setImagesError(t("sellCarImagesRequired"));
      return;
    }
    setImagesError(null);

    setSubmitting(true);
    try {
      const listingId = await createListing({
        sellerKind: fields.sellerKind,
        sellerDisplayName: fields.sellerDisplayName.trim(),
        sellerPhone: fields.sellerPhone.trim(),
        sellerWhatsapp: trimOrUndefined(fields.sellerWhatsapp),
        make: fields.make.trim(),
        model: fields.model.trim(),
        year: Number(fields.year),
        mileage: Number(fields.mileage),
        price: Number(fields.price),
        currency: fields.currency,
        transmission: fields.transmission,
        fuelType: fields.fuelType,
        city: fields.city.trim(),
        description: fields.description.trim(),
        condition: fields.condition,
        imageIds: images.map((image) => image.storageId),
      });
      setSubmittedListingId(listingId);
    } catch (error) {
      console.error("Mobile listing submit failed", error);
      setFormError(t("marketplaceListingGenericError"));
    } finally {
      setSubmitting(false);
    }
  }

  let body: ReactNode;
  if (authLoading) {
    body = <RouteLoadingState label={t("sellCarLoading")} />;
  } else if (!isAuthenticated) {
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.emptyContent, { direction: textDirection }]}>
        <EmptyState
          actionLabel={t("signIn")}
          hint={t("sellCarSignInBody")}
          icon="vehicles"
          title={t("sellCarSignInTitle")}
          onAction={() => router.push(nativeRoutes.signIn)}
        />
      </ScrollView>
    );
  } else if (submittedListingId) {
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.emptyContent, { direction: textDirection }]}>
        <Card style={styles.successCard}>
          <View style={styles.successIcon}>
            <Icon color="success" name="checkDone" size={26} />
          </View>
          <Text style={styles.successTitle}>{t("sellCarSuccessTitle")}</Text>
          <Text style={styles.successBody}>{t("sellCarSuccessBody")}</Text>
          {onViewMyListings ? (
            <Button label={t("sellCarViewMyListings")} onPress={onViewMyListings} />
          ) : null}
        </Card>
      </ScrollView>
    );
  } else {
    body = (
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { direction: textDirection }]}>
        <View style={styles.headerText}>
          <Text style={styles.title}>{t("sellCarTitle")}</Text>
          <Text style={styles.subtitle}>{t("sellCarSubtitle")}</Text>
        </View>

        <ChoiceGroup<MobileMarketplaceListingSellerKind>
          label={t("sellCarSellerKindLabel")}
          value={fields.sellerKind}
          options={[
            { value: "INDIVIDUAL", label: t("sellCarSellerKindIndividual") },
            { value: "UNAFFILIATED_DEALER", label: t("sellCarSellerKindDealer") },
          ]}
          onChange={(sellerKind) => setField("sellerKind", sellerKind)}
        />

        <FormField
          label={t("sellCarSellerDisplayName")}
          value={fields.sellerDisplayName}
          onChangeText={(value) => setField("sellerDisplayName", value)}
        />
        <FormField
          keyboardType="phone-pad"
          label={t("sellCarSellerPhone")}
          value={fields.sellerPhone}
          onChangeText={(value) => setField("sellerPhone", value)}
        />
        <FormField
          keyboardType="phone-pad"
          label={t("sellCarSellerWhatsapp")}
          value={fields.sellerWhatsapp}
          onChangeText={(value) => setField("sellerWhatsapp", value)}
        />

        <SearchableSelectField
          allowCustomValue
          closeLabel={selectOptions.closeLabel}
          customValueLabel={selectOptions.customValueLabel}
          emptyLabel={selectOptions.emptyLabel}
          label={t("marketplaceMake")}
          options={selectOptions.makeOptions}
          placeholder={selectOptions.makePlaceholder}
          searchPlaceholder={selectOptions.makeSearchPlaceholder}
          value={fields.make}
          onChange={(make) => setField("make", make)}
        />
        <FormField
          label={t("marketplaceBuyerModel")}
          value={fields.model}
          onChangeText={(value) => setField("model", value)}
        />
        <FormField
          keyboardType="number-pad"
          label={t("marketplaceYear")}
          value={fields.year}
          onChangeText={(value) => setField("year", value)}
        />
        <FormField
          keyboardType="number-pad"
          label={t("sellCarMileage")}
          value={fields.mileage}
          onChangeText={(value) => setField("mileage", value)}
        />
        <FormField
          keyboardType="number-pad"
          label={t("sellCarPrice")}
          value={fields.price}
          onChangeText={(value) => setField("price", value)}
        />

        <ChoiceGroup
          label={t("sellCarCurrency")}
          value={fields.currency}
          options={ALLOWED_CURRENCIES.map((currency) => ({ value: currency, label: currency }))}
          onChange={(currency) => setField("currency", currency)}
        />
        <ChoiceGroup
          label={t("marketplaceTransmission")}
          value={fields.transmission}
          options={transmissionOptions}
          onChange={(transmission) => setField("transmission", transmission)}
        />
        <ChoiceGroup
          label={t("sellCarFuelType")}
          value={fields.fuelType}
          options={fuelOptions}
          onChange={(fuelType) => setField("fuelType", fuelType)}
        />

        <SearchableSelectField
          allowCustomValue
          closeLabel={selectOptions.closeLabel}
          customValueLabel={selectOptions.customValueLabel}
          emptyLabel={selectOptions.emptyLabel}
          label={t("marketplaceCity")}
          options={selectOptions.cityOptions}
          placeholder={selectOptions.cityPlaceholder}
          searchPlaceholder={selectOptions.citySearchPlaceholder}
          value={fields.city}
          onChange={(city) => setField("city", city)}
        />

        <FormField
          multiline
          label={t("sellCarDescription")}
          value={fields.description}
          onChangeText={(value) => setField("description", value)}
        />

        <ChoiceGroup<MobileMarketplaceListingCondition>
          label={t("marketplaceCondition")}
          value={fields.condition}
          options={conditionOptions}
          onChange={(condition) => setField("condition", condition)}
        />

        <View style={styles.photoSection}>
          <Text style={styles.fieldLabel}>{t("sellCarPhotosLabel")}</Text>
          <Text style={styles.photoSectionHint}>{t("sellCarPhotosHint")}</Text>
          {images.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.photoThumbRow}>
              {images.map((image) => (
                <View key={image.storageId} style={styles.photoThumb}>
                  {image.previewUrl ? (
                    <Image source={{ uri: image.previewUrl }} style={styles.photoThumbImage} resizeMode="cover" />
                  ) : (
                    <View style={styles.photoThumbPlaceholder}>
                      <Icon color="mutedText" name="vehicles" size={20} />
                    </View>
                  )}
                  <Pressable
                    accessibilityLabel={t("sellCarRemovePhoto")}
                    accessibilityRole="button"
                    hitSlop={6}
                    style={styles.photoThumbRemove}
                    onPress={() => removeImage(image.storageId)}
                  >
                    <Icon color="onPrimary" name="close" size={14} />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : (
            <Text style={styles.photoSectionEmpty}>{t("sellCarNoPhotosYet")}</Text>
          )}
          <Button
            disabled={uploadingPhotos || images.length >= MAX_LISTING_IMAGES}
            label={uploadingPhotos ? t("sellCarUploading") : t("sellCarUploadPhotos")}
            leadingIcon="photos"
            variant="secondary"
            onPress={() => void pickAndUploadPhotos()}
          />
          {imagesError ? <Text style={styles.errorText}>{imagesError}</Text> : null}
        </View>

        {formError ? <Text style={styles.errorText}>{formError}</Text> : null}

        <Button
          disabled={submitting || uploadingPhotos}
          label={submitting ? t("sellCarSubmitting") : t("sellCarSubmit")}
          onPress={() => void handleSubmit()}
        />
      </ScrollView>
    );
  }

  return embedded ? body : <Screen>{body}</Screen>;
}

const makeStyles = (theme: AppTheme) =>
  StyleSheet.create({
    scroll: {
      flex: 1,
    },
    content: {
      gap: theme.spacing.md,
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
    },
    emptyContent: {
      flexGrow: 1,
      justifyContent: "center",
      padding: theme.spacing.lg,
    },
    headerText: {
      gap: theme.spacing.xs,
    },
    title: {
      color: theme.colors.text,
      fontSize: 24,
      fontWeight: "800",
    },
    subtitle: {
      color: theme.colors.mutedText,
      fontSize: 14,
      lineHeight: 20,
    },
    field: {
      gap: theme.spacing.xs,
    },
    fieldLabel: {
      color: theme.colors.mutedText,
      fontSize: 12,
      fontWeight: "600",
    },
    choiceWrap: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: theme.spacing.xs,
    },
    choiceButton: {
      minHeight: 38,
      minWidth: 72,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.md,
    },
    choiceButtonSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.primarySoft,
    },
    choiceText: {
      color: theme.colors.mutedText,
      fontSize: 12,
      fontWeight: "600",
      textAlign: "center",
    },
    choiceTextSelected: {
      color: theme.colors.text,
    },
    photoSection: {
      gap: theme.spacing.sm,
    },
    photoSectionHint: {
      color: theme.colors.subtleText,
      fontSize: 12,
      lineHeight: 17,
    },
    photoSectionEmpty: {
      color: theme.colors.mutedText,
      fontSize: 13,
    },
    photoThumbRow: {
      flexDirection: "row",
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    photoThumb: {
      width: 84,
      height: 64,
      borderRadius: theme.radius.md,
      overflow: "hidden",
      backgroundColor: theme.colors.surfaceAlt,
    },
    photoThumbImage: {
      width: "100%",
      height: "100%",
    },
    photoThumbPlaceholder: {
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
    },
    photoThumbRemove: {
      position: "absolute",
      top: 4,
      end: 4,
      width: 20,
      height: 20,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: "rgba(0,0,0,0.55)",
    },
    errorText: {
      color: theme.colors.danger,
      fontSize: 13,
      lineHeight: 19,
    },
    successCard: {
      alignItems: "center",
      gap: theme.spacing.sm,
      padding: theme.spacing.xl,
    },
    successIcon: {
      width: 52,
      height: 52,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.radius.full,
      backgroundColor: theme.colors.successSoft,
    },
    successTitle: {
      color: theme.colors.text,
      fontSize: 18,
      fontWeight: "800",
      textAlign: "center",
    },
    successBody: {
      color: theme.colors.mutedText,
      fontSize: 14,
      lineHeight: 20,
      textAlign: "center",
    },
    pressed: {
      opacity: 0.82,
    },
  });
