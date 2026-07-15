import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { Alert, Image, ScrollView, Text, View } from "react-native";
import {
  api,
  type MobileDepositMethod,
  type MobileLandedCostPaymentMethod,
  type MobileReservationStatus,
  type MobileVehicle,
} from "../../../convexApi";
import { useLocale } from "../../../providers/LocaleProvider";
import {
  Chip,
  DetailPill,
  FormField,
  FormModal,
  PrimaryButton,
  SelectField,
  SummaryPanel,
  SummaryRow,
  dateLabel,
  idempotencyKey,
  money,
  parseOptionalNumber,
  useGenericError,
} from "./moduleShared";
import { styles } from "./moduleStyles";

const PERMISSION = {
  viewInfo: "view:vehicle_info",
  viewLeads: "view:vehicle_leads",
  viewExpenses: "view:vehicle_expenses",
  viewTasks: "view:vehicle_tasks",
  viewTestDrives: "view:vehicle_test_drives",
  viewWorkOrders: "view:vehicle_work_orders",
  viewValuations: "view:vehicle_valuations",
  viewCustomers: "view:customers",
  editVehicles: "edit:vehicles",
  approveRequests: "approve:requests",
} as const;

type DetailTab =
  | "overview"
  | "activity"
  | "expenses"
  | "tasks"
  | "drives"
  | "work"
  | "costs"
  | "pricing"
  | "holds"
  | "valuations";

type EditableLandedItem = {
  key: string;
  label: string;
  amount: string;
  paymentMethod: MobileLandedCostPaymentMethod;
};

let landedItemKeyCounter = 0;

function nextLandedItemKey(): string {
  landedItemKeyCounter += 1;
  return `landed-${landedItemKeyCounter}`;
}

