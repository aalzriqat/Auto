import { makeFunctionReference, type FunctionReference } from "convex/server";

export type MobilePaymentType = "CASH" | "FINANCE" | "EITHER";
export type MobileMarketplacePaymentFilter = "CASH" | "FINANCE";
export type MobileBuyerTimeframe = "ASAP" | "THIS_WEEK" | "THIS_MONTH" | "JUST_LOOKING";
export type MobileBuyerIntent = "COLD" | "WARM" | "HOT";
export type MobileVehicleStatus =
  | "AVAILABLE"
  | "RESERVED"
  | "SOLD"
  | "IN_INSPECTION"
  | "IN_REPAIR"
  | "ARCHIVED"
  | "SOURCING";
export type MobileVehicleSourceType = "STOCK" | "SOURCED";
export type MobileLeadStage =
  | "NEW"
  | "CONTACTED"
  | "INTERESTED"
  | "TEST_DRIVE"
  | "NEGOTIATION"
  | "RESERVED"
  | "WON"
  | "LOST";
export type MobileTaskStatus = "PENDING" | "COMPLETED" | "CANCELLED";
export type MobileTaskPriority = "HIGH" | "MEDIUM" | "LOW";
export type MobileCommunicationMethod = "PHONE" | "EMAIL" | "FAX";
export type MobileSaleStatus = "PENDING" | "COMPLETED" | "CANCELLED";
export type MobileFinancingType = "CASH" | "FINANCED" | "LEASE";
export type MobileExpenseCategory =
  | "REPAIR"
  | "MAINTENANCE"
  | "INSPECTION"
  | "REGISTRATION"
  | "CLEANING"
  | "MARKETING"
  | "OFFICE"
  | "RENT"
  | "SALARIES"
  | "UTILITIES"
  | "INSURANCE"
  | "OTHER";
export type MobileExpenseStatus = "PENDING" | "PAID";
export type MobilePaymentMethod =
  | "CASH"
  | "BANK_TRANSFER"
  | "CHECK"
  | "CARD"
  | "OTHER";
export type MobileFinanceApplicationStatus =
  | "APPROVED"
  | "REJECTED"
  | "DRAFT"
  | "PENDING_DOCS"
  | "UNDER_REVIEW"
  | "CLOSED"
  | "CANCELLED";
export type MobileApprovalStatus = "APPROVED" | "REJECTED";
export type MobileQuoteStatus = "DRAFT" | "SHARED" | "ACCEPTED" | "EXPIRED";
export type MobileQuoteMode =
  | "CASH"
  | "CONFIGURED_FINANCE_COMPANY"
  | "MANUAL_FINANCE_COMPANY"
  | "INTERNAL_INSTALLMENT"
  | "LEASE";
export type MobileLedgerType = "IN" | "OUT";
export type MobileLedgerCategory =
  | "VEHICLE_SALE"
  | "VEHICLE_PURCHASE"
  | "EXPENSE"
  | "DEPOSIT"
  | "COLLECTION_PAYMENT"
  | "REFUND"
  | "PARTNER_DRAW"
  | "CAPITAL_INJECTION"
  | "CLAIM_PAYMENT"
  | "OTHER";
export type MobileSupplierPayableStatus = "PENDING" | "PAID" | "CANCELLED";
export type MobileSocialPlatform = "instagram" | "facebook";
export type MobileSocialConversationKind = "comment" | "dm";
export type MobileNotificationPriority = "urgent" | "normal" | "low";
export type MobileCommissionMode = "AUTO_TIERS" | "AUTO_MEMBER" | "MANUAL";
export type MobileMarketplaceRequestStatus = "OPEN" | "MATCHED" | "FULFILLED" | "EXPIRED" | "SPAM";
export type MobileMarketplaceResponseKind =
  | "HAVE_MATCH"
  | "HAVE_SIMILAR"
  | "CAN_SOURCE"
  | "NOT_AVAILABLE";
export type MobileTradeInCondition = "EXCELLENT" | "GOOD" | "FAIR" | "POOR";
export type MobileTradeInStatus = "PENDING" | "OFFERED" | "ACCEPTED" | "DECLINED";
export type MobileInspectionStatus = "NONE" | "SELF_REPORTED" | "PARTNER_VERIFIED";
export type MobileCustomFieldEntityType = "vehicle" | "customer" | "lead";
export type MobileCustomFieldType = "text" | "number" | "select" | "date";
export type MobileFeedbackType = "BUG" | "FEATURE";
export type MobileFeedbackStatus = "OPEN" | "CLOSED";
export type MobileWebsiteStatusValue = "draft" | "active" | "disabled";
export type MobileWebsiteLanguage = "en" | "ar";
export type MobilePlanId = "free" | "starter" | "professional" | "enterprise";

export interface MobileOrgSummary {
  _id: string;
  name: string;
  createdAt: number;
  roleName: string;
  membershipId: string;
  permissions: string[];
}

export type MobileDashboardTimeRange = "DAY" | "MONTH" | "YEAR" | "ALL_TIME";

export interface MobileDashboardTrendPoint {
  name: string;
  Revenue: number;
  Profit: number;
  Expenses: number;
}

export interface MobileDashboardTeamTask {
  pending: number;
  overdue: number;
  completed: number;
  name: string;
}

export interface MobileDashboardStats {
  totalVehicles: number;
  availableVehicles: number;
  activeLeads: number;
  salesThisMonth: number;
  salesVolumeThisMonth: number;
  teamMembers: number;
  salesTrend: MobileDashboardTrendPoint[];
  truncated: {
    vehicles: boolean;
    sales: boolean;
    members: boolean;
  };
  taskStats: {
    total: number;
    pending: number;
    completed: number;
    overdue: number;
  };
  teamTasks: MobileDashboardTeamTask[];
  topPerformer: {
    name: string;
    revenue: number;
    deals: number;
  } | null;
}

export interface MobileDataQualityStats {
  customersMissingPhone: number;
  customersMissingEmail: number;
  vehiclesWithVinWarning: number;
}

export interface MobilePageResult<T> {
  page: T[];
  isDone: boolean;
  continueCursor: string;
}

export interface MobileVehicle {
  _id: string;
  vin: string;
  make: string;
  model: string;
  year: number;
  trim?: string;
  mileage: number;
  color: string;
  fuelType: string;
  transmission: string;
  purchasePrice?: number;
  minimumProfit?: number;
  sellingPrice: number;
  status: MobileVehicleStatus;
  sourceType?: MobileVehicleSourceType;
  sourcedFromName?: string;
  sourceCost?: number;
  notes?: string;
  imageUrls?: Array<string | null>;
  createdAt?: number;
  addedByName?: string | null;
  pendingStatusRequest?: string | null;
}

export interface MobileCustomer {
  _id: string;
  firstName: string;
  lastName: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  nationalId?: string;
  address?: string;
  source?: string;
  createdAt?: number;
  createdByName?: string | null;
  employment?: {
    employer: string;
    title?: string;
    salary: number;
    hireDate?: number;
  };
  financials?: {
    totalMonthlyDebt: number;
    dbr?: number;
  };
}

export interface MobileGuarantor {
  _id: string;
  firstName: string;
  lastName: string;
  nationalId: string;
  phone: string;
  relationship?: string;
  income?: number;
}

export interface MobileCustomerRelationSale {
  _id: string;
  vehicleDesc: string;
  status: MobileSaleStatus;
  saleDate: number;
  salePrice: number;
  salespersonName: string;
}

export interface MobileCustomerRelationLead {
  _id: string;
  vehicleDesc: string;
  stage: MobileLeadStage;
  source: string;
  assignedUserName: string;
  notes?: string;
}

export interface MobileCustomerRelationTask {
  _id: string;
  title: string;
  status: MobileTaskStatus;
  dueDate: number;
  assignedUserName: string;
  description?: string;
}

export interface MobileCustomerRelationQuote {
  _id: string;
  vehicleDesc: string;
  companyId?: string;
  companyName: string;
  status: MobileQuoteStatus;
  vehiclePrice: number;
  downPayment?: number;
  termMonths?: number;
  profitRateApplied?: number;
  totalFinancedAmount?: number;
  totalProfit?: number;
  monthlyInstallment?: number;
  createdAt: number;
  createdByUserName: string;
}

export interface MobileCustomerRelations {
  sales: MobileCustomerRelationSale[];
  leads: MobileCustomerRelationLead[];
  tasks: MobileCustomerRelationTask[];
  quotes: MobileCustomerRelationQuote[];
}

export interface MobileLead {
  _id: string;
  customerId: string;
  assignedUserId?: string;
  vehicleId?: string;
  source: string;
  stage: MobileLeadStage;
  notes?: string;
  customerName: string;
  email?: string;
  phone?: string;
  vehicleSummary: string | null;
  vehiclePrice: number | null;
  assignedUserName: string | null;
  createdByName?: string | null;
  updatedByName?: string | null;
}

export interface MobileTask {
  _id: string;
  assignedTo: string;
  title: string;
  description?: string;
  dueDate: number;
  status: MobileTaskStatus;
  priority?: MobileTaskPriority;
  communicationMethod?: MobileCommunicationMethod;
  customerId?: string;
  leadId?: string;
  vehicleId?: string;
  assigneeName: string;
  customerName: string | null;
  statusNote?: string;
}

export interface MobileSale {
  _id: string;
  vehicleId: string;
  customerId: string;
  salespersonId: string;
  salePrice: number;
  saleDate: number;
  status: MobileSaleStatus;
  taxAmount?: number;
  dealerFees?: number;
  downPayment?: number;
  financingType?: MobileFinancingType;
  commissionAmount?: number;
  commissionPaidAt?: number;
  vehicleSummary: string;
  vehicleVin: string;
  customerName: string;
  salespersonName: string;
}

export interface MobileExpense {
  _id: string;
  vehicleId?: string;
  title: string;
  amount: number;
  taxAmount?: number;
  date: number;
  category: MobileExpenseCategory;
  status: MobileExpenseStatus;
  vendor?: string;
  payerId?: string;
  payerName: string | null;
  paymentMethod?: MobilePaymentMethod;
  notes?: string;
  vehicleSummary: string | null;
}

export interface MobileMembership {
  _id: string;
  orgId: string;
  userId: string;
  roleId: string;
  userName: string;
  userEmail: string;
  userImage?: string;
  roleName: string;
  commissionRate: number;
  lastSeenAt?: number;
  offboardingStatus?: string;
}

export interface MobileMyMembership {
  _id: string;
  userId: string;
  roleId: string;
  roleName: string;
  permissions: string[];
}

export interface MobileUserProfile {
  _id: string;
  email: string;
  name?: string;
  imageUrl?: string;
}

export type MobileDirectConversationType = "DM" | "GROUP";
export type MobileDirectMessageStatus = "received" | "sent" | "delivered" | "seen";

export interface MobileDirectMember {
  _id: string;
  name: string;
  email?: string;
  imageUrl?: string;
  roleName?: string;
}

export interface MobileDirectTypingUser {
  userId: string;
  name: string;
}

export interface MobileDirectConversation {
  _id: string;
  orgId: string;
  type: MobileDirectConversationType;
  name?: string;
  memberIds: string[];
  createdBy: string;
  lastMessageAt: number;
  lastMessageBody?: string;
  lastMessageSenderId?: string;
  members: Array<MobileDirectMember | null>;
  hasUnread: boolean;
  isMuted: boolean;
  lastDeliveredAt: number;
  typingUsers?: Array<MobileDirectTypingUser | null>;
}

export interface MobileDirectSeenBy {
  userId: string;
  name: string;
  imageUrl?: string;
}

