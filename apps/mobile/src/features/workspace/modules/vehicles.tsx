import { useMutation, usePaginatedQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { Alert, Image, Text, View } from "react-native";
import { GuidedStepFlow, type GuidedStep } from "../../../components/GuidedStepFlow";
import { api, type MobileVehicle, type MobileVehicleStatus } from "../../../convexApi";
import { getFuelTypeOptions, getTransmissionOptions, getVehicleColorOptions, getVehicleMakeOptions } from "../../../data/mobileOptions";
import { useLocale } from "../../../providers/LocaleProvider";
import { getMobileVinReadiness, normalizeVinInput } from "../mobileVinDecode";
import { PAGE_SIZE, type Option, fetchDecodedMobileVin, vinNotReadyMessage, vinChecksumWarningMessage, vinDecodeResultMessage, compactNumber, money, maybeText, parseOptionalNumber, parseRequiredNumber, useGenericError, SearchInput, PrimaryButton, SegmentedControl, FormField, SelectField, FormModal, MetricCard, ModuleList, getOptionLabel, firstVehicleImageUrl, DetailPill, SummaryRow, SummaryPanel, WizardActions } from "./moduleShared";
import { styles } from "./moduleStyles";

export function VehiclesModule({ orgId }: { orgId: string }) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const createVehicle = useMutation(api.vehicles.create);
  const updateVehicle = useMutation(api.vehicles.update);
  const archiveVehicle = useMutation(api.vehicles.softDelete);
  const [filter, setFilter] = useState<MobileVehicleStatus | "ALL">("ALL");
  const { loadMore, results, status } = usePaginatedQuery(
    api.vehicles.list,
    filter === "ALL" ? { orgId } : { orgId, status: filter },
    { initialNumItems: PAGE_SIZE },
  );
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MobileVehicle | null>(null);
  const [detailVehicle, setDetailVehicle] = useState<MobileVehicle | null>(null);
  const [open, setOpen] = useState(false);
  const [vehicleStep, setVehicleStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [decodingVin, setDecodingVin] = useState(false);
  const vinDecodeRequestRef = useRef(0);
  const formVinRef = useRef("");
  const [vinDecodeMessage, setVinDecodeMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    vin: "",
    make: "",
    model: "",
    trim: "",
    year: "",
    mileage: "",
    color: "",
    fuelType: "Gasoline",
    transmission: "Automatic",
    purchasePrice: "",
    sellingPrice: "",
    status: "AVAILABLE" as MobileVehicleStatus,
    notes: "",
  });
  const filtered = results.filter((vehicle) => {
    const haystack = `${vehicle.vin} ${vehicle.make} ${vehicle.model} ${vehicle.year}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });
  const availableCount = filtered.filter((vehicle) => vehicle.status === "AVAILABLE").length;
  const inventoryValue = filtered.reduce((sum, vehicle) => sum + vehicle.sellingPrice, 0);
  const projectedMargin = filtered.reduce(
    (sum, vehicle) => sum + Math.max(0, vehicle.sellingPrice - (vehicle.purchasePrice ?? vehicle.sellingPrice)),
    0,
  );
  const statusOptions: Array<Option<MobileVehicleStatus | "ALL">> = [
    { value: "ALL", label: locale === "ar" ? "الكل" : "All" },
    { value: "AVAILABLE", label: locale === "ar" ? "متاح" : "Available" },
    { value: "RESERVED", label: locale === "ar" ? "محجوز" : "Reserved" },
    { value: "SOLD", label: locale === "ar" ? "مباع" : "Sold" },
    { value: "IN_REPAIR", label: locale === "ar" ? "صيانة" : "Repair" },
    { value: "ARCHIVED", label: locale === "ar" ? "مؤرشف" : "Archived" },
  ];
  const vehicleMakeOptions = getVehicleMakeOptions();
  const vehicleColorOptions = getVehicleColorOptions(locale);
  const fuelTypeOptions = getFuelTypeOptions(locale);
  const transmissionOptions = getTransmissionOptions(locale);
  const customValueLabel = locale === "ar" ? 'استخدام "{value}"' : 'Use "{value}"';
  const vehicleSteps: GuidedStep[] = [
    {
      title: locale === "ar" ? "تعريف السيارة" : "Identify vehicle",
      subtitle: locale === "ar" ? "افحص رقم الشاصي واملأ بيانات السيارة تلقائياً." : "Decode the VIN and auto-fill core vehicle details.",
    },
    {
      title: locale === "ar" ? "المواصفات والسعر" : "Specs and pricing",
      subtitle: locale === "ar" ? "أكمل اللون، القير، السعر، والحالة." : "Complete color, transmission, pricing, and status.",
    },
    {
      title: locale === "ar" ? "المراجعة" : "Review",
      subtitle: locale === "ar" ? "راجع البطاقة قبل إضافتها للمخزون." : "Check the inventory card before saving.",
    },
  ];
  const vehicleVinReadiness = getMobileVinReadiness(form.vin);
  const selectedVehicleStatusLabel = getOptionLabel(
    statusOptions.filter((option) => option.value !== "ALL").map((option) => ({
      label: option.label,
      value: option.value,
    })),
    form.status,
    form.status,
  );

  useEffect(() => {
    formVinRef.current = form.vin;
  }, [form.vin]);

  function openCreate() {
    vinDecodeRequestRef.current += 1;
    setEditing(null);
    setVehicleStep(0);
    setVinDecodeMessage(null);
    setForm({
      vin: "",
      make: "",
      model: "",
      trim: "",
      year: "",
      mileage: "",
      color: "",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: "",
      sellingPrice: "",
      status: "AVAILABLE",
      notes: "",
    });
    setOpen(true);
  }

  function openEdit(vehicle: MobileVehicle) {
    vinDecodeRequestRef.current += 1;
    setEditing(vehicle);
    setDetailVehicle(null);
    setVehicleStep(0);
    setVinDecodeMessage(null);
    setForm({
      vin: vehicle.vin,
      make: vehicle.make,
      model: vehicle.model,
      trim: vehicle.trim ?? "",
      year: String(vehicle.year),
      mileage: String(vehicle.mileage),
      color: vehicle.color,
      fuelType: vehicle.fuelType,
      transmission: vehicle.transmission,
      purchasePrice: vehicle.purchasePrice !== undefined ? String(vehicle.purchasePrice) : "",
      sellingPrice: String(vehicle.sellingPrice),
      status: vehicle.status,
      notes: vehicle.notes ?? "",
    });
    setOpen(true);
  }

  function closeVehicleForm() {
    vinDecodeRequestRef.current += 1;
    setOpen(false);
    setEditing(null);
    setVehicleStep(0);
    setVinDecodeMessage(null);
  }

  async function decodeVehicleVin() {
    const vin = normalizeVinInput(form.vin);
    const requestId = vinDecodeRequestRef.current + 1;
    vinDecodeRequestRef.current = requestId;
    formVinRef.current = vin;
    const readiness = getMobileVinReadiness(vin);
    const readinessMessage = vinNotReadyMessage(readiness, locale);
    setForm((prev) => ({ ...prev, vin }));

    if (readinessMessage) {
      setVinDecodeMessage(readinessMessage);
      Alert.alert(locale === "ar" ? "رقم الشاصي غير جاهز" : "VIN is not ready", readinessMessage);
      return;
    }

    setDecodingVin(true);
    setVinDecodeMessage(
      readiness === "checksum-warning"
        ? vinChecksumWarningMessage(locale)
        : null,
    );

    try {
      const decoded = await fetchDecodedMobileVin(vin);
      if (vinDecodeRequestRef.current !== requestId || normalizeVinInput(formVinRef.current) !== vin) {
        return;
      }
      setForm((prev) => ({
        ...prev,
        vin: decoded.vin,
        make: decoded.make ?? prev.make,
        model: decoded.model ?? prev.model,
        trim: decoded.trim ?? prev.trim,
        year: decoded.year ? String(decoded.year) : prev.year,
        fuelType: decoded.fuelType ?? prev.fuelType,
      }));
      setVinDecodeMessage(vinDecodeResultMessage(decoded, locale));
    } catch (error) {
      if (vinDecodeRequestRef.current !== requestId) {
        return;
      }
      reportError("Mobile VIN decode failed", error);
      setVinDecodeMessage(locale === "ar" ? "تعذر فك رقم الشاصي الآن." : "Could not decode VIN right now.");
    } finally {
      if (vinDecodeRequestRef.current === requestId) {
        setDecodingVin(false);
      }
    }
  }

  async function save() {
    const vin = normalizeVinInput(form.vin);
    const year = parseRequiredNumber(form.year);
    const mileage = parseRequiredNumber(form.mileage);
    const sellingPrice = parseRequiredNumber(form.sellingPrice);
    if (!form.make.trim() || !form.model.trim() || year === null || mileage === null || sellingPrice === null) {
      Alert.alert(locale === "ar" ? "حقول مطلوبة" : "Required fields");
      return;
    }
    if (!vin) {
      Alert.alert(locale === "ar" ? "رقم الشاصي مطلوب" : "VIN is required");
      return;
    }
    const readinessMessage = vinNotReadyMessage(getMobileVinReadiness(vin), locale);
    if (readinessMessage) {
      Alert.alert(locale === "ar" ? "رقم الشاصي غير جاهز" : "VIN is not ready", readinessMessage);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        orgId,
        vin,
        make: form.make,
        model: form.model,
        trim: maybeText(form.trim),
        year,
        mileage,
        color: form.color || "-",
        fuelType: form.fuelType || "-",
        transmission: form.transmission || "-",
        purchasePrice: parseOptionalNumber(form.purchasePrice),
        sellingPrice,
        status: form.status,
        notes: maybeText(form.notes),
      };
      if (editing) {
        await updateVehicle({ ...payload, vehicleId: editing._id });
      } else {
        await createVehicle({ ...payload, sourceType: "STOCK" as const });
      }
      setOpen(false);
      setEditing(null);
    } catch (error) {
      reportError("Mobile vehicle save failed", error);
    } finally {
      setSaving(false);
    }
  }

  async function archive(vehicle: MobileVehicle) {
    Alert.alert(
      locale === "ar" ? "أرشفة السيارة؟" : "Archive vehicle?",
      `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      [
        { text: locale === "ar" ? "إلغاء" : "Cancel", style: "cancel" },
        {
          text: locale === "ar" ? "أرشفة" : "Archive",
          style: "destructive",
          onPress: async () => {
            try {
              await archiveVehicle({ orgId, vehicleId: vehicle._id });
            } catch (error) {
              reportError("Mobile vehicle archive failed", error);
            }
          },
        },
      ],
    );
  }

  return (
    <>
      <ModuleList
        data={filtered}
        emptyLabel={locale === "ar" ? "لا توجد سيارات." : "No vehicles found."}
        keyExtractor={(vehicle) => vehicle._id}
        loadMore={loadMore}
        status={status}
        header={
          <>
            <View style={styles.actionRow}>
              <SearchInput placeholder={locale === "ar" ? "بحث المخزون" : "Search inventory"} value={search} onChangeText={setSearch} />
              <PrimaryButton label={locale === "ar" ? "إضافة" : "Add"} onPress={openCreate} />
            </View>
            <SegmentedControl options={statusOptions} value={filter} onChange={setFilter} />
            <View style={styles.metricGrid}>
              <MetricCard title={locale === "ar" ? "النتائج" : "Results"} value={compactNumber(filtered.length, locale)} caption={locale === "ar" ? "مطابقة للبحث" : "matching search"} />
              <MetricCard title={locale === "ar" ? "المتاح" : "Available"} value={compactNumber(availableCount, locale)} caption={locale === "ar" ? "جاهز للبيع" : "ready to sell"} />
              <MetricCard title={locale === "ar" ? "القيمة" : "Value"} value={money(inventoryValue, locale)} caption={locale === "ar" ? "سعر البيع" : "list value"} />
              <MetricCard title={locale === "ar" ? "الهامش" : "Margin"} value={money(projectedMargin, locale)} caption={locale === "ar" ? "تقديري" : "projected"} />
            </View>
          </>
        }
        renderItem={(vehicle) => {
          const imageUrl = firstVehicleImageUrl(vehicle);
          return (
            <View style={styles.vehicleRecordCard}>
              <View style={styles.vehicleMediaRow}>
                <View style={styles.vehicleThumb}>
                  {imageUrl ? (
                    <Image
                      source={{ uri: imageUrl }}
                      style={styles.vehicleThumbImage}
                      resizeMode="cover"
                    />
                  ) : (
                    <Text style={styles.vehicleThumbText}>{vehicle.make.slice(0, 2).toUpperCase()}</Text>
                  )}
                </View>
                <View style={styles.vehicleCardText}>
                  <View style={styles.recordHeader}>
                    <Text style={styles.recordTitle}>{vehicle.year} {vehicle.make} {vehicle.model}</Text>
                    <Text style={styles.statusPill}>{vehicle.status}</Text>
                  </View>
                  <Text style={styles.recordMeta}>{vehicle.trim || vehicle.vin}</Text>
                  <Text style={styles.vehiclePrice}>{money(vehicle.sellingPrice, locale)}</Text>
                  <View style={styles.detailPillRow}>
                    <DetailPill label={`${vehicle.mileage.toLocaleString()} km`} tone="info" />
                    <DetailPill label={vehicle.transmission || "-"} />
                  </View>
                </View>
              </View>
              <View style={styles.vehicleFactRow}>
                <Text style={styles.recordMeta}>{vehicle.vin}</Text>
                <Text style={styles.recordMeta}>{vehicle.color || "-"} · {vehicle.fuelType || "-"}</Text>
              </View>
              {vehicle.pendingStatusRequest ? <Text style={styles.warningText}>{vehicle.pendingStatusRequest}</Text> : null}
              <View style={styles.cardActions}>
                <PrimaryButton label={locale === "ar" ? "تفاصيل" : "Details"} tone="muted" onPress={() => setDetailVehicle(vehicle)} />
                <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} tone="muted" onPress={() => openEdit(vehicle)} />
                <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => archive(vehicle)} />
              </View>
            </View>
          );
        }}
      />
      <FormModal title={editing ? (locale === "ar" ? "تعديل سيارة" : "Edit vehicle") : (locale === "ar" ? "سيارة جديدة" : "New vehicle")} visible={open} onClose={closeVehicleForm}>
        <GuidedStepFlow activeIndex={vehicleStep} steps={vehicleSteps}>
          {vehicleStep === 0 ? (
            <>
              <View style={styles.inlineActionGroup}>
                <View style={styles.inlineActionField}>
                  <FormField
                    label="VIN"
                    value={form.vin}
                    onChangeText={(vin) => {
                      const normalizedVin = normalizeVinInput(vin);
                      formVinRef.current = normalizedVin;
                      setVinDecodeMessage(null);
                      setForm((prev) => ({ ...prev, vin: normalizedVin }));
                    }}
                  />
                </View>
                <PrimaryButton
                  disabled={decodingVin}
                  label={decodingVin ? (locale === "ar" ? "جاري الفحص..." : "Decoding...") : (locale === "ar" ? "فك الرقم" : "Decode VIN")}
                  tone="muted"
                  onPress={decodeVehicleVin}
                />
              </View>
              {vehicleVinReadiness === "checksum-warning" ? (
                <Text style={styles.warningText}>
                  {locale === "ar"
                    ? "رقم التحقق لا يطابق هذا الشاصي، لكنه قد يكون صحيحاً لبعض الأسواق."
                    : "Checksum does not match; this can still be valid for some markets."}
                </Text>
              ) : null}
              {vinDecodeMessage ? <Text style={styles.recordMeta}>{vinDecodeMessage}</Text> : null}
              <SelectField allowCustomValue customValueLabel={customValueLabel} label={locale === "ar" ? "الماركة" : "Make"} value={form.make} options={vehicleMakeOptions} onChange={(make) => setForm((prev) => ({ ...prev, make }))} />
              <FormField label={locale === "ar" ? "الموديل" : "Model"} value={form.model} onChangeText={(model) => setForm((prev) => ({ ...prev, model }))} />
              <FormField label={locale === "ar" ? "الفئة" : "Trim"} value={form.trim} onChangeText={(trim) => setForm((prev) => ({ ...prev, trim }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "السنة" : "Year"} value={form.year} onChangeText={(year) => setForm((prev) => ({ ...prev, year }))} />
            </>
          ) : null}
          {vehicleStep === 1 ? (
            <>
              <FormField keyboardType="numeric" label={locale === "ar" ? "الممشى" : "Mileage"} value={form.mileage} onChangeText={(mileage) => setForm((prev) => ({ ...prev, mileage }))} />
              <SelectField allowCustomValue customValueLabel={customValueLabel} label={locale === "ar" ? "اللون" : "Color"} value={form.color} options={vehicleColorOptions} onChange={(color) => setForm((prev) => ({ ...prev, color }))} />
              <SelectField allowCustomValue customValueLabel={customValueLabel} label={locale === "ar" ? "الوقود" : "Fuel"} value={form.fuelType} options={fuelTypeOptions} onChange={(fuelType) => setForm((prev) => ({ ...prev, fuelType }))} />
              <SelectField allowCustomValue customValueLabel={customValueLabel} label={locale === "ar" ? "القير" : "Transmission"} value={form.transmission} options={transmissionOptions} onChange={(transmission) => setForm((prev) => ({ ...prev, transmission }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "سعر الشراء" : "Purchase price"} value={form.purchasePrice} onChangeText={(purchasePrice) => setForm((prev) => ({ ...prev, purchasePrice }))} />
              <FormField keyboardType="numeric" label={locale === "ar" ? "سعر البيع" : "Selling price"} value={form.sellingPrice} onChangeText={(sellingPrice) => setForm((prev) => ({ ...prev, sellingPrice }))} />
              <SelectField
                label={locale === "ar" ? "الحالة" : "Status"}
                value={form.status}
                onChange={(value) => setForm((prev) => ({ ...prev, status: value as MobileVehicleStatus }))}
                options={statusOptions.filter((option) => option.value !== "ALL").map((option) => ({ label: option.label, value: option.value }))}
              />
            </>
          ) : null}
          {vehicleStep === 2 ? (
            <>
              <FormField multiline label={locale === "ar" ? "ملاحظات" : "Notes"} value={form.notes} onChangeText={(notes) => setForm((prev) => ({ ...prev, notes }))} />
              <SummaryPanel
                title={locale === "ar" ? "بطاقة المخزون" : "Inventory card"}
                subtitle={locale === "ar" ? "هذه هي البيانات التي ستظهر في المخزون." : "These details will be saved into inventory."}
              >
                <SummaryRow label={locale === "ar" ? "السيارة" : "Vehicle"} value={`${form.year || "-"} ${form.make || "-"} ${form.model || "-"}`} />
                <SummaryRow label={locale === "ar" ? "الفئة" : "Trim"} value={form.trim || "-"} />
                <SummaryRow label="VIN" value={form.vin || "-"} />
                <SummaryRow label={locale === "ar" ? "المواصفات" : "Specs"} value={`${form.color || "-"} · ${form.fuelType || "-"} · ${form.transmission || "-"}`} />
                <SummaryRow label={locale === "ar" ? "الممشى" : "Mileage"} value={form.mileage ? `${form.mileage} km` : "-"} />
                <SummaryRow label={locale === "ar" ? "سعر البيع" : "Selling price"} value={money(parseOptionalNumber(form.sellingPrice), locale)} />
                <SummaryRow label={locale === "ar" ? "الحالة" : "Status"} value={selectedVehicleStatusLabel} />
              </SummaryPanel>
            </>
          ) : null}
          <WizardActions
            activeStep={vehicleStep}
            backLabel={locale === "ar" ? "السابق" : "Back"}
            nextLabel={locale === "ar" ? "التالي" : "Next"}
            saveLabel={saving ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ السيارة" : "Save vehicle")}
            saving={saving}
            totalSteps={vehicleSteps.length}
            onBack={() => setVehicleStep((step) => Math.max(0, step - 1))}
            onNext={() => setVehicleStep((step) => Math.min(vehicleSteps.length - 1, step + 1))}
            onSave={save}
          />
        </GuidedStepFlow>
      </FormModal>
      <FormModal
        title={detailVehicle ? `${detailVehicle.year} ${detailVehicle.make} ${detailVehicle.model}` : ""}
        visible={Boolean(detailVehicle)}
        onClose={() => setDetailVehicle(null)}
      >
        {detailVehicle ? (
          <>
            <SummaryPanel
              title={locale === "ar" ? "بطاقة السيارة" : "Vehicle card"}
              subtitle={locale === "ar" ? "ملخص سريع قبل التعديل أو التواصل مع العميل." : "A fast read before editing or talking to a buyer."}
            >
              <SummaryRow label="VIN" value={detailVehicle.vin || "-"} />
              <SummaryRow label={locale === "ar" ? "الحالة" : "Status"} value={detailVehicle.status} />
              <SummaryRow label={locale === "ar" ? "سعر البيع" : "Selling price"} value={money(detailVehicle.sellingPrice, locale)} />
              <SummaryRow label={locale === "ar" ? "سعر الشراء" : "Purchase price"} value={money(detailVehicle.purchasePrice, locale)} />
              <SummaryRow label={locale === "ar" ? "الممشى" : "Mileage"} value={`${detailVehicle.mileage.toLocaleString()} km`} />
              <SummaryRow label={locale === "ar" ? "المواصفات" : "Specs"} value={`${detailVehicle.color || "-"} · ${detailVehicle.fuelType || "-"} · ${detailVehicle.transmission || "-"}`} />
              {detailVehicle.notes ? <SummaryRow label={locale === "ar" ? "ملاحظات" : "Notes"} value={detailVehicle.notes} /> : null}
            </SummaryPanel>
            <View style={styles.cardActions}>
              <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} onPress={() => openEdit(detailVehicle)} />
              <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => archive(detailVehicle)} />
            </View>
          </>
        ) : null}
      </FormModal>
    </>
  );
}