export function VehicleDetailSheet({
  onArchive,
  onClose,
  onEdit,
  orgId,
  permissions,
  vehicle,
}: {
  onArchive: (vehicle: MobileVehicle) => void;
  onClose: () => void;
  onEdit: (vehicle: MobileVehicle) => void;
  orgId: string;
  permissions: readonly string[];
  vehicle: MobileVehicle | null;
}) {
  const { locale } = useLocale();
  const reportError = useGenericError();
  const can = (permission: string) => permissions.includes(permission);

  const tabs: Array<{ id: DetailTab; label: string }> = [];
  if (can(PERMISSION.viewInfo)) tabs.push({ id: "overview", label: locale === "ar" ? "نظرة عامة" : "Overview" });
  if (can(PERMISSION.viewLeads)) tabs.push({ id: "activity", label: locale === "ar" ? "الفرص والمبيعات" : "Leads & Sales" });
  if (can(PERMISSION.viewExpenses)) tabs.push({ id: "expenses", label: locale === "ar" ? "المصاريف" : "Expenses" });
  if (can(PERMISSION.viewTasks)) tabs.push({ id: "tasks", label: locale === "ar" ? "المهام" : "Tasks" });
  if (can(PERMISSION.viewTestDrives)) tabs.push({ id: "drives", label: locale === "ar" ? "تجارب القيادة" : "Test drives" });
  if (can(PERMISSION.viewWorkOrders)) tabs.push({ id: "work", label: locale === "ar" ? "أوامر العمل" : "Work orders" });
  if (can(PERMISSION.viewValuations)) tabs.push({ id: "valuations", label: locale === "ar" ? "التثمينات" : "Valuations" });
  if (can(PERMISSION.viewInfo)) {
    tabs.push({ id: "costs", label: locale === "ar" ? "التكلفة الكلية" : "Landed cost" });
    tabs.push({ id: "pricing", label: locale === "ar" ? "سجل الأسعار" : "Pricing" });
    tabs.push({ id: "holds", label: locale === "ar" ? "الحجوزات" : "Reservations" });
  }

  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const vehicleId = vehicle?._id ?? null;
  const firstTabId = tabs[0]?.id ?? "overview";

  useEffect(() => {
    setActiveTab(firstTabId);
  }, [vehicleId, firstTabId]);

  const scopedArgs = vehicleId ? { orgId, vehicleId } : null;
  const relations = useQuery(api.vehicles.getRelations, scopedArgs ?? "skip");
  const deposits = useQuery(
    api.deposits.listByVehicle,
    scopedArgs && activeTab === "overview" ? scopedArgs : "skip",
  );
  const landedCosts = useQuery(
    api.vehicles.getLandedCosts,
    scopedArgs && activeTab === "costs" ? scopedArgs : "skip",
  );
  const pricingHistory = useQuery(
    api.vehicles.getPricingHistory,
    scopedArgs && activeTab === "pricing" ? scopedArgs : "skip",
  );
  const reservationHistory = useQuery(
    api.vehicles.getReservationHistory,
    scopedArgs && activeTab === "holds" ? scopedArgs : "skip",
  );
  const valuations = useQuery(
    api.finance.listValuations,
    scopedArgs && activeTab === "valuations" ? scopedArgs : "skip",
  );
  const financeCompanies = useQuery(
    api.finance.listCompanies,
    vehicleId && activeTab === "valuations" ? { orgId } : "skip",
  );
  const customersPage = useQuery(
    api.customers.list,
    vehicleId && activeTab === "holds" && can(PERMISSION.viewCustomers)
      ? { orgId, paginationOpts: { numItems: 100, cursor: null } }
      : "skip",
  );

  const releaseDeposit = useMutation(api.deposits.release);
  const upsertLandedCosts = useMutation(api.vehicles.upsertLandedCosts);
  const createReservation = useMutation(api.vehicles.createReservation);
  const releaseReservation = useMutation(api.vehicles.releaseReservation);

  const [releasingDepositId, setReleasingDepositId] = useState<string | null>(null);
  const [refundMethodByDeposit, setRefundMethodByDeposit] = useState<Record<string, MobileDepositMethod>>({});
  const [landedItems, setLandedItems] = useState<EditableLandedItem[]>([]);
  const [savingCosts, setSavingCosts] = useState(false);
  const [reservationCustomerId, setReservationCustomerId] = useState("");
  const [reservationDeposit, setReservationDeposit] = useState("");
  const [reservationHoldDays, setReservationHoldDays] = useState("");
  const [savingReservation, setSavingReservation] = useState(false);

  useEffect(() => {
    if (landedCosts) {
      // Rows saved before per-item payment methods existed have none — show
      // them as CASH, the same default the backend used to apply.
      setLandedItems(
        landedCosts.items.map((item) => ({
          key: nextLandedItemKey(),
          label: item.label,
          amount: String(item.amount),
          paymentMethod: item.paymentMethod ?? "CASH",
        })),
      );
    } else if (landedCosts === null) {
      setLandedItems([]);
    }
  }, [landedCosts]);

  useEffect(() => {
    setReservationCustomerId("");
    setReservationDeposit("");
    setReservationHoldDays("");
    setRefundMethodByDeposit({});
  }, [vehicleId]);

  const canEdit = can(PERMISSION.editVehicles);
  const canResolveDeposits = can(PERMISSION.approveRequests);

  const paymentMethodOptions: Array<{ label: string; value: MobileLandedCostPaymentMethod }> = [
    { value: "CASH", label: locale === "ar" ? "نقداً" : "Cash" },
    { value: "BANK_TRANSFER", label: locale === "ar" ? "حوالة بنكية" : "Bank transfer" },
    { value: "CHEQUE", label: locale === "ar" ? "شيك" : "Cheque" },
    { value: "CARD", label: locale === "ar" ? "بطاقة" : "Card" },
  ];

  const reservationStatusLabel = (status: MobileReservationStatus): string => {
    if (status === "ACTIVE") return locale === "ar" ? "نشط" : "Active";
    if (status === "RELEASED") return locale === "ar" ? "مُلغى" : "Released";
    if (status === "EXPIRED") return locale === "ar" ? "منتهي" : "Expired";
    return locale === "ar" ? "تحول لبيع" : "Converted";
  };

  const statusLabel = (status: MobileVehicle["status"]): string => {
    const labels: Record<MobileVehicle["status"], [string, string]> = {
      AVAILABLE: ["Available", "متاح"],
      RESERVED: ["Reserved", "محجوز"],
      SOLD: ["Sold", "مباع"],
      IN_INSPECTION: ["In inspection", "قيد الفحص"],
      IN_REPAIR: ["In repair", "قيد الصيانة"],
      ARCHIVED: ["Archived", "مؤرشف"],
      SOURCING: ["Sourcing", "قيد التوريد"],
    };
    return locale === "ar" ? labels[status][1] : labels[status][0];
  };

  async function handleReleaseDeposit(depositId: string, resolution: "REFUNDED" | "FORFEITED") {
    setReleasingDepositId(depositId);
    try {
      await releaseDeposit({
        orgId,
        depositId,
        resolution,
        refundMethod: resolution === "REFUNDED" ? (refundMethodByDeposit[depositId] ?? "CASH") : undefined,
        idempotencyKey: idempotencyKey("deposit-release"),
      });
    } catch (error) {
      reportError("Mobile deposit release failed", error);
    } finally {
      setReleasingDepositId(null);
    }
  }

  function confirmReleaseDeposit(depositId: string, amount: number, resolution: "REFUNDED" | "FORFEITED") {
    const actionLabel =
      resolution === "REFUNDED"
        ? locale === "ar" ? "استرداد" : "Refund"
        : locale === "ar" ? "مصادرة" : "Forfeit";
    Alert.alert(
      resolution === "REFUNDED"
        ? locale === "ar" ? "استرداد العربون؟" : "Refund deposit?"
        : locale === "ar" ? "مصادرة العربون؟" : "Forfeit deposit?",
      money(amount, locale),
      [
        { text: locale === "ar" ? "إلغاء" : "Cancel", style: "cancel" },
        {
          text: actionLabel,
          style: resolution === "FORFEITED" ? "destructive" : "default",
          onPress: () => void handleReleaseDeposit(depositId, resolution),
        },
      ],
    );
  }

  async function saveLandedCosts() {
    if (!vehicleId) return;
    const items = landedItems
      .map((item) => ({
        label: item.label.trim(),
        amount: parseOptionalNumber(item.amount) ?? 0,
        paymentMethod: item.paymentMethod,
      }))
      .filter((item) => item.label.length > 0);
    setSavingCosts(true);
    try {
      await upsertLandedCosts({ orgId, vehicleId, items });
      Alert.alert(locale === "ar" ? "تم حفظ التكلفة الكلية." : "Landed costs saved.");
    } catch (error) {
      reportError("Mobile landed cost save failed", error);
    } finally {
      setSavingCosts(false);
    }
  }

  async function handleCreateReservation() {
    if (!vehicleId || !reservationCustomerId) return;
    const holdDays = parseOptionalNumber(reservationHoldDays);
    setSavingReservation(true);
    try {
      await createReservation({
        orgId,
        vehicleId,
        customerId: reservationCustomerId,
        depositAmount: parseOptionalNumber(reservationDeposit),
        expiresAt: holdDays !== undefined && holdDays > 0 ? Date.now() + holdDays * 24 * 60 * 60 * 1000 : undefined,
      });
      setReservationCustomerId("");
      setReservationDeposit("");
      setReservationHoldDays("");
      Alert.alert(locale === "ar" ? "تم إنشاء الحجز." : "Reservation created.");
    } catch (error) {
      reportError("Mobile reservation create failed", error);
    } finally {
      setSavingReservation(false);
    }
  }

  async function handleReleaseReservation(reservationId: string) {
    setSavingReservation(true);
    try {
      await releaseReservation({ orgId, reservationId });
    } catch (error) {
      reportError("Mobile reservation release failed", error);
    } finally {
      setSavingReservation(false);
    }
  }

  if (!vehicle) {
    return null;
  }

  const galleryUrls = (vehicle.imageUrls ?? []).filter((url): url is string => Boolean(url));
  const loadingLabel = locale === "ar" ? "جاري التحميل..." : "Loading...";
  const totalExpenses = (relations?.expenses ?? []).reduce((sum, expense) => sum + expense.amount, 0);
  const customerOptions = (customersPage?.page ?? []).map((customer) => ({
    label: `${customer.firstName} ${customer.lastName}`,
    value: customer._id,
  }));
  const companyNameById = new Map((financeCompanies ?? []).map((company) => [company._id, company.name]));

  return (
    <FormModal
      title={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
      visible
      onClose={onClose}
    >
      {galleryUrls.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.galleryStrip}>
          {galleryUrls.map((url) => (
            <Image key={url} resizeMode="cover" source={{ uri: url }} style={styles.galleryImage} />
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.cardActions}>
        {canEdit ? (
          <PrimaryButton label={locale === "ar" ? "تعديل" : "Edit"} onPress={() => onEdit(vehicle)} />
        ) : null}
        {canEdit ? (
          <PrimaryButton label={locale === "ar" ? "أرشفة" : "Archive"} tone="danger" onPress={() => onArchive(vehicle)} />
        ) : null}
      </View>
      {vehicle.pendingStatusRequest ? (
        <Text style={styles.warningText}>{vehicle.pendingStatusRequest}</Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.detailTabStrip}>
        {tabs.map((tab) => (
          <Chip
            key={tab.id}
            label={tab.label}
            selected={tab.id === activeTab}
            value={tab.id}
            onPress={() => setActiveTab(tab.id)}
          />
        ))}
      </ScrollView>

      {activeTab === "overview" ? (
        <View style={styles.detailSection}>
          <SummaryPanel
            title={locale === "ar" ? "بيانات السيارة" : "Vehicle record"}
            subtitle={locale === "ar" ? "كل تفاصيل السيارة وسجلاتها المرتبطة." : "Full details and linked records for this vehicle."}
          >
            <SummaryRow label="VIN" value={vehicle.vin || "-"} />
            <SummaryRow label={locale === "ar" ? "الحالة" : "Status"} value={statusLabel(vehicle.status)} />
            <SummaryRow label={locale === "ar" ? "الفئة" : "Trim"} value={vehicle.trim || "-"} />
            <SummaryRow
              label={locale === "ar" ? "المواصفات" : "Specs"}
              value={`${vehicle.color || "-"} · ${vehicle.fuelType || "-"} · ${vehicle.transmission || "-"}`}
            />
            <SummaryRow label={locale === "ar" ? "الممشى" : "Mileage"} value={`${vehicle.mileage.toLocaleString()} km`} />
            <SummaryRow label={locale === "ar" ? "سعر البيع" : "Selling price"} value={money(vehicle.sellingPrice, locale)} />
            {vehicle.purchasePrice !== undefined ? (
              <SummaryRow label={locale === "ar" ? "سعر الشراء" : "Purchase price"} value={money(vehicle.purchasePrice, locale)} />
            ) : null}
            {vehicle.sourceType === "SOURCED" ? (
              <SummaryRow
                label={locale === "ar" ? "مصدر خارجي" : "Sourced from"}
                value={vehicle.sourcedFromName || "-"}
              />
            ) : null}
            {vehicle.addedByName ? (
              <SummaryRow label={locale === "ar" ? "أضيفت بواسطة" : "Added by"} value={vehicle.addedByName} />
            ) : null}
            {vehicle.notes ? <SummaryRow label={locale === "ar" ? "ملاحظات" : "Notes"} value={vehicle.notes} /> : null}
          </SummaryPanel>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "العرابين" : "Deposits"}</Text>
          {deposits === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : deposits.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد عرابين لهذه السيارة." : "No deposits recorded for this vehicle."}</Text>
          ) : (
            deposits.map((deposit) => (
              <View key={deposit._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>{money(deposit.amount, locale)}</Text>
                  <DetailPill
                    label={deposit.status}
                    tone={deposit.status === "HELD" ? "warning" : deposit.status === "APPLIED" ? "success" : "info"}
                  />
                </View>
                {deposit.notes ? <Text style={styles.recordMeta}>{deposit.notes}</Text> : null}
                {deposit.status === "HELD" && canResolveDeposits ? (
                  <>
                    <SelectField
                      label={locale === "ar" ? "طريقة الاسترداد" : "Refund method"}
                      value={refundMethodByDeposit[deposit._id] ?? "CASH"}
                      options={paymentMethodOptions}
                      onChange={(method) =>
                        setRefundMethodByDeposit((prev) => ({
                          ...prev,
                          [deposit._id]: method as MobileDepositMethod,
                        }))
                      }
                    />
                    <View style={styles.cardActions}>
                      <PrimaryButton
                        disabled={releasingDepositId === deposit._id}
                        label={locale === "ar" ? "استرداد" : "Refund"}
                        tone="muted"
                        onPress={() => confirmReleaseDeposit(deposit._id, deposit.amount, "REFUNDED")}
                      />
                      <PrimaryButton
                        disabled={releasingDepositId === deposit._id}
                        label={locale === "ar" ? "مصادرة" : "Forfeit"}
                        tone="danger"
                        onPress={() => confirmReleaseDeposit(deposit._id, deposit.amount, "FORFEITED")}
                      />
                    </View>
                  </>
                ) : null}
              </View>
            ))
          )}
        </View>
      ) : null}

      {activeTab === "activity" ? (
        <View style={styles.detailSection}>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "سجل المبيعات" : "Sales record"}</Text>
          {relations === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : relations.sales.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد مبيعات لهذه السيارة." : "No sales recorded for this vehicle."}</Text>
          ) : (
            relations.sales.map((sale) => (
              <View key={sale._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>{sale.customerName}</Text>
                  <DetailPill label={sale.status} tone={sale.status === "COMPLETED" ? "success" : sale.status === "CANCELLED" ? "warning" : "info"} />
                </View>
                <Text style={styles.recordMeta}>
                  {dateLabel(sale.saleDate, locale)} · {money(sale.salePrice, locale)} · {sale.salespersonName}
                </Text>
              </View>
            ))
          )}
          <Text style={styles.sectionTitle}>{locale === "ar" ? "الفرص المرتبطة" : "Associated leads"}</Text>
          {relations === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : relations.leads.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد فرص مهتمة بهذه السيارة." : "No leads currently interested in this vehicle."}</Text>
          ) : (
            relations.leads.map((lead) => (
              <View key={lead._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>{lead.customerName}</Text>
                  <DetailPill label={lead.stage} tone="info" />
                </View>
                <Text style={styles.recordMeta}>
                  {(locale === "ar" ? "المصدر: " : "Source: ") + lead.source} · {lead.assignedUserName}
                </Text>
                {lead.notes ? <Text style={styles.recordMeta}>{lead.notes}</Text> : null}
              </View>
            ))
          )}
        </View>
      ) : null}

      {activeTab === "expenses" ? (
        <View style={styles.detailSection}>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "مصاريف السيارة" : "Vehicle expenses"}</Text>
          {relations === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : relations.expenses.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد مصاريف لهذه السيارة." : "No expenses recorded for this vehicle."}</Text>
          ) : (
            <>
              {relations.expenses.map((expense) => (
                <View key={expense._id} style={styles.detailRecordRow}>
                  <View style={styles.detailRowSplit}>
                    <Text style={styles.detailAmountText}>{expense.title}</Text>
                    <Text style={styles.detailAmountText}>{money(expense.amount, locale)}</Text>
                  </View>
                  <View style={styles.detailRowSplit}>
                    <Text style={styles.recordMeta}>
                      {dateLabel(expense.date, locale)} · {expense.category}
                    </Text>
                    <DetailPill label={expense.status} tone={expense.status === "PAID" ? "success" : "warning"} />
                  </View>
                  {expense.vendor || expense.payerName ? (
                    <Text style={styles.recordMeta}>
                      {[expense.vendor, expense.payerName].filter(Boolean).join(" · ")}
                    </Text>
                  ) : null}
                  {expense.notes ? <Text style={styles.recordMeta}>{expense.notes}</Text> : null}
                </View>
              ))}
              <View style={styles.detailTotalRow}>
                <Text style={styles.detailAmountText}>{locale === "ar" ? "إجمالي المصاريف" : "Total expenses"}</Text>
                <Text style={styles.detailAmountText}>{money(totalExpenses, locale)}</Text>
              </View>
            </>
          )}
        </View>
      ) : null}

      {activeTab === "tasks" ? (
        <View style={styles.detailSection}>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "المهام المرتبطة" : "Associated tasks"}</Text>
          {relations === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : relations.tasks.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد مهام لهذه السيارة." : "No tasks assigned for this vehicle."}</Text>
          ) : (
            relations.tasks.map((task) => (
              <View key={task._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>{task.title}</Text>
                  <DetailPill
                    label={task.status}
                    tone={task.status === "COMPLETED" ? "success" : task.status === "CANCELLED" ? "warning" : "info"}
                  />
                </View>
                <Text style={styles.recordMeta}>
                  {(locale === "ar" ? "الاستحقاق: " : "Due: ") + dateLabel(task.dueDate, locale)} · {task.assignedUserName}
                </Text>
                {task.description ? <Text style={styles.recordMeta}>{task.description}</Text> : null}
              </View>
            ))
          )}
        </View>
      ) : null}

      {activeTab === "drives" ? (
        <View style={styles.detailSection}>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "سجل تجارب القيادة" : "Test drive record"}</Text>
          {relations === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : relations.testDrives.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد تجارب قيادة مسجلة." : "No test drives recorded."}</Text>
          ) : (
            relations.testDrives.map((drive) => (
              <View key={drive._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>{drive.customerName}</Text>
                  <DetailPill
                    label={drive.endTime ? (locale === "ar" ? "مكتملة" : "Completed") : (locale === "ar" ? "جارية" : "In progress")}
                    tone={drive.endTime ? "info" : "warning"}
                  />
                </View>
                <Text style={styles.recordMeta}>
                  {drive.salespersonName}
                  {drive.demoPlateNumber ? ` · ${drive.demoPlateNumber}` : ""}
                </Text>
                <Text style={styles.recordMeta}>
                  {(locale === "ar" ? "البداية: " : "Started: ") + dateLabel(drive.startTime, locale)}
                  {drive.endTime ? ` · ${(locale === "ar" ? "النهاية: " : "Ended: ") + dateLabel(drive.endTime, locale)}` : ""}
                </Text>
                {drive.notes ? <Text style={styles.recordMeta}>{drive.notes}</Text> : null}
              </View>
            ))
          )}
        </View>
      ) : null}

      {activeTab === "work" ? (
        <View style={styles.detailSection}>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "أوامر الصيانة والعمل" : "Service & work orders"}</Text>
          {relations === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : relations.workOrders.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد أوامر عمل مسجلة." : "No work orders recorded."}</Text>
          ) : (
            relations.workOrders.map((order) => (
              <View key={order._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>{order.title}</Text>
                  <DetailPill
                    label={order.status}
                    tone={order.status === "COMPLETED" ? "success" : order.status === "IN_PROGRESS" ? "warning" : "neutral"}
                  />
                </View>
                {order.tasks.map((workTask) => (
                  <Text key={workTask.id} style={styles.recordMeta}>
                    {workTask.completed ? "✓" : "○"} {workTask.description} · {money(workTask.partsCost + workTask.laborCost, locale)}
                  </Text>
                ))}
                <View style={styles.detailRowSplit}>
                  <Text style={styles.recordMeta}>
                    {order.tasks.length} {locale === "ar" ? "مهمة" : order.tasks.length === 1 ? "task" : "tasks"}
                  </Text>
                  <Text style={styles.detailAmountText}>{money(order.totalCost, locale)}</Text>
                </View>
              </View>
            ))
          )}
        </View>
      ) : null}

      {activeTab === "valuations" ? (
        <View style={styles.detailSection}>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "تثمينات شركات التمويل" : "Finance company valuations"}</Text>
          {valuations === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : valuations.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد تثمينات لهذه السيارة." : "No valuations recorded for this vehicle."}</Text>
          ) : (
            valuations.map((valuation) => (
              <View key={valuation._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>
                    {companyNameById.get(valuation.companyId) ?? (locale === "ar" ? "شركة تمويل" : "Finance company")}
                  </Text>
                  <Text style={styles.detailAmountText}>{money(valuation.valuationAmount, locale)}</Text>
                </View>
              </View>
            ))
          )}
        </View>
      ) : null}

      {activeTab === "costs" ? (
        <View style={styles.detailSection}>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "تفصيل التكلفة الكلية" : "Landed cost breakdown"}</Text>
          {landedCosts === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : (
            <>
              {landedItems.length === 0 ? (
                <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد بنود تكلفة بعد." : "No landed cost items yet."}</Text>
              ) : (
                landedItems.map((item, index) => (
                  <View key={item.key} style={styles.detailRecordRow}>
                    <FormField
                      label={locale === "ar" ? "البند" : "Item"}
                      value={item.label}
                      onChangeText={(label) =>
                        setLandedItems((items) =>
                          items.map((current, currentIndex) => (currentIndex === index ? { ...current, label } : current)),
                        )
                      }
                    />
                    <FormField
                      keyboardType="numeric"
                      label={locale === "ar" ? "المبلغ" : "Amount"}
                      value={item.amount}
                      onChangeText={(amount) =>
                        setLandedItems((items) =>
                          items.map((current, currentIndex) => (currentIndex === index ? { ...current, amount } : current)),
                        )
                      }
                    />
                    <SelectField
                      label={locale === "ar" ? "طريقة الدفع" : "Payment method"}
                      value={item.paymentMethod}
                      options={paymentMethodOptions}
                      onChange={(method) =>
                        setLandedItems((items) =>
                          items.map((current, currentIndex) =>
                            currentIndex === index
                              ? { ...current, paymentMethod: method as MobileLandedCostPaymentMethod }
                              : current,
                          ),
                        )
                      }
                    />
                    {canEdit ? (
                      <PrimaryButton
                        label={locale === "ar" ? "إزالة" : "Remove"}
                        tone="danger"
                        onPress={() =>
                          setLandedItems((items) => items.filter((_, currentIndex) => currentIndex !== index))
                        }
                      />
                    ) : null}
                  </View>
                ))
              )}
              <View style={styles.detailTotalRow}>
                <Text style={styles.detailAmountText}>{locale === "ar" ? "الإجمالي" : "Total"}</Text>
                <Text style={styles.detailAmountText}>
                  {money(
                    landedItems.reduce((sum, item) => sum + (parseOptionalNumber(item.amount) ?? 0), 0),
                    locale,
                  )}
                </Text>
              </View>
              {canEdit ? (
                <View style={styles.cardActions}>
                  <PrimaryButton
                    label={locale === "ar" ? "إضافة بند" : "Add item"}
                    tone="muted"
                    onPress={() =>
                      setLandedItems((items) => [
                        ...items,
                        { key: nextLandedItemKey(), label: "", amount: "0", paymentMethod: "CASH" },
                      ])
                    }
                  />
                  <PrimaryButton
                    disabled={savingCosts}
                    label={savingCosts ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "حفظ التكلفة" : "Save landed cost")}
                    onPress={saveLandedCosts}
                  />
                </View>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      {activeTab === "pricing" ? (
        <View style={styles.detailSection}>
          <Text style={styles.sectionTitle}>{locale === "ar" ? "سجل تغيرات السعر" : "Pricing history"}</Text>
          {pricingHistory === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : pricingHistory.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد تغييرات سعر مسجلة." : "No pricing changes recorded."}</Text>
          ) : (
            pricingHistory.map((entry) => (
              <View key={entry._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>
                    {money(entry.oldPrice, locale)} → {money(entry.newPrice, locale)}
                  </Text>
                  <DetailPill
                    label={entry.newPrice >= entry.oldPrice ? (locale === "ar" ? "زيادة" : "Up") : (locale === "ar" ? "تخفيض" : "Down")}
                    tone={entry.newPrice >= entry.oldPrice ? "success" : "warning"}
                  />
                </View>
                <Text style={styles.recordMeta}>{dateLabel(entry.changedAt, locale)}</Text>
              </View>
            ))
          )}
        </View>
      ) : null}

      {activeTab === "holds" ? (
        <View style={styles.detailSection}>
          {canEdit && can(PERMISSION.viewCustomers) && vehicle.status === "AVAILABLE" ? (
            <>
              <Text style={styles.sectionTitle}>{locale === "ar" ? "إنشاء حجز" : "Create reservation"}</Text>
              <SelectField
                label={locale === "ar" ? "العميل" : "Customer"}
                value={reservationCustomerId}
                options={customerOptions}
                onChange={setReservationCustomerId}
              />
              <FormField
                keyboardType="numeric"
                label={locale === "ar" ? "مبلغ العربون (اختياري)" : "Deposit amount (optional)"}
                value={reservationDeposit}
                onChangeText={setReservationDeposit}
              />
              <FormField
                keyboardType="numeric"
                label={locale === "ar" ? "مدة الحجز بالأيام (اختياري)" : "Hold days (optional)"}
                placeholder={locale === "ar" ? "الافتراضي من إعدادات المعرض" : "Defaults to the org's hold period"}
                value={reservationHoldDays}
                onChangeText={setReservationHoldDays}
              />
              <PrimaryButton
                disabled={savingReservation || !reservationCustomerId}
                label={savingReservation ? (locale === "ar" ? "جاري الحفظ..." : "Saving...") : (locale === "ar" ? "إنشاء الحجز" : "Create reservation")}
                onPress={handleCreateReservation}
              />
            </>
          ) : null}
          <Text style={styles.sectionTitle}>{locale === "ar" ? "سجل الحجوزات" : "Reservation history"}</Text>
          {reservationHistory === undefined ? (
            <Text style={styles.mutedText}>{loadingLabel}</Text>
          ) : reservationHistory.length === 0 ? (
            <Text style={styles.mutedText}>{locale === "ar" ? "لا توجد حجوزات لهذه السيارة." : "No reservations for this vehicle."}</Text>
          ) : (
            reservationHistory.map((reservation) => (
              <View key={reservation._id} style={styles.detailRecordRow}>
                <View style={styles.detailRowSplit}>
                  <Text style={styles.detailAmountText}>
                    {reservation.customerName ?? (locale === "ar" ? "عميل" : "Customer")}
                  </Text>
                  <DetailPill
                    label={reservationStatusLabel(reservation.status)}
                    tone={reservation.status === "ACTIVE" ? "success" : "neutral"}
                  />
                </View>
                <Text style={styles.recordMeta}>
                  {(locale === "ar" ? "حُجزت: " : "Reserved: ") + dateLabel(reservation.reservedAt, locale)}
                  {reservation.reservedByName ? ` · ${reservation.reservedByName}` : ""}
                </Text>
                {reservation.depositAmount !== undefined ? (
                  <Text style={styles.recordMeta}>
                    {(locale === "ar" ? "العربون: " : "Deposit: ") + money(reservation.depositAmount, locale)}
                  </Text>
                ) : null}
                {reservation.expiresAt !== undefined ? (
                  <Text style={styles.recordMeta}>
                    {(locale === "ar" ? "تنتهي: " : "Expires: ") + dateLabel(reservation.expiresAt, locale)}
                  </Text>
                ) : null}
                {reservation.releasedAt !== undefined ? (
                  <Text style={styles.recordMeta}>
                    {(locale === "ar" ? "أُلغيت: " : "Released: ") + dateLabel(reservation.releasedAt, locale)}
                    {reservation.releasedByName ? ` · ${reservation.releasedByName}` : ""}
                  </Text>
                ) : null}
                {canEdit && reservation.status === "ACTIVE" ? (
                  <PrimaryButton
                    disabled={savingReservation}
                    label={locale === "ar" ? "إلغاء الحجز" : "Release reservation"}
                    tone="muted"
                    onPress={() => void handleReleaseReservation(reservation._id)}
                  />
                ) : null}
              </View>
            ))
          )}
        </View>
      ) : null}
    </FormModal>
  );
}