export interface MobileDirectMessage {
  _id: string;
  _creationTime: number;
  conversationId: string;
  senderId: string;
  body: string;
  senderName: string;
  senderImageUrl?: string;
  status: MobileDirectMessageStatus;
  seenBy: MobileDirectSeenBy[];
}

export interface MobileRole {
  _id: string;
  orgId: string;
  name: string;
  permissions: string[];
  isDeleted?: boolean;
}

export interface MobileOrgSettings {
  _id: string;
  orgId: string;
  currency: string;
  currencySymbol: string;
  vatRate?: number;
  country?: string;
  timezone?: string;
  enabledPaymentTypes: string[];
  primaryColor?: string;
  dealershipName?: string;
  legalCompanyName?: string;
  dealershipAddress?: string;
  dealershipPhone?: string;
  dealershipPhones?: string[];
  approvalThresholdEnabled?: boolean;
  approvalMinProfitPercent?: number;
  commissionTiers?: Array<{
    minProfitAmount: number;
    commissionPct: number;
  }>;
  commissionMode?: MobileCommissionMode;
  generatedLeadAutoAssignmentEnabled?: boolean;
  reservationHoldDays?: number;
  instagramAutoReplyEnabled?: boolean;
  facebookAutoReplyEnabled?: boolean;
  instagramLeadFromCommentsEnabled?: boolean;
  instagramLeadFromDmsEnabled?: boolean;
  facebookLeadFromCommentsEnabled?: boolean;
  facebookLeadFromDmsEnabled?: boolean;
}

export interface MobilePipelineStage {
  _id: string;
  orgId: string;
  stageKey: MobileLeadStage;
  label: string;
  color: string;
  order: number;
  isActive: boolean;
}

export interface MobileLeadSource {
  _id: string;
  orgId: string;
  label: string;
  isActive: boolean;
  order: number;
}

export interface MobileValuationCompany {
  _id: string;
  orgId: string;
  name: string;
  isActive: boolean;
  order: number;
}

export interface MobileCustomField {
  _id: string;
  orgId: string;
  entityType: MobileCustomFieldEntityType;
  fieldName: string;
  fieldKey: string;
  fieldType: MobileCustomFieldType;
  isRequired?: boolean;
  options?: string[];
  order: number;
  isActive: boolean;
}

export interface MobileInstagramConnectionStatus {
  instagramConnected: boolean;
  instagramPageName?: string;
  socialAutoPostEnabled: boolean;
  instagramAutoReplyEnabled: boolean;
  instagramAutoReplyForDmsEnabled: boolean;
  instagramAutoReplyForCommentsEnabled: boolean;
  instagramAutoReplyMessages: string[];
  instagramAutoReplyMobileReceivedMessage?: string;
  instagramLeadFromCommentsEnabled: boolean;
  instagramLeadFromDmsEnabled: boolean;
  instagramLeadFromDmsRequiresMobile: boolean;
}

export interface MobileFacebookConnectionStatus {
  facebookConnected: boolean;
  facebookPageName?: string;
  facebookAutoReplyEnabled: boolean;
  facebookAutoReplyForDmsEnabled: boolean;
  facebookAutoReplyForCommentsEnabled: boolean;
  facebookAutoReplyMessages: string[];
  facebookAutoReplyMobileReceivedMessage?: string;
  facebookLeadFromCommentsEnabled: boolean;
  facebookLeadFromDmsEnabled: boolean;
  facebookLeadFromDmsRequiresMobile: boolean;
}

export interface MobileWebsiteSettings {
  _id: string;
  orgId: string;
  enabled: boolean;
  status: MobileWebsiteStatusValue;
  templateId?: string;
  defaultLanguage?: MobileWebsiteLanguage;
  supportedLanguages?: MobileWebsiteLanguage[];
  primaryColor?: string;
  secondaryColor?: string;
  heroTitle?: string;
  heroSubtitle?: string;
  heroBadgeText?: string;
  slogan?: string;
  defaultSubdomain?: string;
  activeFinanceCompanyId?: string;
}

export interface MobileWebsiteDomain {
  _id: string;
  domain: string;
  type?: string;
  status?: string;
  isPrimary?: boolean;
  dnsStatus?: string;
  sslStatus?: string;
}

export interface MobileWebsiteSection {
  _id?: string;
  sectionKey: string;
  enabled: boolean;
}

export interface MobileWebsiteRouting {
  _id?: string;
  formType: string;
  createTask: boolean;
  notifyByEmail: boolean;
  notifyByWhatsApp: boolean;
}

export interface MobileWebsiteStatus {
  settings: MobileWebsiteSettings | null;
  primaryDomain: MobileWebsiteDomain | null;
  domains: MobileWebsiteDomain[];
  sections: MobileWebsiteSection[];
  routing: MobileWebsiteRouting[];
}

export interface MobileFeedback {
  _id: string;
  orgId: string;
  userId: string;
  userName?: string;
  type: MobileFeedbackType;
  title: string;
  description?: string;
  url?: string;
  status: MobileFeedbackStatus;
  createdAt: number;
  resolvedAt?: number;
  adminReply?: string;
}

export interface MobileSubscriptionPlan {
  id: MobilePlanId;
  name: string;
  nameAr: string;
  priceJod: number;
  annualPriceJod: number;
  maxVehicles: number;
  maxUsers: number;
  features: string[];
  featuresAr: string[];
  gates: Record<string, boolean>;
}

export interface MobileSubscription {
  plan: MobilePlanId;
  status: string;
  planDetails: MobileSubscriptionPlan;
  daysUntilRenewal: number | null;
  currentPeriodEnd: number | null;
}

export interface MobileUsageStats {
  vehicleCount: number;
  memberCount: number;
  maxVehicles: number;
  maxUsers: number;
}

export interface MobileMarketplaceDealerProfile {
  _id?: string;
  isOptedIn?: boolean;
  areas?: string[];
  brandsCarried?: string[];
  whatsappNumber?: string;
  tier?: "FREE_FOUNDING" | "LEAD_PACKAGE" | "FEATURED";
  createdAt?: number;
  foundingWindowEndsAt?: number;
  leadQuota?: number;
  leadsUsedThisPeriod?: number;
}

export interface MobileBranch {
  _id: string;
  orgId: string;
  name: string;
  address?: string;
  phone?: string;
  additionalPhones?: string[];
  managerId?: string;
  managerName: string;
  isActive: boolean;
}

export interface MobileFinanceCompany {
  _id: string;
  orgId: string;
  name: string;
  profitRate: number;
  maxTermMonths: number;
  gracePeriodMonths: number;
  insuranceRate?: number;
  adminFees?: number;
  commission?: number;
  includesCommissionInDebt?: boolean;
  maxFinancingLTV?: number;
  acceptedStatuses?: string[];
  isActive: boolean;
}

export interface MobileCustomerStatus {
  _id: string;
  label: string;
  isActive: boolean;
}

export interface MobileVehicleValuation {
  _id: string;
  companyId: string;
  valuationAmount: number;
}

export type MobileDepositStatus = "HELD" | "APPLIED" | "REFUNDED" | "FORFEITED";
export type MobileDepositMethod =
  | "CASH"
  | "BANK_TRANSFER"
  | "PAYMENT_LINK"
  | "CARD"
  | "CHEQUE"
  | "OTHER";
export type MobileLandedCostPaymentMethod = "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";
export type MobileReservationStatus = "ACTIVE" | "RELEASED" | "CONVERTED" | "EXPIRED";

export interface MobileVehicleDeposit {
  _id: string;
  _creationTime: number;
  amount: number;
  status: MobileDepositStatus;
  notes?: string;
}

export interface MobileVehicleRelationSale {
  _id: string;
  customerName: string;
  salespersonName: string;
  status: MobileSaleStatus;
  saleDate: number;
  salePrice: number;
}

export interface MobileVehicleRelationLead {
  _id: string;
  customerName: string;
  stage: MobileLeadStage;
  source: string;
  assignedUserName: string;
  notes?: string;
}

export interface MobileVehicleRelationExpense {
  _id: string;
  title: string;
  status: MobileExpenseStatus;
  date: number;
  category: string;
  vendor?: string;
  payerName?: string | null;
  notes?: string;
  amount: number;
}

export interface MobileVehicleRelationTask {
  _id: string;
  title: string;
  status: MobileTaskStatus;
  dueDate: number;
  assignedUserName: string;
  description?: string;
}

export interface MobileVehicleRelationTestDrive {
  _id: string;
  customerName: string;
  salespersonName: string;
  demoPlateNumber?: string;
  startTime: number;
  endTime?: number;
  notes?: string;
}

export interface MobileVehicleRelationWorkOrder {
  _id: string;
  title: string;
  status: "OPEN" | "IN_PROGRESS" | "COMPLETED";
  totalCost: number;
  tasks: Array<{
    id: string;
    description: string;
    partsCost: number;
    laborCost: number;
    mechanicName?: string;
    completed: boolean;
  }>;
  notes?: string;
}

export interface MobileVehicleRelations {
  sales: MobileVehicleRelationSale[];
  leads: MobileVehicleRelationLead[];
  expenses: MobileVehicleRelationExpense[];
  tasks: MobileVehicleRelationTask[];
  testDrives: MobileVehicleRelationTestDrive[];
  workOrders: MobileVehicleRelationWorkOrder[];
}

export interface MobileLandedCostItem {
  label: string;
  amount: number;
  paymentMethod?: MobileLandedCostPaymentMethod;
}

export interface MobileLandedCosts {
  _id: string;
  items: MobileLandedCostItem[];
  total: number;
  updatedAt: number;
}

export interface MobileVehiclePriceHistoryEntry {
  _id: string;
  oldPrice: number;
  newPrice: number;
  changedAt: number;
}

export interface MobileVehicleReservation {
  _id: string;
  status: MobileReservationStatus;
  customerName: string | null;
  reservedByName: string | null;
  releasedByName: string | null;
  reservedAt: number;
  releasedAt?: number;
  expiresAt?: number;
  depositAmount?: number;
}

export interface MobileProfitApprovalCheck {
  status: "PENDING" | "APPROVED" | "REJECTED";
  requestedProfit: number;
}

export interface MobileQuote {
  _id: string;
  orgId: string;
  customerId: string;
  vehicleId: string;
  companyId?: string;
  mode?: MobileQuoteMode;
  leadId?: string;
  vehiclePrice: number;
  downPayment: number;
  termMonths: number;
  totalFinancedAmount?: number;
  monthlyInstallment?: number;
  profitRateApplied?: number;
  totalProfit?: number;
  recipientName?: string;
  manualProviderName?: string;
  status: MobileQuoteStatus;
  createdBy: string;
  createdAt: number;
}

export interface MobileNotification {
  _id: string;
  orgId: string;
  userId: string;
  title?: string;
  message?: string;
  type?: string;
  category?: string;
  priority?: MobileNotificationPriority;
  data?: unknown;
  isRead: boolean;
  isArchived?: boolean;
  archivedAt?: number;
  link?: string;
}

export interface MobileLedgerTransaction {
  _id: string;
  orgId: string;
  type: MobileLedgerType;
  amount: number;
  date: number;
  category: MobileLedgerCategory;
  description: string;
  vehicleId?: string;
  userId?: string;
  expenseId?: string;
  depositId?: string;
  customerId?: string;
  vehicleLabel?: string;
  customerName?: string;
  quoteReference?: string;
  reservationReference?: string;
}

export interface MobileSupplierPayable {
  _id: string;
  orgId: string;
  vehicleId: string;
  saleId?: string;
  sourcedFromName: string;
  amountDue: number;
  currency: string;
  status: MobileSupplierPayableStatus;
  createdAt: number;
  updatedAt?: number;
  paidAt?: number;
  paidByName?: string | null;
  paymentNotes?: string;
  paymentMethod?: MobilePaymentMethod;
  taxAmount?: number;
  vehicleDesc: string;
  vehicleVin?: string;
  customerName: string | null;
  daysOutstanding: number;
}

export interface MobileSocialConversation {
  customerId: string;
  leadId: string | null;
  platform: MobileSocialPlatform;
  conversationKind: MobileSocialConversationKind;
  conversationPostId: string | null;
  senderDisplayName: string;
  latestText?: string;
  latestCreationTime: number;
  latestSenderHandle: string | null;
  vehicleSummary: string | null;
  vehicleCount: number;
  eventCount: number;
  needsReply: boolean;
  leadStage: MobileLeadStage | null;
}

export interface MobileSocialConversationEvent {
  _id: string;
  platform: MobileSocialPlatform;
  _creationTime: number;
  kind: MobileSocialConversationKind;
  externalId: string;
  text?: string;
  customerId?: string;
  leadId?: string;
  vehicleId?: string;
  postId?: string;
  autoRepliedAt?: number;
  autoReplyText?: string;
  manualReplyText?: string;
  manualRepliedAt?: number;
  senderDisplayName: string;
  vehicleSummary: string | null;
  manualRepliedByName: string | null;
}

export interface MobileSocialPlatformStats {
  instagram: {
    comments: number;
    dms: number;
    total: number;
    uniqueContacts: number;
  };
  facebook: {
    comments: number;
    dms: number;
    total: number;
    uniqueContacts: number;
  };
  total: number;
}

export interface MobileFinanceApplication {
  _id: string;
  status: MobileFinanceApplicationStatus;
  customerName: string;
  vehicleDesc: string;
  companyName: string;
  salespersonName: string;
  financedAmount: number;
  monthlyInstallment: number;
  hasPendingDepositResolution?: boolean;
  createdAt?: number;
}

export interface MobileApprovalRequest {
  _id: string;
  salespersonId: string;
  vehicleId: string;
  proposedSalePrice?: number;
  minimumProfit?: number;
  expectedProfit?: number;
  status: string;
  createdAt: number;
  salespersonName: string;
  vehicleMakeModel: string;
  vehicleVin: string;
}

export interface MobileSalesReport {
  totalRevenue: number;
  totalCost: number;
  totalProfit: number;
  sales: Array<{
    _id: string;
    saleDate: number;
    salePrice: number;
    vehicleMake?: string;
    vehicleModel?: string;
    vehicleYear?: number;
    vehicleVin?: string;
    totalCost: number;
    netProfit: number;
  }>;
}

export interface MobileInventoryReport {
  availableCount: number;
  totalValue: number;
  vehicles: Array<{
    _id: string;
    year: number;
    make: string;
    model: string;
    vin: string;
    status: MobileVehicleStatus;
    sellingPrice: number;
    totalInvestment: number;
  }>;
}

export interface MobileExpensesReport {
  totalExpenses: number;
  expenses: Array<{
    _id: string;
    title: string;
    amount: number;
    recognizedAmount: number;
    date: number;
    category: MobileExpenseCategory;
    vehicleDesc: string;
  }>;
}

export interface MobileSalespersonPerformanceRow {
  userId: string;
  userName: string;
  vehiclesSold: number;
  totalRevenue: number;
  totalProfit: number;
}

export interface MobileLeadConversionReport {
  totalLeads: number;
  wonLeads: number;
  overallConversionRate: number;
  stageCounts: Record<string, number>;
  salespersonMetrics: Array<{
    userId: string;
    userName: string;
    totalLeads: number;
    wonLeads: number;
    conversionRate: number;
  }>;
  truncated: boolean;
}

export interface MobileMarketplaceDealer {
  orgId: string;
  dealershipName: string;
  phone: string | null;
  address: string | null;
  logoUrl: string | null;
  siteUrl: string | null;
  areas: string[];
  brandsCarried: string[];
  badges: string[];
  activeVehicleCount: number;
}

export interface MobileMarketplaceVehicle {
  orgId: string;
  dealershipName: string;
  dealerBadges: string[];
  siteUrl: string | null;
  id: string;
  slug: string;
  make: string;
  model: string;
  year: number;
  trim: string | null;
  mileage: number | null;
  price: number | null;
  financePrice: number | null;
  imageUrls: string[];
  financeAvailable: boolean;
  estimatedMonthlyPayment: number | null;
  inspectionStatus: MobileInspectionStatus;
  accidentDisclosed: boolean | null;
  ownerCount: number | null;
  dealerGuarantee: boolean | null;
}

export interface MobileMarketplaceSearchResult {
  vehicles: MobileMarketplaceVehicle[];
  continueCursor: string | null;
  isDone: boolean;
}

export interface MobileMarketplaceRequestRow {
  requestId: string;
  status: MobileMarketplaceRequestStatus;
  buyerFirstName: string;
  buyerCity: string;
  make?: string;
  model?: string;
  yearMin?: number;
  yearMax?: number;
  priceMin?: number;
  priceMax?: number;
  paymentType: MobilePaymentType;
  monthlyBudget?: number;
  buyerTimeframe: MobileBuyerTimeframe;
  buyerIntent: MobileBuyerIntent;
  matchedAt: number;
  latestResponse: {
    kind: MobileMarketplaceResponseKind;
    createdAt: number;
  } | null;
}

export interface MobileMarketplaceRequestBuyerStatus {
  status: MobileMarketplaceRequestStatus;
  createdAt: number;
  matchedCount: number;
  respondedCount: number;
}

export interface MobileMarketplaceTradeInRow {
  _id: string;
  orgId: string;
  buyerFirstName: string;
  buyerPhone: string;
  currentMake: string;
  currentModel: string;
  currentYear: number;
  currentMileage: number;
  condition: MobileTradeInCondition;
  notes?: string;
  status: MobileTradeInStatus;
  offerAmountJod?: number;
  offeredAt?: number;
  createdAt: number;
}

export interface MobileMarketplaceTradeInBuyerStatus {
  status: MobileTradeInStatus;
  offerAmountJod: number | null;
  currentMake: string;
  currentModel: string;
  currentYear: number;
}

export interface MobileMarketplaceSubmitRequestResult {
  requestId: string;
  matchedCount: number;
}

export interface MobileMarketplaceSubmitTradeInResult {
  tradeInRequestId: string;
}

export type MobileMarketplaceOfferActionResult =
  | { success: true; leadId?: string }
  | { success: false };

export interface MobileVehiclePickerItem {
  _id: string;
  year: number;
  make: string;
  model: string;
  trim?: string;
  vin?: string;
  sellingPrice?: number;
  purchasePrice?: number;
  minimumProfit?: number;
  status: string;
}

export interface MobileWizardDraftData {
  vehicleId: string;
  vehiclePrice: number;
  desiredProfit: number;
  downPayment: number;
  termMonths: number;
  selectedCompanyId?: string;
  manualProfitRate?: number;
  manualInsuranceRate?: number;
  manualExecutionCommission?: number;
  manualExecutionFees?: number;
  manualIncludesCommissionInDebt?: boolean;
  recipientName?: string;
}

export interface MobileWizardDraft {
  paymentType: string;
  currentStep: number;
  wizardData: MobileWizardDraftData;
  selectedCustomerId?: string;
  savedAt: number;
}

export interface MobilePaymentVoucher {
  _id: string;
  voucherNumber?: string;
  amount: number;
  _creationTime: number;
}

type OrgScopedArgs = {
  orgId: string;
};

type DashboardStatsArgs = OrgScopedArgs & {
  timeRange?: MobileDashboardTimeRange;
};

type MarketplaceSearchArgs = {
  make?: string;
  model?: string;
  priceMin?: number;
  priceMax?: number;
  maxMonthlyPayment?: number;
  city?: string;
  paymentType?: MobileMarketplacePaymentFilter;
  cursor?: string;
  numItems?: number;
};

type PaginationOpts = {
  numItems: number;
  cursor: string | null;
};

type VehicleListArgs = OrgScopedArgs & {
  status?: MobileVehicleStatus;
  paginationOpts: PaginationOpts;
};

type VehicleScopedArgs = OrgScopedArgs & {
  vehicleId: string;
};

type DepositReleaseArgs = OrgScopedArgs & {
  depositId: string;
  resolution: "REFUNDED" | "FORFEITED";
  refundMethod?: MobileDepositMethod;
  notes?: string;
  idempotencyKey?: string;
};

type ReservationCreateArgs = VehicleScopedArgs & {
  customerId: string;
  depositAmount?: number;
  depositMethod?: MobileDepositMethod;
  expiresAt?: number;
};

type CustomerListArgs = OrgScopedArgs & {
  paginationOpts: PaginationOpts;
};

type LeadListArgs = OrgScopedArgs & {
  stage?: MobileLeadStage;
  assignedUserId?: string;
  paginationOpts: PaginationOpts;
};

type TaskListArgs = OrgScopedArgs & {
  assignedTo?: string;
  status?: "PENDING" | "COMPLETED";
  paginationOpts: PaginationOpts;
};

type SaleListArgs = OrgScopedArgs & {
  salespersonId?: string;
  paginationOpts: PaginationOpts;
};

type ExpenseListArgs = OrgScopedArgs & {
  vehicleId?: string;
  paginationOpts: PaginationOpts;
};

type MembershipListArgs = OrgScopedArgs & {
  paginationOpts: PaginationOpts;
};

type ApplicationListArgs = OrgScopedArgs & {
  status?: string;
  paginationOpts: PaginationOpts;
};

type NotificationListArgs = OrgScopedArgs & {
  paginationOpts: PaginationOpts;
  category?: string;
  showArchived?: boolean;
};

type TransactionListArgs = OrgScopedArgs & {
  paginationOpts: PaginationOpts;
  startDate?: number;
  endDate?: number;
};

type SocialConversationListArgs = OrgScopedArgs & {
  paginationOpts: PaginationOpts;
  platform?: MobileSocialPlatform;
  kind?: MobileSocialConversationKind;
  hasVehicle?: boolean;
  needsReply?: boolean;
};

type SocialEventsArgs = OrgScopedArgs & {
  customerId: string;
  platform: MobileSocialPlatform;
  conversationKind: MobileSocialConversationKind;
  conversationPostId?: string;
};

type DirectConversationArgs = {
  conversationId: string;
};

type DirectMessageListArgs = DirectConversationArgs & {
  paginationOpts: PaginationOpts;
};

type DirectSendMessageArgs = DirectConversationArgs & {
  body: string;
};

type DirectTypingArgs = DirectConversationArgs & {
  isTyping: boolean;
};

type DirectMutedArgs = DirectConversationArgs & {
  isMuted: boolean;
};

type DirectDmArgs = OrgScopedArgs & {
  otherUserId: string;
};

type DirectGroupArgs = OrgScopedArgs & {
  name: string;
  memberIds: string[];
};

type ReportRangeArgs = OrgScopedArgs & {
  startDate: number;
  endDate: number;
};

type CustomerCreateArgs = OrgScopedArgs & {
  firstName: string;
  lastName: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  nationalId?: string;
  address?: string;
};

type CustomerUpdateArgs = Partial<Omit<CustomerCreateArgs, "orgId">> &
  OrgScopedArgs & {
    customerId: string;
    employment?: {
      employer: string;
      title?: string;
      salary: number;
      hireDate?: number;
    };
    financials?: {
      totalMonthlyDebt: number;
      dbr?: number;
    };
  };

type CustomerScopedArgs = OrgScopedArgs & {
  customerId: string;
};

type GuarantorCreateArgs = CustomerScopedArgs & {
  firstName: string;
  lastName: string;
  nationalId: string;
  phone: string;
  relationship?: string;
  income?: number;
};

type GuarantorUpdateArgs = OrgScopedArgs & {
  guarantorId: string;
  firstName?: string;
  lastName?: string;
  nationalId?: string;
  phone?: string;
  relationship?: string;
  income?: number;
};

type VehicleCreateArgs = OrgScopedArgs & {
  vin?: string;
  make: string;
  model: string;
  year: number;
  trim?: string;
  mileage: number;
  color: string;
  fuelType: string;
  transmission: string;
  purchasePrice?: number;
  minimumProfit?: number;
  sellingPrice: number;
  status?: MobileVehicleStatus;
  sourceType?: MobileVehicleSourceType;
  sourcedFromName?: string;
  sourceCost?: number;
  notes?: string;
  inspectionStatus?: MobileInspectionStatus;
  accidentDisclosed?: boolean;
  ownerCount?: number;
  dealerGuarantee?: boolean;
};

type VehicleUpdateArgs = Partial<Omit<VehicleCreateArgs, "orgId">> &
  OrgScopedArgs & {
    vehicleId: string;
  };

type LeadCreateArgs = OrgScopedArgs & {
  customerId: string;
  assignedUserId?: string;
  vehicleId?: string;
  source: string;
  stage?: MobileLeadStage;
  notes?: string;
};

type LeadUpdateArgs = Partial<Omit<LeadCreateArgs, "orgId">> &
  OrgScopedArgs & {
    leadId: string;
  };

type TaskCreateArgs = OrgScopedArgs & {
  assignedTo: string;
  title: string;
  description?: string;
  dueDate: number;
  status: MobileTaskStatus;
  priority?: MobileTaskPriority;
  communicationMethod?: MobileCommunicationMethod;
  customerId?: string;
  leadId?: string;
  vehicleId?: string;
};

type TaskUpdateArgs = Partial<Omit<TaskCreateArgs, "orgId" | "leadId">> &
  OrgScopedArgs & {
    taskId: string;
    statusNote?: string;
    customerId?: string | null;
    vehicleId?: string | null;
  };

type SaleDraftCreateArgs = OrgScopedArgs & {
  vehicleId: string;
  customerId: string;
  salespersonId: string;
  salePrice: number;
  saleDate: number;
  status?: "PENDING";
  taxRate?: number;
  taxAmount?: number;
  dealerFees?: number;
  downPayment?: number;
  tradeInVehicleId?: string;
  tradeInValue?: number;
  financingType?: MobileFinancingType;
  loanAmount?: number;
  apr?: number;
  termMonths?: number;
  warrantySold?: number;
  gapSold?: number;
  idempotencyKey?: string;
};

type SaleUpdateArgs = Partial<
  Omit<SaleDraftCreateArgs, "orgId" | "vehicleId" | "customerId" | "salespersonId" | "status">
> &
  OrgScopedArgs & {
    saleId: string;
    status?: MobileSaleStatus;
  };

type ExpenseCreateArgs = OrgScopedArgs & {
  vehicleId?: string;
  title: string;
  amount: number;
  taxAmount?: number;
  date: number;
  category: MobileExpenseCategory;
  status?: MobileExpenseStatus;
  vendor?: string;
  payerId?: string;
  paymentMethod?: MobilePaymentMethod;
  notes?: string;
  idempotencyKey?: string;
};

type ExpenseUpdateArgs = Partial<Omit<ExpenseCreateArgs, "orgId">> &
  OrgScopedArgs & {
    expenseId: string;
    vehicleId?: string | null;
    payerId?: string | null;
  };

type OrgSettingsUpsertArgs = OrgScopedArgs & {
  currency?: string;
  currencySymbol?: string;
  vatRate?: number;
  country?: string;
  timezone?: string;
  enabledPaymentTypes?: string[];
  primaryColor?: string;
  dealershipName?: string;
  legalCompanyName?: string;
  dealershipAddress?: string;
  dealershipPhone?: string;
  dealershipPhones?: string[];
  approvalThresholdEnabled?: boolean;
  approvalMinProfitPercent?: number;
  commissionTiers?: Array<{
    minProfitAmount: number;
    commissionPct: number;
  }>;
  commissionMode?: MobileCommissionMode;
  generatedLeadAutoAssignmentEnabled?: boolean;
  reservationHoldDays?: number;
};

type PipelineStageUpdateArgs = OrgScopedArgs & {
  stageId: string;
  label?: string;
  color?: string;
  isActive?: boolean;
};

type LeadSourceCreateArgs = OrgScopedArgs & {
  label: string;
};

type LeadSourceUpdateArgs = OrgScopedArgs & {
  sourceId: string;
  label?: string;
  isActive?: boolean;
  order?: number;
};

type ValuationCompanyCreateArgs = OrgScopedArgs & {
  name: string;
};

type ValuationCompanyUpdateArgs = OrgScopedArgs & {
  companyId: string;
  name?: string;
  isActive?: boolean;
  order?: number;
};

type CustomFieldCreateArgs = OrgScopedArgs & {
  entityType: MobileCustomFieldEntityType;
  fieldName: string;
  fieldKey: string;
  fieldType: MobileCustomFieldType;
  isRequired?: boolean;
  options?: string[];
};

type CustomFieldUpdateArgs = OrgScopedArgs & {
  fieldId: string;
  fieldName?: string;
  isRequired?: boolean;
  options?: string[];
  isActive?: boolean;
};

type AutoReplyConfigArgs = OrgScopedArgs & {
  enabledForDms: boolean;
  enabledForComments: boolean;
  messages: string[];
  mobileReceivedMessage?: string;
};

type LeadCreationConfigArgs = OrgScopedArgs & {
  leadFromCommentsEnabled: boolean;
  leadFromDmsEnabled: boolean;
  leadFromDmsRequiresMobile?: boolean;
};

type WebsiteDraftArgs = OrgScopedArgs & {
  subdomainSlug?: string;
  templateId?: string;
  defaultLanguage?: MobileWebsiteLanguage;
  supportedLanguages?: MobileWebsiteLanguage[];
  primaryColor?: string;
  secondaryColor?: string;
  heroTitle?: string;
  heroSubtitle?: string;
  heroBadgeText?: string;
  slogan?: string;
  activeFinanceCompanyId?: string | null;
  sections?: MobileWebsiteSection[];
  routing?: MobileWebsiteRouting[];
};

type FeedbackListArgs = OrgScopedArgs & {
  type?: MobileFeedbackType;
  status?: MobileFeedbackStatus;
};

type FeedbackSubmitArgs = OrgScopedArgs & {
  type: MobileFeedbackType;
  title: string;
  description?: string;
  url?: string;
};

type FeedbackStatusArgs = OrgScopedArgs & {
  feedbackId: string;
  status: MobileFeedbackStatus;
};

type UpgradeRequestArgs = OrgScopedArgs & {
  targetPlan: string;
  phone: string;
  message?: string;
};

type MarketplaceDealerProfileUpdateArgs = OrgScopedArgs & {
  isOptedIn: boolean;
  areas: string[];
  brandsCarried: string[];
  whatsappNumber?: string;
};

type BranchMutationArgs = OrgScopedArgs & {
  name: string;
  address?: string;
  phone?: string;
  additionalPhones?: string[];
  managerId?: string;
  isActive: boolean;
};

type FinanceCompanyMutationArgs = OrgScopedArgs & {
  name: string;
  profitRate: number;
  maxTermMonths: number;
  gracePeriodMonths: number;
  insuranceRate?: number;
  adminFees?: number;
  commission?: number;
  includesCommissionInDebt?: boolean;
  maxFinancingLTV?: number;
  isActive: boolean;
};

type RoleMutationArgs = OrgScopedArgs & {
  name: string;
  permissions: string[];
};

type MemberAddArgs = OrgScopedArgs & {
  userEmail: string;
  roleId: string;
};

type MemberCreateAccountArgs = OrgScopedArgs & {
  firstName: string;
  lastName: string;
  email: string;
  roleId: string;
};

type QuoteSaveArgs = OrgScopedArgs & {
  customerId: string;
  vehicleId: string;
  companyId?: string;
  mode?: MobileQuoteMode;
  leadId?: string;
  vehiclePrice: number;
  downPayment: number;
  termMonths: number;
  totalFinancedAmount?: number;
  monthlyInstallment?: number;
  profitRateApplied?: number;
  totalProfit?: number;
  recipientName?: string;
  manualProviderName?: string;
  manualProfitRate?: number;
  manualInsuranceRate?: number;
  manualAdminFees?: number;
  manualCommission?: number;
  manualIncludesCommissionInDebt?: boolean;
};

type TransactionMutationArgs = OrgScopedArgs & {
  type: MobileLedgerType;
  amount: number;
  date: number;
  category: MobileLedgerCategory;
  description: string;
  vehicleId?: string;
  userId?: string;
  expenseId?: string;
  idempotencyKey?: string;
};

type ApprovalRespondArgs = OrgScopedArgs & {
  requestId: string;
  status: MobileApprovalStatus;
  notes?: string;
};

type MarketplaceRespondArgs = OrgScopedArgs & {
  requestId: string;
  kind: MobileMarketplaceResponseKind;
  vehicleId?: string;
  offerPriceJod?: number;
  note?: string;
};

type MarketplaceMakeOfferArgs = OrgScopedArgs & {
  tradeInRequestId: string;
  offerAmountJod: number;
};

type BuyerRequestStatusArgs = {
  requestId: string;
  buyerPhone: string;
};

type MarketplaceSubmitRequestArgs = {
  buyerFirstName: string;
  buyerPhone: string;
  buyerWhatsApp?: string;
  buyerCity: string;
  make?: string;
  model?: string;
  yearMin?: number;
  yearMax?: number;
  priceMin?: number;
  priceMax?: number;
  paymentType: MobilePaymentType;
  monthlyBudget?: number;
  buyerTimeframe: MobileBuyerTimeframe;
  consentAccepted: boolean;
  clientFingerprint: string;
  turnstileToken: string;
};

type BuyerTradeInStatusArgs = {
  tradeInRequestId: string;
  buyerPhone: string;
};

type MarketplaceSubmitTradeInArgs = {
  orgId: string;
  buyerFirstName: string;
  buyerPhone: string;
  currentMake: string;
  currentModel: string;
  currentYear: number;
  currentMileage: number;
  condition: MobileTradeInCondition;
  notes?: string;
  consentAccepted: boolean;
  clientFingerprint: string;
  turnstileToken: string;
};

export const api = {
  adminAuth: {
    isSuperAdmin: makeFunctionReference<"query", Record<string, never>, boolean>(
      "adminAuth:isSuperAdmin",
    ),
  },
  dashboard: {
    stats: makeFunctionReference<"query", DashboardStatsArgs, MobileDashboardStats>(
      "dashboard:stats",
    ),
    dataQualityStats: makeFunctionReference<
      "query",
      OrgScopedArgs,
      MobileDataQualityStats
    >("dashboard:dataQualityStats"),
  },
  organizations: {
    listMine: makeFunctionReference<
      "query",
      Record<string, never>,
      Array<MobileOrgSummary | null>
    >("organizations:listMine"),
  },
  users: {
    getMe: makeFunctionReference<"query", Record<string, never>, MobileUserProfile>(
      "users:getMe",
    ),
  },
  memberships: {
    list: makeFunctionReference<"query", MembershipListArgs, MobilePageResult<MobileMembership>>(
      "memberships:list",
    ),
    getMyMembership: makeFunctionReference<"query", OrgScopedArgs, MobileMyMembership>(
      "memberships:getMyMembership",
    ),
    add: makeFunctionReference<"mutation", MemberAddArgs, { status: string }>("memberships:add"),
    createAccount: makeFunctionReference<
      "action",
      MemberCreateAccountArgs,
      { success: boolean }
    >("memberships:createAccount"),
    updateRole: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { membershipId: string; newRoleId: string },
      null
    >("memberships:updateRole"),
    updateCommissionRate: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { membershipId: string; commissionRate: number },
      null
    >("memberships:updateCommissionRate"),
  },
  roles: {
    list: makeFunctionReference<"query", OrgScopedArgs, MobileRole[]>("roles:list"),
    create: makeFunctionReference<"mutation", RoleMutationArgs, string>("roles:create"),
    update: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { roleId: string; name?: string; permissions?: string[] },
      null
    >("roles:update"),
    remove: makeFunctionReference<"mutation", OrgScopedArgs & { roleId: string }, null>(
      "roles:remove",
    ),
  },
  customers: {
    list: makeFunctionReference<"query", CustomerListArgs, MobilePageResult<MobileCustomer>>(
      "customers:list",
    ),
    get: makeFunctionReference<"query", CustomerScopedArgs, MobileCustomer | null>(
      "customers:get",
    ),
    getRelations: makeFunctionReference<"query", CustomerScopedArgs, MobileCustomerRelations>(
      "customers:getRelations",
    ),
    create: makeFunctionReference<"mutation", CustomerCreateArgs, string>("customers:create"),
    update: makeFunctionReference<"mutation", CustomerUpdateArgs, null>("customers:update"),
    softDelete: makeFunctionReference<"mutation", OrgScopedArgs & { customerId: string }, null>(
      "customers:softDelete",
    ),
  },
  guarantors: {
    listByCustomer: makeFunctionReference<"query", CustomerScopedArgs, MobileGuarantor[]>(
      "guarantors:listByCustomer",
    ),
    add: makeFunctionReference<"mutation", GuarantorCreateArgs, string>("guarantors:add"),
    update: makeFunctionReference<"mutation", GuarantorUpdateArgs, null>("guarantors:update"),
    remove: makeFunctionReference<"mutation", OrgScopedArgs & { guarantorId: string }, null>(
      "guarantors:remove",
    ),
  },
  leads: {
    list: makeFunctionReference<"query", LeadListArgs, MobilePageResult<MobileLead>>("leads:list"),
    create: makeFunctionReference<"mutation", LeadCreateArgs, string>("leads:create"),
    update: makeFunctionReference<"mutation", LeadUpdateArgs, null>("leads:update"),
    softDelete: makeFunctionReference<"mutation", OrgScopedArgs & { leadId: string }, null>(
      "leads:softDelete",
    ),
  },
  tasks: {
    list: makeFunctionReference<"query", TaskListArgs, MobilePageResult<MobileTask>>("tasks:list"),
    create: makeFunctionReference<"mutation", TaskCreateArgs, string>("tasks:create"),
    update: makeFunctionReference<"mutation", TaskUpdateArgs, null>("tasks:update"),
  },
  sales: {
    list: makeFunctionReference<"query", SaleListArgs, MobilePageResult<MobileSale>>("sales:list"),
    createDraft: makeFunctionReference<"mutation", SaleDraftCreateArgs, string>(
      "sales:createDraft",
    ),
    completeDraft: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { saleId: string; idempotencyKey?: string },
      string
    >("sales:completeDraft"),
    completeFromQuote: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { quoteId: string; idempotencyKey?: string },
      string
    >("sales:completeFromQuote"),
    update: makeFunctionReference<"mutation", SaleUpdateArgs, null>("sales:update"),
    softDelete: makeFunctionReference<"mutation", OrgScopedArgs & { saleId: string }, null>(
      "sales:softDelete",
    ),
    listCommissions: makeFunctionReference<
      "query",
      OrgScopedArgs & { salespersonId?: string; paidStatus?: "paid" | "unpaid" },
      MobileSale[]
    >("sales:listCommissions"),
    markCommissionPaid: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { saleId: string; paymentMethod?: MobilePaymentMethod; idempotencyKey?: string },
      string
    >("sales:markCommissionPaid"),
  },
  expenses: {
    list: makeFunctionReference<"query", ExpenseListArgs, MobilePageResult<MobileExpense>>(
      "expenses:list",
    ),
    create: makeFunctionReference<"mutation", ExpenseCreateArgs, string>("expenses:create"),
    update: makeFunctionReference<"mutation", ExpenseUpdateArgs, null>("expenses:update"),
    remove: makeFunctionReference<"mutation", OrgScopedArgs & { expenseId: string }, null>(
      "expenses:remove",
    ),
  },
  orgSettings: {
    get: makeFunctionReference<"query", OrgScopedArgs, MobileOrgSettings | null>("orgSettings:get"),
    upsert: makeFunctionReference<"mutation", OrgSettingsUpsertArgs, string>("orgSettings:upsert"),
  },
  orgPipelineStages: {
    list: makeFunctionReference<"query", OrgScopedArgs, MobilePipelineStage[]>(
      "orgPipelineStages:list",
    ),
    seed: makeFunctionReference<"mutation", OrgScopedArgs, null>("orgPipelineStages:seed"),
    update: makeFunctionReference<"mutation", PipelineStageUpdateArgs, null>(
      "orgPipelineStages:update",
    ),
    reorder: makeFunctionReference<"mutation", OrgScopedArgs & { orderedIds: string[] }, null>(
      "orgPipelineStages:reorder",
    ),
  },
  orgLeadSources: {
    list: makeFunctionReference<"query", OrgScopedArgs, MobileLeadSource[]>("orgLeadSources:list"),
    seed: makeFunctionReference<"mutation", OrgScopedArgs, null>("orgLeadSources:seed"),
    create: makeFunctionReference<"mutation", LeadSourceCreateArgs, string>("orgLeadSources:create"),
    update: makeFunctionReference<"mutation", LeadSourceUpdateArgs, null>("orgLeadSources:update"),
    remove: makeFunctionReference<"mutation", OrgScopedArgs & { sourceId: string }, null>(
      "orgLeadSources:remove",
    ),
    reorder: makeFunctionReference<"mutation", OrgScopedArgs & { orderedIds: string[] }, null>(
      "orgLeadSources:reorder",
    ),
  },
  orgCustomFields: {
    list: makeFunctionReference<
      "query",
      OrgScopedArgs & { entityType?: MobileCustomFieldEntityType },
      MobileCustomField[]
    >("orgCustomFields:list"),
    create: makeFunctionReference<"mutation", CustomFieldCreateArgs, string>(
      "orgCustomFields:create",
    ),
    update: makeFunctionReference<"mutation", CustomFieldUpdateArgs, null>(
      "orgCustomFields:update",
    ),
    remove: makeFunctionReference<"mutation", OrgScopedArgs & { fieldId: string }, null>(
      "orgCustomFields:remove",
    ),
  },
  orgValuationCompanies: {
    list: makeFunctionReference<"query", OrgScopedArgs, MobileValuationCompany[]>(
      "orgValuationCompanies:list",
    ),
    seed: makeFunctionReference<"mutation", OrgScopedArgs, null>("orgValuationCompanies:seed"),
    create: makeFunctionReference<"mutation", ValuationCompanyCreateArgs, string>(
      "orgValuationCompanies:create",
    ),
    update: makeFunctionReference<"mutation", ValuationCompanyUpdateArgs, null>(
      "orgValuationCompanies:update",
    ),
    remove: makeFunctionReference<"mutation", OrgScopedArgs & { companyId: string }, null>(
      "orgValuationCompanies:remove",
    ),
  },
  socialIntegrations: {
    getConnectionStatus: makeFunctionReference<
      "query",
      OrgScopedArgs,
      MobileInstagramConnectionStatus
    >("socialIntegrations:getConnectionStatus"),
    setInstagramAutoReplyConfig: makeFunctionReference<"mutation", AutoReplyConfigArgs, null>(
      "socialIntegrations:setInstagramAutoReplyConfig",
    ),
    setInstagramLeadCreationConfig: makeFunctionReference<"mutation", LeadCreationConfigArgs, null>(
      "socialIntegrations:setInstagramLeadCreationConfig",
    ),
    setAutoPostEnabled: makeFunctionReference<"mutation", OrgScopedArgs & { enabled: boolean }, null>(
      "socialIntegrations:setAutoPostEnabled",
    ),
  },
  facebookIntegrations: {
    getConnectionStatus: makeFunctionReference<
      "query",
      OrgScopedArgs,
      MobileFacebookConnectionStatus
    >("facebookIntegrations:getConnectionStatus"),
    setFacebookAutoReplyConfig: makeFunctionReference<"mutation", AutoReplyConfigArgs, null>(
      "facebookIntegrations:setFacebookAutoReplyConfig",
    ),
    setFacebookLeadCreationConfig: makeFunctionReference<"mutation", LeadCreationConfigArgs, null>(
      "facebookIntegrations:setFacebookLeadCreationConfig",
    ),
  },
  websites: {
    getStatus: makeFunctionReference<"query", OrgScopedArgs, MobileWebsiteStatus>(
      "websites:getStatus",
    ),
    startSetup: makeFunctionReference<"mutation", OrgScopedArgs, string>("websites:startSetup"),
    saveDraft: makeFunctionReference<"mutation", WebsiteDraftArgs, null>("websites:saveDraft"),
    publish: makeFunctionReference<"mutation", OrgScopedArgs, string>("websites:publish"),
    unpublish: makeFunctionReference<"mutation", OrgScopedArgs, null>("websites:unpublish"),
  },
  feedback: {
    list: makeFunctionReference<"query", FeedbackListArgs, MobileFeedback[]>("feedback:list"),
    myList: makeFunctionReference<"query", FeedbackListArgs, MobileFeedback[]>("feedback:myList"),
    submit: makeFunctionReference<"mutation", FeedbackSubmitArgs, null>("feedback:submit"),
    setStatus: makeFunctionReference<"mutation", FeedbackStatusArgs, null>("feedback:setStatus"),
  },
  subscriptions: {
    getMySubscription: makeFunctionReference<"query", OrgScopedArgs, MobileSubscription>(
      "subscriptions:getMySubscription",
    ),
    getPlans: makeFunctionReference<"query", Record<string, never>, MobileSubscriptionPlan[]>(
      "subscriptions:getPlans",
    ),
    getUsageStats: makeFunctionReference<"query", OrgScopedArgs, MobileUsageStats>(
      "subscriptions:getUsageStats",
    ),
    getShowPricing: makeFunctionReference<"query", Record<string, never>, boolean>(
      "subscriptions:getShowPricing",
    ),
    requestUpgrade: makeFunctionReference<"action", UpgradeRequestArgs, null>(
      "subscriptions:requestUpgrade",
    ),
  },
  branches: {
    list: makeFunctionReference<"query", OrgScopedArgs, MobileBranch[]>("branches:list"),
    add: makeFunctionReference<"mutation", BranchMutationArgs, null>("branches:add"),
    update: makeFunctionReference<
      "mutation",
      BranchMutationArgs & { id: string },
      null
    >("branches:update"),
  },
  orgCustomerStatuses: {
    list: makeFunctionReference<"query", OrgScopedArgs, MobileCustomerStatus[]>(
      "orgCustomerStatuses:list",
    ),
  },
  finance: {
    listValuations: makeFunctionReference<
      "query",
      OrgScopedArgs & { vehicleId: string },
      MobileVehicleValuation[]
    >("finance:listValuations"),
    listCompanies: makeFunctionReference<"query", OrgScopedArgs, MobileFinanceCompany[]>(
      "finance:listCompanies",
    ),
    createCompany: makeFunctionReference<"mutation", FinanceCompanyMutationArgs, string>(
      "finance:createCompany",
    ),
    updateCompany: makeFunctionReference<
      "mutation",
      FinanceCompanyMutationArgs & { id: string },
      null
    >("finance:updateCompany"),
    deleteCompany: makeFunctionReference<"mutation", OrgScopedArgs & { id: string }, null>(
      "finance:deleteCompany",
    ),
  },
  quotes: {
    listQuotesByCustomer: makeFunctionReference<
      "query",
      OrgScopedArgs & { customerId: string },
      MobileQuote[]
    >("quotes:listQuotesByCustomer"),
    saveQuote: makeFunctionReference<"mutation", QuoteSaveArgs, string>("quotes:saveQuote"),
    updateQuoteStatus: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { quoteId: string; status: MobileQuoteStatus },
      null
    >("quotes:updateQuoteStatus"),
  },
  notifications: {
    listPage: makeFunctionReference<
      "query",
      NotificationListArgs,
      MobilePageResult<MobileNotification>
    >("notifications:listPage"),
    unreadCount: makeFunctionReference<"query", OrgScopedArgs, number>(
      "notifications:unreadCount",
    ),
    markAsRead: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { notificationId: string },
      null
    >("notifications:markAsRead"),
    markAllAsRead: makeFunctionReference<"mutation", OrgScopedArgs, null>(
      "notifications:markAllAsRead",
    ),
    archive: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { notificationId: string },
      null
    >("notifications:archive"),
  },
  directMessages: {
    listConversations: makeFunctionReference<
      "query",
      OrgScopedArgs,
      MobileDirectConversation[]
    >("directMessages:listConversations"),
    getConversation: makeFunctionReference<
      "query",
      DirectConversationArgs,
      MobileDirectConversation | null
    >("directMessages:getConversation"),
    listMessages: makeFunctionReference<
      "query",
      DirectMessageListArgs,
      MobilePageResult<MobileDirectMessage>
    >("directMessages:listMessages"),
    getOrgMembers: makeFunctionReference<"query", OrgScopedArgs, MobileDirectMember[]>(
      "directMessages:getOrgMembers",
    ),
    getOrCreateDm: makeFunctionReference<"mutation", DirectDmArgs, string>(
      "directMessages:getOrCreateDm",
    ),
    createGroup: makeFunctionReference<"mutation", DirectGroupArgs, string>(
      "directMessages:createGroup",
    ),
    sendMessage: makeFunctionReference<"mutation", DirectSendMessageArgs, string>(
      "directMessages:sendMessage",
    ),
    markDelivered: makeFunctionReference<"mutation", DirectConversationArgs, null>(
      "directMessages:markDelivered",
    ),
    markRead: makeFunctionReference<"mutation", DirectConversationArgs, null>(
      "directMessages:markRead",
    ),
    setTyping: makeFunctionReference<"mutation", DirectTypingArgs, null>(
      "directMessages:setTyping",
    ),
    setMuted: makeFunctionReference<"mutation", DirectMutedArgs, null>(
      "directMessages:setMuted",
    ),
  },
  transactions: {
    list: makeFunctionReference<
      "query",
      TransactionListArgs,
      MobilePageResult<MobileLedgerTransaction>
    >("transactions:list"),
    add: makeFunctionReference<"mutation", TransactionMutationArgs, string>("transactions:add"),
    update: makeFunctionReference<
      "mutation",
      Partial<Omit<TransactionMutationArgs, "orgId" | "idempotencyKey">> &
        OrgScopedArgs & { transactionId: string },
      null
    >("transactions:update"),
    remove: makeFunctionReference<"mutation", OrgScopedArgs & { transactionId: string }, null>(
      "transactions:remove",
    ),
  },
  sourcingPayables: {
    list: makeFunctionReference<
      "query",
      OrgScopedArgs & { status?: MobileSupplierPayableStatus },
      MobileSupplierPayable[]
    >("sourcingPayables:list"),
    markPaid: makeFunctionReference<
      "mutation",
      OrgScopedArgs & {
        payableId: string;
        paymentNotes?: string;
        paymentMethod?: MobilePaymentMethod;
        taxAmount?: number;
        idempotencyKey?: string;
      },
      null
    >("sourcingPayables:markPaid"),
  },
  socialInbox: {
    listConversations: makeFunctionReference<
      "query",
      SocialConversationListArgs,
      MobilePageResult<MobileSocialConversation>
    >("socialInbox:listConversations"),
    listEventsForConversation: makeFunctionReference<
      "query",
      SocialEventsArgs,
      MobileSocialConversationEvent[]
    >("socialInbox:listEventsForConversation"),
    setConversationVehicle: makeFunctionReference<
      "mutation",
      OrgScopedArgs & {
        customerId: string;
        vehicleId: string;
        platform?: MobileSocialPlatform;
        conversationKind?: MobileSocialConversationKind;
        conversationPostId?: string;
      },
      null
    >("socialInbox:setConversationVehicle"),
    platformStats: makeFunctionReference<"query", OrgScopedArgs, MobileSocialPlatformStats>(
      "socialInbox:platformStats",
    ),
  },
  instagramEngagement: {
    replyToInstagramComment: makeFunctionReference<
      "action",
      OrgScopedArgs & { instagramEventId: string; message: string },
      null
    >("instagramEngagement:replyToInstagramComment"),
    sendInstagramDirectMessage: makeFunctionReference<
      "action",
      OrgScopedArgs & { customerId: string; message: string },
      null
    >("instagramEngagement:sendInstagramDirectMessage"),
  },
  facebookEngagement: {
    replyToFacebookComment: makeFunctionReference<
      "action",
      OrgScopedArgs & { facebookEventId: string; message: string },
      null
    >("facebookEngagement:replyToFacebookComment"),
    sendFacebookDirectMessage: makeFunctionReference<
      "action",
      OrgScopedArgs & { customerId: string; message: string },
      null
    >("facebookEngagement:sendFacebookDirectMessage"),
  },
  reports: {
    getSalesAndProfitReport: makeFunctionReference<"query", ReportRangeArgs, MobileSalesReport>(
      "reports:getSalesAndProfitReport",
    ),
    getInventoryReport: makeFunctionReference<"query", OrgScopedArgs, MobileInventoryReport>(
      "reports:getInventoryReport",
    ),
    getExpensesReport: makeFunctionReference<"query", ReportRangeArgs, MobileExpensesReport>(
      "reports:getExpensesReport",
    ),
    getSalespersonPerformance: makeFunctionReference<
      "query",
      ReportRangeArgs,
      MobileSalespersonPerformanceRow[]
    >("reports:getSalespersonPerformance"),
    getLeadConversionReport: makeFunctionReference<
      "query",
      ReportRangeArgs,
      MobileLeadConversionReport
    >("reports:getLeadConversionReport"),
  },
  applications: {
    list: makeFunctionReference<
      "query",
      ApplicationListArgs,
      MobilePageResult<MobileFinanceApplication>
    >("applications:list"),
    createFromQuote: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { quoteId: string; notes?: string },
      string
    >("applications:createFromQuote"),
  },
  wizardDrafts: {
    getMyDraft: makeFunctionReference<"query", OrgScopedArgs, MobileWizardDraft | null>(
      "wizardDrafts:getMyDraft",
    ),
    saveDraft: makeFunctionReference<
      "mutation",
      OrgScopedArgs & {
        paymentType: string;
        currentStep: number;
        wizardData: MobileWizardDraftData;
        selectedCustomerId?: string;
      },
      null
    >("wizardDrafts:saveDraft"),
    clearDraft: makeFunctionReference<"mutation", OrgScopedArgs, null>("wizardDrafts:clearDraft"),
  },
  paymentVouchers: {
    getByDeposit: makeFunctionReference<
      "query",
      OrgScopedArgs & { depositId: string },
      MobilePaymentVoucher | null
    >("paymentVouchers:getByDeposit"),
  },
  deposits: {
    create: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { quoteId: string; amount: number; notes?: string; idempotencyKey?: string },
      string
    >("deposits:create"),
    listByVehicle: makeFunctionReference<
      "query",
      VehicleScopedArgs,
      MobileVehicleDeposit[]
    >("deposits:listByVehicle"),
    release: makeFunctionReference<"mutation", DepositReleaseArgs, unknown>("deposits:release"),
  },
  approvals: {
    checkPendingApproval: makeFunctionReference<
      "query",
      OrgScopedArgs & { vehicleId: string },
      MobileProfitApprovalCheck | null
    >("approvals:checkPendingApproval"),
    requestProfitApproval: makeFunctionReference<
      "mutation",
      OrgScopedArgs & {
        vehicleId: string;
        requestedProfit: number;
        minimumProfit: number;
        wizardSnapshot: Record<string, unknown>;
      },
      unknown
    >("approvals:requestProfitApproval"),
    listPendingApprovals: makeFunctionReference<
      "query",
      OrgScopedArgs,
      MobileApprovalRequest[]
    >("approvals:listPendingApprovals"),
    respondToApproval: makeFunctionReference<"mutation", ApprovalRespondArgs, null>(
      "approvals:respondToApproval",
    ),
  },
  marketplaceBrowse: {
    search: makeFunctionReference<
      "query",
      MarketplaceSearchArgs,
      MobileMarketplaceSearchResult
    >("marketplaceBrowse:search"),
  },
  marketplaceDealers: {
    listPublicDirectory: makeFunctionReference<
      "query",
      Record<string, never>,
      MobileMarketplaceDealer[]
    >("marketplaceDealers:listPublicDirectory"),
    getMyProfile: makeFunctionReference<
      "query",
      OrgScopedArgs,
      MobileMarketplaceDealerProfile | null
    >("marketplaceDealers:getMyProfile"),
    updateProfile: makeFunctionReference<
      "mutation",
      MarketplaceDealerProfileUpdateArgs,
      string
    >("marketplaceDealers:updateProfile"),
  },
  marketplaceRequests: {
    submitRequest: makeFunctionReference<
      "action",
      MarketplaceSubmitRequestArgs,
      MobileMarketplaceSubmitRequestResult
    >("marketplaceRequests:submitRequest"),
    getStatusForBuyerByPublicId: makeFunctionReference<
      "query",
      BuyerRequestStatusArgs,
      MobileMarketplaceRequestBuyerStatus | null
    >("marketplaceRequests:getStatusForBuyerByPublicId"),
  },
  marketplaceResponses: {
    listForOrg: makeFunctionReference<
      "query",
      OrgScopedArgs,
      MobileMarketplaceRequestRow[]
    >("marketplaceResponses:listForOrg"),
    respond: makeFunctionReference<
      "mutation",
      MarketplaceRespondArgs,
      { leadId: string }
    >("marketplaceResponses:respond"),
  },
  marketplaceTradeIns: {
    submitTradeInRequest: makeFunctionReference<
      "action",
      MarketplaceSubmitTradeInArgs,
      MobileMarketplaceSubmitTradeInResult
    >("marketplaceTradeIns:submitTradeInRequest"),
    listForOrg: makeFunctionReference<
      "query",
      OrgScopedArgs,
      MobileMarketplaceTradeInRow[]
    >("marketplaceTradeIns:listForOrg"),
    makeOffer: makeFunctionReference<
      "mutation",
      MarketplaceMakeOfferArgs,
      null
    >("marketplaceTradeIns:makeOffer"),
    getStatusForBuyerByPublicId: makeFunctionReference<
      "query",
      BuyerTradeInStatusArgs,
      MobileMarketplaceTradeInBuyerStatus | null
    >("marketplaceTradeIns:getStatusForBuyerByPublicId"),
    acceptOfferByPublicId: makeFunctionReference<
      "mutation",
      BuyerTradeInStatusArgs,
      MobileMarketplaceOfferActionResult
    >("marketplaceTradeIns:acceptOfferByPublicId"),
    declineOfferByPublicId: makeFunctionReference<
      "mutation",
      BuyerTradeInStatusArgs,
      MobileMarketplaceOfferActionResult
    >("marketplaceTradeIns:declineOfferByPublicId"),
  },
  vehicles: {
    list: makeFunctionReference<
      "query",
      VehicleListArgs,
      MobilePageResult<MobileVehicle>
    >("vehicles:list"),
    create: makeFunctionReference<"mutation", VehicleCreateArgs, string>("vehicles:create"),
    update: makeFunctionReference<"mutation", VehicleUpdateArgs, null>("vehicles:update"),
    softDelete: makeFunctionReference<"mutation", OrgScopedArgs & { vehicleId: string }, null>(
      "vehicles:softDelete",
    ),
    listAll: makeFunctionReference<
      "query",
      OrgScopedArgs & {
        status?: MobileVehicleStatus;
        includeReserved?: boolean;
        sourceType?: MobileVehicleSourceType;
      },
      MobileVehiclePickerItem[]
    >("vehicles:listAll"),
    getRelations: makeFunctionReference<
      "query",
      VehicleScopedArgs,
      MobileVehicleRelations
    >("vehicles:getRelations"),
    getLandedCosts: makeFunctionReference<
      "query",
      VehicleScopedArgs,
      MobileLandedCosts | null
    >("vehicles:getLandedCosts"),
    upsertLandedCosts: makeFunctionReference<
      "mutation",
      VehicleScopedArgs & { items: MobileLandedCostItem[] },
      unknown
    >("vehicles:upsertLandedCosts"),
    getPricingHistory: makeFunctionReference<
      "query",
      VehicleScopedArgs,
      MobileVehiclePriceHistoryEntry[]
    >("vehicles:getPricingHistory"),
    getReservationHistory: makeFunctionReference<
      "query",
      VehicleScopedArgs,
      MobileVehicleReservation[]
    >("vehicles:getReservationHistory"),
    createReservation: makeFunctionReference<"mutation", ReservationCreateArgs, unknown>(
      "vehicles:createReservation",
    ),
    releaseReservation: makeFunctionReference<
      "mutation",
      OrgScopedArgs & { reservationId: string },
      unknown
    >("vehicles:releaseReservation"),
  },
} satisfies {
  adminAuth: {
    isSuperAdmin: FunctionReference<"query", "public", Record<string, never>, boolean>;
  };
  dashboard: {
    stats: FunctionReference<"query", "public", DashboardStatsArgs, MobileDashboardStats>;
    dataQualityStats: FunctionReference<
      "query",
      "public",
      OrgScopedArgs,
      MobileDataQualityStats
    >;
  };
  organizations: {
    listMine: FunctionReference<
      "query",
      "public",
      Record<string, never>,
      Array<MobileOrgSummary | null>
    >;
  };
  users: {
    getMe: FunctionReference<"query", "public", Record<string, never>, MobileUserProfile>;
  };
  memberships: {
    list: FunctionReference<"query", "public", MembershipListArgs, MobilePageResult<MobileMembership>>;
    getMyMembership: FunctionReference<"query", "public", OrgScopedArgs, MobileMyMembership>;
    add: FunctionReference<"mutation", "public", MemberAddArgs, { status: string }>;
    createAccount: FunctionReference<"action", "public", MemberCreateAccountArgs, { success: boolean }>;
    updateRole: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & { membershipId: string; newRoleId: string },
      null
    >;
    updateCommissionRate: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & { membershipId: string; commissionRate: number },
      null
    >;
  };
  roles: {
    list: FunctionReference<"query", "public", OrgScopedArgs, MobileRole[]>;
    create: FunctionReference<"mutation", "public", RoleMutationArgs, string>;
    update: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & { roleId: string; name?: string; permissions?: string[] },
      null
    >;
    remove: FunctionReference<"mutation", "public", OrgScopedArgs & { roleId: string }, null>;
  };
  customers: {
    list: FunctionReference<"query", "public", CustomerListArgs, MobilePageResult<MobileCustomer>>;
    get: FunctionReference<"query", "public", CustomerScopedArgs, MobileCustomer | null>;
    getRelations: FunctionReference<"query", "public", CustomerScopedArgs, MobileCustomerRelations>;
    create: FunctionReference<"mutation", "public", CustomerCreateArgs, string>;
    update: FunctionReference<"mutation", "public", CustomerUpdateArgs, null>;
    softDelete: FunctionReference<"mutation", "public", OrgScopedArgs & { customerId: string }, null>;
  };
  guarantors: {
    listByCustomer: FunctionReference<"query", "public", CustomerScopedArgs, MobileGuarantor[]>;
    add: FunctionReference<"mutation", "public", GuarantorCreateArgs, string>;
    update: FunctionReference<"mutation", "public", GuarantorUpdateArgs, null>;
    remove: FunctionReference<"mutation", "public", OrgScopedArgs & { guarantorId: string }, null>;
  };
  leads: {
    list: FunctionReference<"query", "public", LeadListArgs, MobilePageResult<MobileLead>>;
    create: FunctionReference<"mutation", "public", LeadCreateArgs, string>;
    update: FunctionReference<"mutation", "public", LeadUpdateArgs, null>;
    softDelete: FunctionReference<"mutation", "public", OrgScopedArgs & { leadId: string }, null>;
  };
  tasks: {
    list: FunctionReference<"query", "public", TaskListArgs, MobilePageResult<MobileTask>>;
    create: FunctionReference<"mutation", "public", TaskCreateArgs, string>;
    update: FunctionReference<"mutation", "public", TaskUpdateArgs, null>;
  };
  sales: {
    list: FunctionReference<"query", "public", SaleListArgs, MobilePageResult<MobileSale>>;
    createDraft: FunctionReference<"mutation", "public", SaleDraftCreateArgs, string>;
    completeDraft: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & { saleId: string; idempotencyKey?: string },
      string
    >;
    completeFromQuote: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & { quoteId: string; idempotencyKey?: string },
      string
    >;
    update: FunctionReference<"mutation", "public", SaleUpdateArgs, null>;
    softDelete: FunctionReference<"mutation", "public", OrgScopedArgs & { saleId: string }, null>;
    listCommissions: FunctionReference<
      "query",
      "public",
      OrgScopedArgs & { salespersonId?: string; paidStatus?: "paid" | "unpaid" },
      MobileSale[]
    >;
    markCommissionPaid: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & { saleId: string; paymentMethod?: MobilePaymentMethod; idempotencyKey?: string },
      string
    >;
  };
  expenses: {
    list: FunctionReference<"query", "public", ExpenseListArgs, MobilePageResult<MobileExpense>>;
    create: FunctionReference<"mutation", "public", ExpenseCreateArgs, string>;
    update: FunctionReference<"mutation", "public", ExpenseUpdateArgs, null>;
    remove: FunctionReference<"mutation", "public", OrgScopedArgs & { expenseId: string }, null>;
  };
  orgSettings: {
    get: FunctionReference<"query", "public", OrgScopedArgs, MobileOrgSettings | null>;
    upsert: FunctionReference<"mutation", "public", OrgSettingsUpsertArgs, string>;
  };
  orgPipelineStages: {
    list: FunctionReference<"query", "public", OrgScopedArgs, MobilePipelineStage[]>;
    seed: FunctionReference<"mutation", "public", OrgScopedArgs, null>;
    update: FunctionReference<"mutation", "public", PipelineStageUpdateArgs, null>;
    reorder: FunctionReference<"mutation", "public", OrgScopedArgs & { orderedIds: string[] }, null>;
  };
  orgLeadSources: {
    list: FunctionReference<"query", "public", OrgScopedArgs, MobileLeadSource[]>;
    seed: FunctionReference<"mutation", "public", OrgScopedArgs, null>;
    create: FunctionReference<"mutation", "public", LeadSourceCreateArgs, string>;
    update: FunctionReference<"mutation", "public", LeadSourceUpdateArgs, null>;
    remove: FunctionReference<"mutation", "public", OrgScopedArgs & { sourceId: string }, null>;
    reorder: FunctionReference<"mutation", "public", OrgScopedArgs & { orderedIds: string[] }, null>;
  };
  orgCustomFields: {
    list: FunctionReference<
      "query",
      "public",
      OrgScopedArgs & { entityType?: MobileCustomFieldEntityType },
      MobileCustomField[]
    >;
    create: FunctionReference<"mutation", "public", CustomFieldCreateArgs, string>;
    update: FunctionReference<"mutation", "public", CustomFieldUpdateArgs, null>;
    remove: FunctionReference<"mutation", "public", OrgScopedArgs & { fieldId: string }, null>;
  };
  orgValuationCompanies: {
    list: FunctionReference<"query", "public", OrgScopedArgs, MobileValuationCompany[]>;
    seed: FunctionReference<"mutation", "public", OrgScopedArgs, null>;
    create: FunctionReference<"mutation", "public", ValuationCompanyCreateArgs, string>;
    update: FunctionReference<"mutation", "public", ValuationCompanyUpdateArgs, null>;
    remove: FunctionReference<"mutation", "public", OrgScopedArgs & { companyId: string }, null>;
  };
  socialIntegrations: {
    getConnectionStatus: FunctionReference<
      "query",
      "public",
      OrgScopedArgs,
      MobileInstagramConnectionStatus
    >;
    setInstagramAutoReplyConfig: FunctionReference<"mutation", "public", AutoReplyConfigArgs, null>;
    setInstagramLeadCreationConfig: FunctionReference<"mutation", "public", LeadCreationConfigArgs, null>;
    setAutoPostEnabled: FunctionReference<"mutation", "public", OrgScopedArgs & { enabled: boolean }, null>;
  };
  facebookIntegrations: {
    getConnectionStatus: FunctionReference<
      "query",
      "public",
      OrgScopedArgs,
      MobileFacebookConnectionStatus
    >;
    setFacebookAutoReplyConfig: FunctionReference<"mutation", "public", AutoReplyConfigArgs, null>;
    setFacebookLeadCreationConfig: FunctionReference<"mutation", "public", LeadCreationConfigArgs, null>;
  };
  websites: {
    getStatus: FunctionReference<"query", "public", OrgScopedArgs, MobileWebsiteStatus>;
    startSetup: FunctionReference<"mutation", "public", OrgScopedArgs, string>;
    saveDraft: FunctionReference<"mutation", "public", WebsiteDraftArgs, null>;
    publish: FunctionReference<"mutation", "public", OrgScopedArgs, string>;
    unpublish: FunctionReference<"mutation", "public", OrgScopedArgs, null>;
  };
  feedback: {
    list: FunctionReference<"query", "public", FeedbackListArgs, MobileFeedback[]>;
    myList: FunctionReference<"query", "public", FeedbackListArgs, MobileFeedback[]>;
    submit: FunctionReference<"mutation", "public", FeedbackSubmitArgs, null>;
    setStatus: FunctionReference<"mutation", "public", FeedbackStatusArgs, null>;
  };
  subscriptions: {
    getMySubscription: FunctionReference<"query", "public", OrgScopedArgs, MobileSubscription>;
    getPlans: FunctionReference<"query", "public", Record<string, never>, MobileSubscriptionPlan[]>;
    getUsageStats: FunctionReference<"query", "public", OrgScopedArgs, MobileUsageStats>;
    getShowPricing: FunctionReference<"query", "public", Record<string, never>, boolean>;
    requestUpgrade: FunctionReference<"action", "public", UpgradeRequestArgs, null>;
  };
  branches: {
    list: FunctionReference<"query", "public", OrgScopedArgs, MobileBranch[]>;
    add: FunctionReference<"mutation", "public", BranchMutationArgs, null>;
    update: FunctionReference<"mutation", "public", BranchMutationArgs & { id: string }, null>;
  };
  orgCustomerStatuses: {
    list: FunctionReference<"query", "public", OrgScopedArgs, MobileCustomerStatus[]>;
  };
  finance: {
    listValuations: FunctionReference<
      "query",
      "public",
      OrgScopedArgs & { vehicleId: string },
      MobileVehicleValuation[]
    >;
    listCompanies: FunctionReference<"query", "public", OrgScopedArgs, MobileFinanceCompany[]>;
    createCompany: FunctionReference<"mutation", "public", FinanceCompanyMutationArgs, string>;
    updateCompany: FunctionReference<"mutation", "public", FinanceCompanyMutationArgs & { id: string }, null>;
    deleteCompany: FunctionReference<"mutation", "public", OrgScopedArgs & { id: string }, null>;
  };
  quotes: {
    listQuotesByCustomer: FunctionReference<"query", "public", OrgScopedArgs & { customerId: string }, MobileQuote[]>;
    saveQuote: FunctionReference<"mutation", "public", QuoteSaveArgs, string>;
    updateQuoteStatus: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & { quoteId: string; status: MobileQuoteStatus },
      null
    >;
  };
  notifications: {
    listPage: FunctionReference<"query", "public", NotificationListArgs, MobilePageResult<MobileNotification>>;
    unreadCount: FunctionReference<"query", "public", OrgScopedArgs, number>;
    markAsRead: FunctionReference<"mutation", "public", OrgScopedArgs & { notificationId: string }, null>;
    markAllAsRead: FunctionReference<"mutation", "public", OrgScopedArgs, null>;
    archive: FunctionReference<"mutation", "public", OrgScopedArgs & { notificationId: string }, null>;
  };
  directMessages: {
    listConversations: FunctionReference<
      "query",
      "public",
      OrgScopedArgs,
      MobileDirectConversation[]
    >;
    getConversation: FunctionReference<
      "query",
      "public",
      DirectConversationArgs,
      MobileDirectConversation | null
    >;
    listMessages: FunctionReference<
      "query",
      "public",
      DirectMessageListArgs,
      MobilePageResult<MobileDirectMessage>
    >;
    getOrgMembers: FunctionReference<"query", "public", OrgScopedArgs, MobileDirectMember[]>;
    getOrCreateDm: FunctionReference<"mutation", "public", DirectDmArgs, string>;
    createGroup: FunctionReference<"mutation", "public", DirectGroupArgs, string>;
    sendMessage: FunctionReference<"mutation", "public", DirectSendMessageArgs, string>;
    markDelivered: FunctionReference<"mutation", "public", DirectConversationArgs, null>;
    markRead: FunctionReference<"mutation", "public", DirectConversationArgs, null>;
    setTyping: FunctionReference<"mutation", "public", DirectTypingArgs, null>;
    setMuted: FunctionReference<"mutation", "public", DirectMutedArgs, null>;
  };
  transactions: {
    list: FunctionReference<"query", "public", TransactionListArgs, MobilePageResult<MobileLedgerTransaction>>;
    add: FunctionReference<"mutation", "public", TransactionMutationArgs, string>;
    update: FunctionReference<
      "mutation",
      "public",
      Partial<Omit<TransactionMutationArgs, "orgId" | "idempotencyKey">> &
        OrgScopedArgs & { transactionId: string },
      null
    >;
    remove: FunctionReference<"mutation", "public", OrgScopedArgs & { transactionId: string }, null>;
  };
  sourcingPayables: {
    list: FunctionReference<
      "query",
      "public",
      OrgScopedArgs & { status?: MobileSupplierPayableStatus },
      MobileSupplierPayable[]
    >;
    markPaid: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & {
        payableId: string;
        paymentNotes?: string;
        paymentMethod?: MobilePaymentMethod;
        taxAmount?: number;
        idempotencyKey?: string;
      },
      null
    >;
  };
  socialInbox: {
    listConversations: FunctionReference<
      "query",
      "public",
      SocialConversationListArgs,
      MobilePageResult<MobileSocialConversation>
    >;
    listEventsForConversation: FunctionReference<
      "query",
      "public",
      SocialEventsArgs,
      MobileSocialConversationEvent[]
    >;
    setConversationVehicle: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & {
        customerId: string;
        vehicleId: string;
        platform?: MobileSocialPlatform;
        conversationKind?: MobileSocialConversationKind;
        conversationPostId?: string;
      },
      null
    >;
    platformStats: FunctionReference<"query", "public", OrgScopedArgs, MobileSocialPlatformStats>;
  };
  instagramEngagement: {
    replyToInstagramComment: FunctionReference<
      "action",
      "public",
      OrgScopedArgs & { instagramEventId: string; message: string },
      null
    >;
    sendInstagramDirectMessage: FunctionReference<
      "action",
      "public",
      OrgScopedArgs & { customerId: string; message: string },
      null
    >;
  };
  facebookEngagement: {
    replyToFacebookComment: FunctionReference<
      "action",
      "public",
      OrgScopedArgs & { facebookEventId: string; message: string },
      null
    >;
    sendFacebookDirectMessage: FunctionReference<
      "action",
      "public",
      OrgScopedArgs & { customerId: string; message: string },
      null
    >;
  };
  reports: {
    getSalesAndProfitReport: FunctionReference<"query", "public", ReportRangeArgs, MobileSalesReport>;
    getInventoryReport: FunctionReference<"query", "public", OrgScopedArgs, MobileInventoryReport>;
    getExpensesReport: FunctionReference<"query", "public", ReportRangeArgs, MobileExpensesReport>;
    getSalespersonPerformance: FunctionReference<
      "query",
      "public",
      ReportRangeArgs,
      MobileSalespersonPerformanceRow[]
    >;
    getLeadConversionReport: FunctionReference<"query", "public", ReportRangeArgs, MobileLeadConversionReport>;
  };
  wizardDrafts: {
    getMyDraft: FunctionReference<"query", "public", OrgScopedArgs, MobileWizardDraft | null>;
    saveDraft: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & {
        paymentType: string;
        currentStep: number;
        wizardData: MobileWizardDraftData;
        selectedCustomerId?: string;
      },
      null
    >;
    clearDraft: FunctionReference<"mutation", "public", OrgScopedArgs, null>;
  };
  paymentVouchers: {
    getByDeposit: FunctionReference<
      "query",
      "public",
      OrgScopedArgs & { depositId: string },
      MobilePaymentVoucher | null
    >;
  };
  deposits: {
    create: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & { quoteId: string; amount: number; notes?: string; idempotencyKey?: string },
      string
    >;
    listByVehicle: FunctionReference<"query", "public", VehicleScopedArgs, MobileVehicleDeposit[]>;
    release: FunctionReference<"mutation", "public", DepositReleaseArgs, unknown>;
  };
  applications: {
    createFromQuote: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & { quoteId: string; notes?: string },
      string
    >;
    list: FunctionReference<
      "query",
      "public",
      ApplicationListArgs,
      MobilePageResult<MobileFinanceApplication>
    >;
  };
  approvals: {
    checkPendingApproval: FunctionReference<
      "query",
      "public",
      OrgScopedArgs & { vehicleId: string },
      MobileProfitApprovalCheck | null
    >;
    requestProfitApproval: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & {
        vehicleId: string;
        requestedProfit: number;
        minimumProfit: number;
        wizardSnapshot: Record<string, unknown>;
      },
      unknown
    >;
    listPendingApprovals: FunctionReference<"query", "public", OrgScopedArgs, MobileApprovalRequest[]>;
    respondToApproval: FunctionReference<"mutation", "public", ApprovalRespondArgs, null>;
  };
  marketplaceBrowse: {
    search: FunctionReference<
      "query",
      "public",
      MarketplaceSearchArgs,
      MobileMarketplaceSearchResult
    >;
  };
  marketplaceDealers: {
    listPublicDirectory: FunctionReference<
      "query",
      "public",
      Record<string, never>,
      MobileMarketplaceDealer[]
    >;
    getMyProfile: FunctionReference<
      "query",
      "public",
      OrgScopedArgs,
      MobileMarketplaceDealerProfile | null
    >;
    updateProfile: FunctionReference<
      "mutation",
      "public",
      MarketplaceDealerProfileUpdateArgs,
      string
    >;
  };
  marketplaceRequests: {
    submitRequest: FunctionReference<
      "action",
      "public",
      MarketplaceSubmitRequestArgs,
      MobileMarketplaceSubmitRequestResult
    >;
    getStatusForBuyerByPublicId: FunctionReference<
      "query",
      "public",
      BuyerRequestStatusArgs,
      MobileMarketplaceRequestBuyerStatus | null
    >;
  };
  marketplaceResponses: {
    listForOrg: FunctionReference<"query", "public", OrgScopedArgs, MobileMarketplaceRequestRow[]>;
    respond: FunctionReference<"mutation", "public", MarketplaceRespondArgs, { leadId: string }>;
  };
  marketplaceTradeIns: {
    submitTradeInRequest: FunctionReference<
      "action",
      "public",
      MarketplaceSubmitTradeInArgs,
      MobileMarketplaceSubmitTradeInResult
    >;
    listForOrg: FunctionReference<"query", "public", OrgScopedArgs, MobileMarketplaceTradeInRow[]>;
    makeOffer: FunctionReference<"mutation", "public", MarketplaceMakeOfferArgs, null>;
    getStatusForBuyerByPublicId: FunctionReference<
      "query",
      "public",
      BuyerTradeInStatusArgs,
      MobileMarketplaceTradeInBuyerStatus | null
    >;
    acceptOfferByPublicId: FunctionReference<
      "mutation",
      "public",
      BuyerTradeInStatusArgs,
      MobileMarketplaceOfferActionResult
    >;
    declineOfferByPublicId: FunctionReference<
      "mutation",
      "public",
      BuyerTradeInStatusArgs,
      MobileMarketplaceOfferActionResult
    >;
  };
  vehicles: {
    list: FunctionReference<
      "query",
      "public",
      VehicleListArgs,
      MobilePageResult<MobileVehicle>
    >;
    create: FunctionReference<"mutation", "public", VehicleCreateArgs, string>;
    update: FunctionReference<"mutation", "public", VehicleUpdateArgs, null>;
    softDelete: FunctionReference<"mutation", "public", OrgScopedArgs & { vehicleId: string }, null>;
    listAll: FunctionReference<
      "query",
      "public",
      OrgScopedArgs & {
        status?: MobileVehicleStatus;
        includeReserved?: boolean;
        sourceType?: MobileVehicleSourceType;
      },
      MobileVehiclePickerItem[]
    >;
    getRelations: FunctionReference<"query", "public", VehicleScopedArgs, MobileVehicleRelations>;
    getLandedCosts: FunctionReference<"query", "public", VehicleScopedArgs, MobileLandedCosts | null>;
    upsertLandedCosts: FunctionReference<
      "mutation",
      "public",
      VehicleScopedArgs & { items: MobileLandedCostItem[] },
      unknown
    >;
    getPricingHistory: FunctionReference<
      "query",
      "public",
      VehicleScopedArgs,
      MobileVehiclePriceHistoryEntry[]
    >;
    getReservationHistory: FunctionReference<
      "query",
      "public",
      VehicleScopedArgs,
      MobileVehicleReservation[]
    >;
    createReservation: FunctionReference<"mutation", "public", ReservationCreateArgs, unknown>;
    releaseReservation: FunctionReference<
      "mutation",
      "public",
      OrgScopedArgs & { reservationId: string },
      unknown
    >;
  };
};
