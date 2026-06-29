import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    disabled: v.optional(v.boolean()),
    // Server-known language for email/WhatsApp notifications — the client's
    // locale toggle (LanguageProvider) lives only in localStorage, so this
    // mirrors it server-side whenever an authenticated user changes it.
    locale: v.optional(v.union(v.literal("en"), v.literal("ar"))),
    // Staff member's own WhatsApp number for receiving notifications —
    // distinct from customers.whatsapp (a customer's contact number).
    whatsappPhone: v.optional(v.string()),
  }).index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"]),

  organizations: defineTable({
    name: v.string(),
    createdAt: v.number(),
    suspended: v.optional(v.boolean()),
    suspendedAt: v.optional(v.number()),
    suspendedReason: v.optional(v.string()),
  }),

  commandIdempotency: defineTable({
    orgId: v.id("organizations"),
    operation: v.string(),
    idempotencyKey: v.string(),
    status: v.union(v.literal("STARTED"), v.literal("COMPLETED")),
    result: v.optional(v.any()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_org_operation_key", ["orgId", "operation", "idempotencyKey"])
    .index("by_org_createdAt", ["orgId", "createdAt"]),

  // ─── Phase 1 + 2: Accounting foundation and ledger ────────────────────────

  chartOfAccounts: defineTable({
    orgId: v.id("organizations"),
    code: v.string(),
    name: v.string(),
    nameAr: v.optional(v.string()),
    type: v.union(
      v.literal("ASSET"),
      v.literal("LIABILITY"),
      v.literal("EQUITY"),
      v.literal("REVENUE"),
      v.literal("COGS"),
      v.literal("EXPENSE"),
      v.literal("OTHER_INCOME"),
      v.literal("OTHER_EXPENSE"),
    ),
    subtype: v.optional(v.string()),
    normalBalance: v.union(v.literal("DEBIT"), v.literal("CREDIT")),
    parentAccountId: v.optional(v.id("chartOfAccounts")),
    isControlAccount: v.boolean(),
    allowManualPosting: v.boolean(),
    currencyRestriction: v.optional(v.string()),
    active: v.boolean(),
    systemKey: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
    updatedAt: v.number(),
    updatedBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_code", ["orgId", "code"])
    .index("by_org_systemKey", ["orgId", "systemKey"])
    .index("by_org_type", ["orgId", "type"]),

  accountingPeriods: defineTable({
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
    fiscalYear: v.number(),
    periodNumber: v.number(),
    status: v.union(
      v.literal("FUTURE"),
      v.literal("OPEN"),
      v.literal("CLOSING"),
      v.literal("CLOSED"),
      v.literal("LOCKED"),
    ),
    closedBy: v.optional(v.id("users")),
    closedAt: v.optional(v.number()),
    reopenedBy: v.optional(v.id("users")),
    reopenedAt: v.optional(v.number()),
    reopenReason: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_year_period", ["orgId", "fiscalYear", "periodNumber"])
    .index("by_org_startDate", ["orgId", "startDate"]),

  accountingEvents: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    eventType: v.string(),
    sourceType: v.string(),
    sourceId: v.string(),
    eventVersion: v.number(),
    idempotencyKey: v.string(),
    occurredAt: v.number(),
    accountingDate: v.number(),
    currency: v.string(),
    payload: v.any(),
    payloadHash: v.optional(v.string()),
    status: v.union(
      v.literal("PENDING"),
      v.literal("POSTED"),
      v.literal("FAILED"),
      v.literal("REVERSED"),
    ),
    createdBy: v.id("users"),
    createdAt: v.number(),
    reversedByEventId: v.optional(v.id("accountingEvents")),
    reversalOfEventId: v.optional(v.id("accountingEvents")),
    journalEntryId: v.optional(v.id("journalEntries")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_eventType", ["orgId", "eventType"])
    .index("by_org_source", ["orgId", "sourceType", "sourceId"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"])
    .index("by_org_event_source_version", ["orgId", "eventType", "sourceType", "sourceId", "eventVersion"]),

  journalEntries: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    accountingEventId: v.optional(v.id("accountingEvents")),
    journalNumber: v.string(),
    accountingDate: v.number(),
    periodId: v.optional(v.id("accountingPeriods")),
    sourceType: v.string(),
    sourceId: v.string(),
    category: v.union(
      v.literal("SYSTEM"),
      v.literal("MANUAL"),
      v.literal("REVERSAL"),
      v.literal("ADJUSTMENT"),
    ),
    memo: v.string(),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("VALIDATED"),
      v.literal("POSTED"),
      v.literal("REVERSED"),
    ),
    currency: v.optional(v.string()),
    reversalOfJournalEntryId: v.optional(v.id("journalEntries")),
    reversedByJournalEntryId: v.optional(v.id("journalEntries")),
    postedBy: v.id("users"),
    postedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_date", ["orgId", "accountingDate"])
    .index("by_org_period", ["orgId", "periodId"])
    .index("by_org_source", ["orgId", "sourceType", "sourceId"])
    .index("by_accounting_event", ["accountingEventId"]),

  journalLines: defineTable({
    orgId: v.id("organizations"),
    journalEntryId: v.id("journalEntries"),
    lineNumber: v.number(),
    accountId: v.id("chartOfAccounts"),
    debitMinor: v.number(),
    creditMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    accountingDate: v.number(),
    exchangeRate: v.optional(v.number()),
    reportingDebitMinor: v.optional(v.number()),
    reportingCreditMinor: v.optional(v.number()),
    branchId: v.optional(v.id("branches")),
    vehicleId: v.optional(v.id("vehicles")),
    customerId: v.optional(v.id("customers")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    salespersonId: v.optional(v.id("users")),
    cashierId: v.optional(v.id("users")),
    description: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_journal_entry", ["journalEntryId"])
    .index("by_org_account", ["orgId", "accountId"])
    .index("by_org_account_date", ["orgId", "accountId", "accountingDate"]),

  // ─── Phase 3: Receivables, payments, and allocations subledger ────────────

  receivableDocuments: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    documentType: v.union(
      v.literal("INVOICE"),
      v.literal("INSTALLMENT"),
      v.literal("DEBIT_ADJUSTMENT"),
      v.literal("CREDIT_ADJUSTMENT"),
      v.literal("WRITE_OFF"),
      v.literal("REFUND_PAYABLE"),
    ),
    documentNumber: v.string(),
    payerType: v.union(v.literal("CUSTOMER"), v.literal("FINANCE_COMPANY")),
    customerId: v.optional(v.id("customers")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    sourceType: v.string(),
    sourceId: v.string(),
    originalAmountMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    issueDate: v.number(),
    dueDate: v.number(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("PARTIALLY_PAID"),
      v.literal("PAID"),
      v.literal("WRITTEN_OFF"),
      v.literal("CANCELLED"),
      v.literal("REVERSED"),
    ),
    accountingEventId: v.optional(v.id("accountingEvents")),
    reversedDocumentId: v.optional(v.id("receivableDocuments")),
    createdAt: v.number(),
    createdBy: v.id("users"),
  })
    .index("by_org", ["orgId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_source", ["orgId", "sourceType", "sourceId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_dueDate", ["orgId", "dueDate"]),

  canonicalPayments: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    direction: v.union(v.literal("IN"), v.literal("OUT")),
    payerType: v.optional(v.union(v.literal("CUSTOMER"), v.literal("FINANCE_COMPANY"))),
    customerId: v.optional(v.id("customers")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    method: v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("CARD"),
      v.literal("PAYMENT_LINK"),
      v.literal("CHEQUE"),
      v.literal("INTERNAL_TRANSFER"),
      v.literal("OTHER"),
    ),
    amountMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    receivedAt: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    settledAt: v.optional(v.number()),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("PENDING_VERIFICATION"),
      v.literal("VERIFIED"),
      v.literal("PENDING_SETTLEMENT"),
      v.literal("SETTLED"),
      v.literal("FAILED"),
      v.literal("RETURNED"),
      v.literal("REVERSED"),
      v.literal("REFUNDED"),
      v.literal("VOIDED"),
    ),
    externalReference: v.optional(v.string()),
    provider: v.optional(v.string()),
    providerTransactionId: v.optional(v.string()),
    idempotencyKey: v.string(),
    cashierSessionId: v.optional(v.id("cashierReconciliations")),
    originalPaymentId: v.optional(v.id("canonicalPayments")),
    reversalPaymentId: v.optional(v.id("canonicalPayments")),
    accountingEventId: v.optional(v.id("accountingEvents")),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"]),

  paymentAllocations: defineTable({
    orgId: v.id("organizations"),
    paymentId: v.id("canonicalPayments"),
    receivableDocumentId: v.id("receivableDocuments"),
    amountMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    allocationDate: v.number(),
    status: v.union(
      v.literal("ACTIVE"),
      v.literal("REVERSED"),
    ),
    reversalOfAllocationId: v.optional(v.id("paymentAllocations")),
    reversedByAllocationId: v.optional(v.id("paymentAllocations")),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_payment", ["paymentId"])
    .index("by_receivable", ["receivableDocumentId"])
    .index("by_org_status", ["orgId", "status"]),

  // ─── Phase 7: Financial audit log ─────────────────────────────────────────

  financialAuditLog: defineTable({
    orgId: v.id("organizations"),
    actorId: v.id("users"),
    actionType: v.union(
      v.literal("CREATE_PERIOD"),
      v.literal("POST_EVENT"),
      v.literal("POST_MANUAL_JOURNAL"),
      v.literal("REVERSE_EVENT"),
      v.literal("OPEN_PERIOD"),
      v.literal("CLOSE_PERIOD"),
      v.literal("LOCK_PERIOD"),
      v.literal("REOPEN_PERIOD"),
      v.literal("INIT_CHART"),
      v.literal("UPDATE_ACCOUNT"),
      v.literal("MIGRATE_TRANSACTION"),
      v.literal("ALLOCATE_PAYMENT"),
      v.literal("REVERSE_ALLOCATION"),
    ),
    resourceType: v.string(),
    resourceId: v.string(),
    description: v.string(),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    idempotencyKey: v.optional(v.string()),
    occurredAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_actor", ["orgId", "actorId"])
    .index("by_org_action", ["orgId", "actionType"])
    .index("by_org_action_idempotency", ["orgId", "actionType", "idempotencyKey"])
    .index("by_org_time", ["orgId", "occurredAt"]),

  roles: defineTable({
    orgId: v.id("organizations"), // Roles are scoped to orgs allowing custom roles
    name: v.string(), // "OWNER", "SALES", etc.
    permissions: v.array(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  }).index("by_org", ["orgId"]),

  memberships: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    roleId: v.id("roles"),
    branchId: v.optional(v.id("branches")),
    commissionRate: v.optional(v.number()), // % of gross profit per sale
    impersonationGrantId: v.optional(v.id("impersonationGrants")), // set when this membership exists only for an active super-admin impersonation session
    // "Last seen" timestamp for the Team > Members presence indicator. Written
    // by memberships.touchLastSeen, throttled client-side (PresenceTracker)
    // and server-side to a few writes per user per hour — deliberately NOT a
    // live heartbeat/interval, to avoid repeating the liveChatPresence cost
    // (see convex/schema.ts liveChatPresence comment) on a much lower-value feature.
    lastSeenAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_org", ["orgId"])
    .index("by_org_user", ["orgId", "userId"]),

  invitations: defineTable({
    orgId: v.id("organizations"),
    email: v.string(),
    roleId: v.id("roles"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_email", ["email"]),

  vehicles: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    vin: v.string(),
    make: v.string(),
    model: v.string(),

    year: v.number(),
    trim: v.optional(v.string()),
    mileage: v.number(),
    color: v.string(),
    fuelType: v.string(),
    transmission: v.string(),
    purchasePrice: v.optional(v.number()), // Might be hidden from salespeople
    landedCostTotal: v.optional(v.number()),
    minimumProfit: v.optional(v.number()), // Preset minimum profit required
    sellingPrice: v.number(),
    status: v.union(
      v.literal("AVAILABLE"),
      v.literal("RESERVED"),
      v.literal("SOLD"),
      v.literal("IN_INSPECTION"),
      v.literal("IN_REPAIR"),
      v.literal("ARCHIVED")
    ),
    notes: v.optional(v.string()),
    imageIds: v.optional(v.array(v.id("_storage"))),
    createdAt: v.optional(v.number()),
    addedBy: v.optional(v.id("users")),
    updatedBy: v.optional(v.id("users")),
    updatedAt: v.optional(v.number()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_vin", ["orgId", "vin"])
    .searchIndex("search_make", { searchField: "make", filterFields: ["orgId", "isDeleted"] })
    .searchIndex("search_vin", { searchField: "vin", filterFields: ["orgId", "isDeleted"] }),

  vehicleLandedCosts: defineTable({
    vehicleId: v.id("vehicles"),
    orgId: v.id("organizations"),
    items: v.array(v.object({
      label: v.string(),
      amount: v.number(),
    })),
    total: v.number(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }).index("by_org_vehicle", ["orgId", "vehicleId"]),

  vehiclePriceHistory: defineTable({
    vehicleId: v.id("vehicles"),
    orgId: v.id("organizations"),
    oldPrice: v.number(),
    newPrice: v.number(),
    changedBy: v.id("users"),
    changedAt: v.number(),
  }).index("by_org_vehicle", ["orgId", "vehicleId"]),

  vehicleReservations: defineTable({
    vehicleId: v.id("vehicles"),
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    depositAmount: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    status: v.union(v.literal("ACTIVE"), v.literal("RELEASED"), v.literal("CONVERTED")),
    reservedBy: v.id("users"),
    reservedAt: v.number(),
    releasedAt: v.optional(v.number()),
    releasedBy: v.optional(v.id("users")),
  })
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_status", ["orgId", "status"]),

  vehicleStatusRequests: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    requestedBy: v.id("users"),
    requestedStatus: v.union(
      v.literal("AVAILABLE"),
      v.literal("RESERVED"),
      v.literal("SOLD"),
      v.literal("IN_INSPECTION"),
      v.literal("IN_REPAIR"),
      v.literal("ARCHIVED")
    ),
    notes: v.optional(v.string()),
    status: v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED")),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_vehicle", ["vehicleId"]),

  vehicleEdits: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")), // Null means it's a creation request
    requestedBy: v.id("users"),
    type: v.union(v.literal("CREATE"), v.literal("UPDATE")),
    payload: v.object({
      vin: v.optional(v.string()),
      make: v.optional(v.string()),
      model: v.optional(v.string()),
      year: v.optional(v.number()),
      trim: v.optional(v.string()),
      mileage: v.optional(v.number()),
      color: v.optional(v.string()),
      fuelType: v.optional(v.string()),
      transmission: v.optional(v.string()),
      purchasePrice: v.optional(v.number()),
      minimumProfit: v.optional(v.number()),
      sellingPrice: v.optional(v.number()),
      status: v.optional(v.string()),
      notes: v.optional(v.string()),
      imageIds: v.optional(v.array(v.id("_storage"))),
    }), // The partial vehicle data
    status: v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED")),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"]),

  customers: defineTable({
    orgId: v.id("organizations"),
    firstName: v.string(),
    lastName: v.string(),
    phone: v.optional(v.string()),
    whatsapp: v.optional(v.string()),
    instagramUserId: v.optional(v.string()),
    facebookUserId: v.optional(v.string()),
    email: v.optional(v.string()),
    nationalId: v.optional(v.string()),
    address: v.optional(v.string()),
    employment: v.optional(
      v.object({
        employer: v.string(),
        title: v.optional(v.string()),
        salary: v.number(),
        hireDate: v.optional(v.number()),
      })
    ),
    financials: v.optional(
      v.object({
        totalMonthlyDebt: v.number(),
        dbr: v.optional(v.number()), // Debt Burden Ratio
      })
    ),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_email", ["orgId", "email"])
    .index("by_org_phone", ["orgId", "phone"])
    .searchIndex("search_firstName", { searchField: "firstName", filterFields: ["orgId", "isDeleted"] })
    .searchIndex("search_lastName", { searchField: "lastName", filterFields: ["orgId", "isDeleted"] }),

  customerMerges: defineTable({
    orgId: v.id("organizations"),
    survivorId: v.id("customers"),
    loserId: v.id("customers"),
    mergedBy: v.id("users"),
    mergedAt: v.number(),
    reassignedCounts: v.record(v.string(), v.number()),
  }).index("by_org", ["orgId"]),

  leads: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    customerId: v.id("customers"),
    assignedUserId: v.optional(v.id("users")),
    vehicleId: v.optional(v.id("vehicles")),
    source: v.string(),
    stage: v.union(
      v.literal("NEW"),
      v.literal("CONTACTED"),
      v.literal("INTERESTED"),
      v.literal("TEST_DRIVE"),
      v.literal("NEGOTIATION"),
      v.literal("RESERVED"),
      v.literal("WON"),
      v.literal("LOST")
    ),
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_stage", ["orgId", "stage"])
    .index("by_org_assigned", ["orgId", "assignedUserId"])
    .index("by_org_customer", ["orgId", "customerId"]),

  sales: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    salespersonId: v.id("users"),
    salePrice: v.number(),
    saleDate: v.number(), // timestamp
    status: v.union(v.literal("PENDING"), v.literal("COMPLETED"), v.literal("CANCELLED")),
    idempotencyKey: v.optional(v.string()),

    // Deal Structuring Fields
    taxRate: v.optional(v.number()),
    taxAmount: v.optional(v.number()),
    dealerFees: v.optional(v.number()),
    downPayment: v.optional(v.number()),
    tradeInVehicleId: v.optional(v.id("vehicles")),
    tradeInValue: v.optional(v.number()),
    financingType: v.optional(v.union(v.literal("CASH"), v.literal("FINANCED"), v.literal("LEASE"))),
    loanAmount: v.optional(v.number()),
    apr: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    warrantySold: v.optional(v.number()),
    gapSold: v.optional(v.number()),
    applicationId: v.optional(v.id("financeApplications")),
    quoteId: v.optional(v.id("quotes")),
    leadId: v.optional(v.id("leads")),
    commissionAmount: v.optional(v.number()), // Calculated at sale time
    commissionPaidAt: v.optional(v.number()),
    commissionPaidBy: v.optional(v.id("users")),
    commissionPaymentIdempotencyKey: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_salesperson", ["orgId", "salespersonId"])
    .index("by_org_saleDate", ["orgId", "saleDate"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_quote", ["quoteId"])
    .index("by_lead", ["leadId"]),

  expenses: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    vehicleId: v.optional(v.id("vehicles")), // Optional because there might be general expenses
    title: v.string(), // e.g., "Brake replacement", "Detailing", "Office supplies"
    amount: v.number(),
    date: v.number(),
    category: v.union(
      v.literal("REPAIR"),
      v.literal("MAINTENANCE"),
      v.literal("DETAILING"),
      v.literal("TRANSPORT"),
      v.literal("MARKETING"),
      v.literal("OFFICE"),
      v.literal("SALARIES"),
      v.literal("RENT"),
      v.literal("UTILITIES"),
      v.literal("FEES"),
      v.literal("PREPAID"),
      v.literal("OTHER")
    ),
    isPrepaid: v.optional(v.boolean()),
    amortizationMonths: v.optional(v.number()),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("PAID"))),
    idempotencyKey: v.optional(v.string()),
    vendor: v.optional(v.string()),
    payerId: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_date", ["orgId", "date"]),

  tasks: defineTable({
    orgId: v.id("organizations"),
    assignedTo: v.id("users"), // The salesperson or employee responsible
    title: v.string(),
    description: v.optional(v.string()),
    dueDate: v.number(), // Timestamp for the deadline/schedule
    status: v.union(v.literal("PENDING"), v.literal("COMPLETED"), v.literal("CANCELLED")),
    priority: v.optional(v.union(v.literal("HIGH"), v.literal("MEDIUM"), v.literal("LOW"))),
    statusNote: v.optional(v.string()), // Notes when cancelled or rescheduled
    communicationMethod: v.optional(v.union(v.literal("PHONE"), v.literal("EMAIL"), v.literal("FAX"))),
    alarmTriggered: v.optional(v.boolean()), // Track if the cron has sent the notification
    // Optional associations
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    vehicleId: v.optional(v.id("vehicles")),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_assignedTo", ["orgId", "assignedTo"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_status_alarm", ["status", "alarmTriggered"])
    .index("by_org_customer", ["orgId", "customerId"]),

  taskHistory: defineTable({
    orgId: v.id("organizations"),
    taskId: v.id("tasks"),
    userId: v.id("users"),
    action: v.union(
      v.literal("CREATE"),
      v.literal("UPDATE"),
      v.literal("RESCHEDULE"),
      v.literal("CANCEL"),
      v.literal("STATUS_CHANGE")
    ),
    details: v.string(),
    note: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_task", ["taskId"]),

  notifications: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    // Legacy plain-text fields — kept for old rows and for admin-authored
    // broadcasts (type: "system.announcement"), which skip the registry
    // since a super admin types free-form text rather than picking a key.
    title: v.optional(v.string()),
    message: v.optional(v.string()),
    // New typed path: a key into lib/notifications/types.ts, rendered
    // bilingually via lib/notifications/render.ts using `data`.
    type: v.optional(v.string()),
    category: v.optional(v.string()),
    priority: v.optional(
      v.union(v.literal("urgent"), v.literal("normal"), v.literal("low"))
    ),
    data: v.optional(v.any()),
    isRead: v.boolean(),
    isArchived: v.optional(v.boolean()),
    archivedAt: v.optional(v.number()),
    link: v.optional(v.string()), // Optional URL to navigate to when clicked
    relatedTaskId: v.optional(v.id("tasks")),
  })
    .index("by_user", ["userId"])
    .index("by_org_user", ["orgId", "userId"])
    // Unread badge/count without a full-table filter scan.
    .index("by_org_user_read", ["orgId", "userId", "isRead"])
    .index("by_org_user_category", ["orgId", "userId", "category"]),

  notificationPreferences: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    category: v.string(),
    emailEnabled: v.boolean(),
    whatsappEnabled: v.boolean(),
  }).index("by_org_user_category", ["orgId", "userId", "category"]),

  notificationBroadcasts: defineTable({
    orgId: v.optional(v.id("organizations")), // omitted = platform-wide
    title: v.string(),
    message: v.string(),
    link: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    recipientCount: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  test_drives: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    salespersonId: v.id("users"),
    startTime: v.number(),
    endTime: v.optional(v.number()),
    demoPlateNumber: v.optional(v.string()),
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_customer", ["orgId", "customerId"]),

  workOrders: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    status: v.union(v.literal("OPEN"), v.literal("IN_PROGRESS"), v.literal("COMPLETED")),
    title: v.string(),
    totalCost: v.number(),
    tasks: v.array(
      v.object({
        id: v.string(),
        description: v.string(),
        partsCost: v.number(),
        laborCost: v.number(),
        mechanicName: v.optional(v.string()),
        completed: v.boolean(),
      })
    ),
    expenseId: v.optional(v.id("expenses")),
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"]),

  financeCompanies: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    profitRate: v.number(), // e.g. 5.5 for 5.5%
    maxTermMonths: v.number(), // e.g. 72
    gracePeriodMonths: v.number(), // e.g. 3
    insuranceRate: v.optional(v.number()), // e.g. 3.5 for 3.5%
    adminFees: v.optional(v.number()), // Processing Fees
    commission: v.optional(v.number()), // Commission
    includesCommissionInDebt: v.optional(v.boolean()),
    maxFinancingLTV: v.optional(v.number()), // e.g. 85 for 85% Loan-to-Value
    isActive: v.boolean(),
    acceptedStatuses: v.optional(v.array(v.id("orgCustomerStatuses"))), // undefined/empty = accepts all
    deactivatedAt: v.optional(v.number()),
    deactivatedBy: v.optional(v.id("users")),
  }).index("by_org", ["orgId"]),

  vehicleValuations: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    companyId: v.id("financeCompanies"),
    valuationAmount: v.number(),
    expiresAt: v.optional(v.number()), // timestamp
  })
    .index("by_org", ["orgId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_company", ["companyId"]),

  guarantors: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    firstName: v.string(),
    lastName: v.string(),
    nationalId: v.string(),
    phone: v.string(),
    relationship: v.optional(v.string()),
    income: v.optional(v.number()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_customer", ["customerId"]),

  quotes: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.id("vehicles"),
    companyId: v.optional(v.id("financeCompanies")), // Null if cash deal
    leadId: v.optional(v.id("leads")), // Set when the quote was generated from a lead's context

    // Core parameters
    vehiclePrice: v.number(),
    downPayment: v.number(),
    termMonths: v.number(),

    // Financing Engine output
    totalFinancedAmount: v.optional(v.number()), // Principal + Insurance + Fees
    monthlyInstallment: v.optional(v.number()),
    profitRateApplied: v.optional(v.number()),
    totalProfit: v.optional(v.number()),

    recipientName: v.optional(v.string()), // Who the quote is addressed to (e.g. a financing company, for installment deals)

    status: v.union(v.literal("DRAFT"), v.literal("SHARED"), v.literal("ACCEPTED"), v.literal("EXPIRED")),
    expiresAt: v.optional(v.number()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_customer", ["customerId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_status", ["status"])
    .index("by_lead", ["leadId"]),

  applicationStatusLog: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    fromStatus: v.optional(v.string()),
    toStatus: v.string(),
    changedBy: v.id("users"),
    changedAt: v.number(),
    note: v.optional(v.string()),
  })
    .index("by_application", ["applicationId"])
    .index("by_org", ["orgId"]),

  financeApplications: defineTable({
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    customerId: v.id("customers"),
    vehicleId: v.id("vehicles"),
    companyId: v.optional(v.id("financeCompanies")),
    salespersonId: v.id("users"),

    status: v.union(
      v.literal("DRAFT"),
      v.literal("PENDING_DOCS"),
      v.literal("UNDER_REVIEW"),
      v.literal("APPROVED"),
      v.literal("REJECTED"),
      v.literal("CLOSED")
    ),

    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    finalizedSaleId: v.optional(v.id("sales")),
    finalizationIdempotencyKey: v.optional(v.string()),
    disbursedAt: v.optional(v.number()),
    disbursedAmountMinor: v.optional(v.number()),
    disbursementIdempotencyKey: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_customer", ["customerId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_status", ["status"])
    .index("by_org_status", ["orgId", "status"]),

  deposits: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    quoteId: v.id("quotes"),
    amount: v.number(),
    status: v.union(
      v.literal("HELD"),
      v.literal("APPLIED"),
      v.literal("REFUNDED"),
      v.literal("FORFEITED")
    ),
    // Whether this deposit is currently contributing to the vehicle's RESERVED
    // hold. Kept separate from `status` so a rejected application can release
    // the vehicle immediately while the deposit itself stays HELD pending a
    // manager's manual refund/forfeit decision.
    holdActive: v.boolean(),
    idempotencyKey: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_quote", ["quoteId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_vehicle_hold", ["vehicleId", "holdActive"]),

  receivables: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    saleId: v.optional(v.id("sales")),
    quoteId: v.optional(v.id("quotes")),
    applicationId: v.optional(v.id("financeApplications")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    sourceType: v.union(
      v.literal("CUSTOMER_DEPOSIT"),
      v.literal("RESERVATION_PAYMENT"),
      v.literal("INTERNAL_INSTALLMENT"),
      v.literal("BANK_FINANCED_BALANCE"),
      v.literal("BANK_TRANSFER"),
      v.literal("PAYMENT_LINK"),
      v.literal("CHEQUE"),
      v.literal("OTHER")
    ),
    title: v.string(),
    originalAmount: v.number(),
    outstandingAmount: v.number(),
    dueDate: v.number(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("PARTIALLY_PAID"),
      v.literal("PAID"),
      v.literal("OVERDUE"),
      v.literal("RESCHEDULED"),
      v.literal("CANCELLED"),
      v.literal("REFUNDED")
    ),
    installmentNumber: v.optional(v.number()),
    totalInstallments: v.optional(v.number()),
    paymentPlanLabel: v.optional(v.string()),
    assignedTo: v.optional(v.id("users")),
    lastReminderAt: v.optional(v.number()),
    lastPaymentAt: v.optional(v.number()),
    notes: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_status_and_dueDate", ["orgId", "status", "dueDate"])
    .index("by_org_dueDate", ["orgId", "dueDate"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_sale", ["saleId"])
    .index("by_quote", ["quoteId"])
    .index("by_application", ["applicationId"])
    .index("by_assignedTo", ["assignedTo"]),

  collectionPayments: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    chequeId: v.optional(v.id("postDatedCheques")),
    reconciliationId: v.optional(v.id("cashierReconciliations")),
    direction: v.union(v.literal("IN"), v.literal("OUT")),
    method: v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("CHEQUE"),
      v.literal("PAYMENT_LINK"),
      v.literal("CARD"),
      v.literal("DEPOSIT_APPLIED"),
      v.literal("REFUND"),
      v.literal("OTHER")
    ),
    amount: v.number(),
    paymentDate: v.number(),
    status: v.union(
      v.literal("POSTED"),
      v.literal("PENDING_CLEARANCE"),
      v.literal("VOIDED")
    ),
    idempotencyKey: v.optional(v.string()),
    reference: v.optional(v.string()),
    cashierId: v.id("users"),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    voidedAt: v.optional(v.number()),
    voidedBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_paymentDate", ["orgId", "paymentDate"])
    .index("by_receivable", ["receivableId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_cashier", ["orgId", "cashierId"])
    .index("by_reconciliation", ["reconciliationId"])
    .index("by_cheque", ["chequeId"]),

  postDatedCheques: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    bank: v.string(),
    chequeNumber: v.string(),
    chequeDate: v.number(),
    amount: v.number(),
    depositedDate: v.optional(v.number()),
    status: v.union(
      v.literal("HELD"),
      v.literal("DEPOSITED"),
      v.literal("CLEARED"),
      v.literal("RETURNED"),
      v.literal("REPLACED"),
      v.literal("CANCELLED")
    ),
    replacementChequeId: v.optional(v.id("postDatedCheques")),
    returnedAt: v.optional(v.number()),
    returnReason: v.optional(v.string()),
    clearedAt: v.optional(v.number()),
    returnedAfterClearing: v.optional(v.boolean()),
    bankFeeMinor: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_status_and_chequeDate", ["orgId", "status", "chequeDate"])
    .index("by_org_chequeDate", ["orgId", "chequeDate"])
    .index("by_org_bank_and_chequeNumber", ["orgId", "bank", "chequeNumber"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_receivable", ["receivableId"])
    .index("by_replacementCheque", ["replacementChequeId"]),

  cashierReconciliations: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    cashierId: v.id("users"),
    businessDate: v.number(),
    expectedCash: v.number(),
    countedCash: v.number(),
    difference: v.number(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("SUBMITTED"),
      v.literal("APPROVED"),
      v.literal("REJECTED")
    ),
    idempotencyKey: v.optional(v.string()),
    notes: v.optional(v.string()),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_businessDate", ["orgId", "businessDate"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_cashier", ["orgId", "cashierId"]),

  collectionApprovalRequests: defineTable({
    orgId: v.id("organizations"),
    receivableId: v.id("receivables"),
    customerId: v.id("customers"),
    requestedBy: v.id("users"),
    requestType: v.union(
      v.literal("REFUND"),
      v.literal("RESCHEDULE"),
      v.literal("CANCEL_RECEIVABLE")
    ),
    status: v.union(
      v.literal("PENDING"),
      v.literal("APPROVED"),
      v.literal("REJECTED")
    ),
    requestedAmount: v.optional(v.number()),
    requestedDueDate: v.optional(v.number()),
    reason: v.string(),
    decisionNotes: v.optional(v.string()),
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    responseIdempotencyKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_receivable", ["receivableId"])
    .index("by_requestedBy", ["requestedBy"]),

  collectionReminders: defineTable({
    orgId: v.id("organizations"),
    receivableId: v.optional(v.id("receivables")),
    chequeId: v.optional(v.id("postDatedCheques")),
    customerId: v.id("customers"),
    channel: v.union(
      v.literal("WHATSAPP"),
      v.literal("SMS"),
      v.literal("EMAIL"),
      v.literal("MANUAL")
    ),
    messageType: v.union(
      v.literal("DUE_SOON"),
      v.literal("OVERDUE"),
      v.literal("CHEQUE_UPCOMING"),
      v.literal("CHEQUE_RETURNED")
    ),
    status: v.union(
      v.literal("PENDING"),
      v.literal("SENT"),
      v.literal("FAILED"),
      v.literal("SKIPPED")
    ),
    scheduledAt: v.number(),
    sentAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status_and_scheduledAt", ["orgId", "status", "scheduledAt"])
    .index("by_receivable", ["receivableId"])
    .index("by_cheque", ["chequeId"])
    .index("by_org_customer", ["orgId", "customerId"]),

  companyDocumentRules: defineTable({
    orgId: v.id("organizations"),
    companyId: v.optional(v.id("financeCompanies")), // Null means required for ALL deals (e.g., ID)
    documentName: v.string(), // e.g., "Salary Certificate"
    isRequired: v.boolean(),
    description: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_company", ["companyId"]),

  applicationDocuments: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    ruleId: v.id("companyDocumentRules"),
    fileId: v.optional(v.id("_storage")),
    status: v.union(
      v.literal("MISSING"),
      v.literal("UPLOADED"),
      v.literal("VERIFIED"),
      v.literal("REJECTED")
    ),
    rejectionReason: v.optional(v.string()),
    uploadedAt: v.optional(v.number()),
    verifiedBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_application", ["applicationId"])
    .index("by_rule", ["ruleId"]),

  branches: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    managerId: v.optional(v.id("users")),
    isActive: v.boolean(),
  })
    .index("by_org", ["orgId"]),

  transactions: defineTable({
    orgId: v.id("organizations"),
    type: v.union(v.literal("IN"), v.literal("OUT")),
    amount: v.number(),
    date: v.number(), // Timestamp
    category: v.union(
      v.literal("VEHICLE_SALE"), v.literal("VEHICLE_PURCHASE"),
      v.literal("EXPENSE"), v.literal("DEPOSIT"),
      v.literal("COLLECTION_PAYMENT"), v.literal("REFUND"),
      v.literal("PARTNER_DRAW"), v.literal("CAPITAL_INJECTION"),
      v.literal("CLAIM_PAYMENT"), v.literal("OTHER")
    ),
    description: v.string(), // "البيان"
    idempotencyKey: v.optional(v.string()),
    // Optional links to operational entities
    vehicleId: v.optional(v.id("vehicles")),
    userId: v.optional(v.id("users")), // For partner draws/salaries
    expenseId: v.optional(v.id("expenses")),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_date", ["orgId", "date"])
    .index("by_org_vehicle", ["orgId", "vehicleId"]),

  fixedAssets: defineTable({
    orgId: v.id("organizations"),
    name: v.string(), // e.g., "أثاث مكتب"
    purchaseValue: v.number(),
    purchaseDate: v.number(), // Timestamp
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"]),

  partnerEquity: defineTable({
    orgId: v.id("organizations"),
    partnerName: v.string(), // e.g., "علاء جراد"
    userId: v.optional(v.id("users")),
    initialCapital: v.number(),
    currentBalance: v.number(), // Automatically calculated: Capital - Draws + Profit Share
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"]),

  claims: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    financingEntity: v.string(), // "جهة التمويل"
    buyerName: v.string(), // "اسم المشتري"
    claimAmount: v.number(), // "المطالبة"
    status: v.union(v.literal("PENDING"), v.literal("PAID"), v.literal("REJECTED"), v.literal("CANCELLED")),
    claimDate: v.number(),
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_status", ["orgId", "status"]),

  wizardDrafts: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    paymentType: v.string(),
    currentStep: v.number(),
    wizardData: v.object({
      vehicleId: v.string(),
      vehiclePrice: v.number(),
      desiredProfit: v.number(),
      downPayment: v.number(),
      termMonths: v.number(),
      selectedCompanyId: v.optional(v.string()),
      manualProfitRate: v.optional(v.number()),
      manualInsuranceRate: v.optional(v.number()),
      manualExecutionCommission: v.optional(v.number()),
      manualExecutionFees: v.optional(v.number()),
      manualIncludesCommissionInDebt: v.optional(v.boolean()),
      recipientName: v.optional(v.string()),
    }),
    selectedCustomerId: v.optional(v.string()),
    savedAt: v.number(),
  })
    .index("by_org_user", ["orgId", "userId"]),

  orgSettings: defineTable({
    orgId: v.id("organizations"),
    currency: v.string(),
    currencySymbol: v.string(),
    vatRate: v.optional(v.number()),
    country: v.optional(v.string()),
    timezone: v.optional(v.string()),
    enabledPaymentTypes: v.array(v.string()),
    logoStorageId: v.optional(v.id("_storage")),
    primaryColor: v.optional(v.string()),
    dealershipName: v.optional(v.string()),
    dealershipAddress: v.optional(v.string()),
    dealershipPhone: v.optional(v.string()),
    whatsappPhoneNumberId: v.optional(v.string()),
    whatsappApiToken: v.optional(v.string()),
    whatsappWebhookSecret: v.optional(v.string()),
    approvalThresholdEnabled: v.optional(v.boolean()),
    approvalMinProfitPercent: v.optional(v.number()),
    commissionTiers: v.optional(
      v.array(v.object({ minProfitAmount: v.number(), commissionPct: v.number() }))
    ),
    commissionMode: v.optional(v.union(v.literal("AUTO_TIERS"), v.literal("AUTO_MEMBER"), v.literal("MANUAL"))),
    instagramBusinessAccountId: v.optional(v.string()),
    // The IG profile's "user_id" field — distinct from instagramBusinessAccountId
    // (the OAuth-returned "id"). Meta uses *this* ID in webhook entry[].id;
    // the other one is used for outbound Graph API path calls. Confirmed by
    // direct API probe 2026-06-22 — not documented anywhere obvious.
    instagramWebhookAccountId: v.optional(v.string()),
    instagramAccessToken: v.optional(v.string()),
    instagramTokenExpiresAt: v.optional(v.number()),
    instagramPageName: v.optional(v.string()),
    socialAutoPostEnabled: v.optional(v.boolean()),
    instagramAutoReplyEnabled: v.optional(v.boolean()),
    instagramAutoReplyMessages: v.optional(v.array(v.string())),
    instagramAutoReplyMobileReceivedMessage: v.optional(v.string()),
    instagramAutoReplyLastIndex: v.optional(v.number()),
    // Whether an inbound comment/DM creates a CRM lead. Undefined is treated
    // as true (preserves pre-toggle behavior for orgs that connected before
    // this setting existed) — the interaction is always captured in the
    // Social Inbox and still gets auto-replied to either way; this only
    // gates whether it also produces a Lead in the pipeline + notification.
    instagramLeadFromCommentsEnabled: v.optional(v.boolean()),
    instagramLeadFromDmsEnabled: v.optional(v.boolean()),
    instagramLeadFromDmsRequiresMobile: v.optional(v.boolean()),
    facebookPageId: v.optional(v.string()),
    facebookPageAccessToken: v.optional(v.string()),
    facebookPageName: v.optional(v.string()),
    // The Facebook user ID of whoever connected the Page (from GET /me
    // during token exchange) — distinct from facebookPageId. Needed because
    // Meta's deauthorize/data-deletion signed_request payloads only carry
    // the connecting user's ID, not the Page ID, so this is the only way to
    // resolve which org's connection to clear from those callbacks.
    facebookConnectedByUserId: v.optional(v.string()),
    // Page tokens derived from a long-lived user token typically don't
    // expire, but kept optional/nullable for parity with Instagram and in
    // case Meta changes that behavior.
    facebookTokenExpiresAt: v.optional(v.number()),
    facebookAutoReplyEnabled: v.optional(v.boolean()),
    facebookAutoReplyMessages: v.optional(v.array(v.string())),
    facebookAutoReplyMobileReceivedMessage: v.optional(v.string()),
    facebookAutoReplyLastIndex: v.optional(v.number()),
    facebookLeadFromCommentsEnabled: v.optional(v.boolean()),
    facebookLeadFromDmsEnabled: v.optional(v.boolean()),
    facebookLeadFromDmsRequiresMobile: v.optional(v.boolean()),
    generatedLeadAutoAssignmentEnabled: v.optional(v.boolean()),
    // Smart Reply: rule-based price/financing/availability/vehicleInfo/location
    // auto-answers, distinct from the canned round-robin auto-reply above --
    // requires a vehicleId match (except location/greeting) and only fires for
    // keyword-matched questions. Off by default for all orgs.
    instagramSmartReplyEnabled: v.optional(v.boolean()),
    facebookSmartReplyEnabled: v.optional(v.boolean()),
    // "calculated": compute a "starting from X/month" figure via
    // calculateUnifiedMurabaha using smartReplyDefaultFinanceCompanyId + that
    // company's own maxTermMonths + smartReplyDefaultDownPaymentPercent.
    // "generic": static financing copy, no computed number. Default when unset: generic.
    smartReplyFinancingMode: v.optional(v.union(v.literal("calculated"), v.literal("generic"))),
    smartReplyDefaultDownPaymentPercent: v.optional(v.number()), // e.g. 20 for 20%
    smartReplyDefaultFinanceCompanyId: v.optional(v.id("financeCompanies")),
    // "public": comment-triggered smart replies post publicly under the comment
    // (current canned-reply behavior). "dm": sent privately via DM instead.
    // Shared across both platforms. Default when unset: public.
    smartReplyVisibility: v.optional(v.union(v.literal("public"), v.literal("dm"))),
    // Fallback language for a reply when the inbound text has no detectable
    // script (emoji-only, numeric-only, etc). Default when unset: "en".
    smartReplyDefaultLocale: v.optional(v.union(v.literal("en"), v.literal("ar"))),
    // Granular canned-reply toggles. When set, these override the platform-level
    // facebookAutoReplyEnabled / instagramAutoReplyEnabled for the given kind.
    // Undefined = fall back to the platform-level flag (backward-compatible).
    facebookAutoReplyForDmsEnabled: v.optional(v.boolean()),
    facebookAutoReplyForCommentsEnabled: v.optional(v.boolean()),
    instagramAutoReplyForDmsEnabled: v.optional(v.boolean()),
    instagramAutoReplyForCommentsEnabled: v.optional(v.boolean()),
    // Per-kind smart-reply toggles (same backward-compat pattern).
    facebookSmartReplyForDmsEnabled: v.optional(v.boolean()),
    facebookSmartReplyForCommentsEnabled: v.optional(v.boolean()),
    instagramSmartReplyForDmsEnabled: v.optional(v.boolean()),
    instagramSmartReplyForCommentsEnabled: v.optional(v.boolean()),
    // Custom Smart Reply response templates as JSON strings keyed by intent.
    // Supported keys (same {placeholder} tokens as the built-in defaults):
    //   greeting, location, locationFallback, priceAvailable, financingGeneric,
    //   financingCalculated, availableYes, availableSold, availableUnclear, vehicleInfo
    // Undefined = use the built-in copy from socialSmartReplyEn / socialSmartReplyAr.
    smartReplyCustomTemplatesEn: v.optional(v.string()),
    smartReplyCustomTemplatesAr: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_instagram_business_account_id", ["instagramBusinessAccountId"])
    .index("by_instagram_webhook_account_id", ["instagramWebhookAccountId"])
    .index("by_facebook_page_id", ["facebookPageId"])
    .index("by_facebook_connected_user_id", ["facebookConnectedByUserId"]),

  leadAssignmentCursors: defineTable({
    orgId: v.id("organizations"),
    lastAssignedUserId: v.optional(v.id("users")),
    updatedAt: v.number(),
  }).index("by_org", ["orgId"]),

  websiteSettings: defineTable({
    orgId: v.id("organizations"),
    enabled: v.boolean(),
    status: v.union(
      v.literal("disabled"),
      v.literal("draft"),
      v.literal("active"),
      v.literal("suspended")
    ),
    defaultSubdomain: v.optional(v.string()),
    activeDomainId: v.optional(v.id("websiteDomains")),
    templateId: v.string(),
    defaultLanguage: v.union(v.literal("en"), v.literal("ar")),
    supportedLanguages: v.array(v.union(v.literal("en"), v.literal("ar"))),
    primaryColor: v.optional(v.string()),
    secondaryColor: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
    heroTitle: v.optional(v.string()),
    heroSubtitle: v.optional(v.string()),
    slogan: v.optional(v.string()),
    themeConfig: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
    publishedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"]),

  websiteDomains: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    domain: v.string(),
    type: v.union(
      v.literal("platform_subdomain"),
      v.literal("purchased_custom_domain"),
      v.literal("external_custom_domain")
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("active"),
      v.literal("failed"),
      v.literal("suspended")
    ),
    isPrimary: v.boolean(),
    registrarProvider: v.optional(v.string()),
    registrarDomainId: v.optional(v.string()),
    dnsStatus: v.union(v.literal("pending"), v.literal("configured"), v.literal("failed")),
    sslStatus: v.union(v.literal("pending"), v.literal("active"), v.literal("failed")),
    registrationExpiresAt: v.optional(v.number()),
    autoRenew: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_domain", ["domain"])
    .index("by_org_primary", ["orgId", "isPrimary"]),

  websitePublishedSections: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    sectionKey: v.string(),
    enabled: v.boolean(),
    configJson: v.optional(v.any()),
  })
    .index("by_org", ["orgId"])
    .index("by_settings", ["websiteSettingsId"])
    .index("by_org_settings_section", ["orgId", "websiteSettingsId", "sectionKey"]),

  websiteLeadRouting: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    formType: v.string(),
    routeToUserId: v.optional(v.id("users")),
    routeToRole: v.optional(v.string()),
    routeToBranchId: v.optional(v.id("branches")),
    createTask: v.boolean(),
    notifyByEmail: v.boolean(),
    notifyByWhatsApp: v.boolean(),
    configJson: v.optional(v.any()),
  })
    .index("by_settings", ["websiteSettingsId"])
    .index("by_org_settings_form", ["orgId", "websiteSettingsId", "formType"]),

  websitePublishSnapshots: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    snapshotJson: v.any(),
    createdAt: v.number(),
    publishedByUserId: v.id("users"),
  })
    .index("by_org", ["orgId"])
    .index("by_settings", ["websiteSettingsId"]),

  domainSearchLogs: defineTable({
    orgId: v.id("organizations"),
    query: v.string(),
    available: v.boolean(),
    price: v.optional(v.number()),
    provider: v.string(),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_createdAt", ["orgId", "createdAt"]),

  oauthStates: defineTable({
    orgId: v.id("organizations"),
    state: v.string(),
    provider: v.union(v.literal("instagram"), v.literal("facebook")),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index("by_state", ["state"]),

  instagramEvents: defineTable({
    orgId: v.id("organizations"),
    externalId: v.string(),
    kind: v.union(v.literal("comment"), v.literal("dm")),
    senderInstagramId: v.string(),
    senderUsername: v.optional(v.string()),
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    vehicleId: v.optional(v.id("vehicles")),
    text: v.optional(v.string()),
    postId: v.optional(v.string()),
    vehicleMatchHintText: v.optional(v.string()),
    vehicleMatchHintSource: v.optional(v.union(v.literal("message"), v.literal("post"))),
    autoRepliedAt: v.optional(v.number()),
    autoReplyText: v.optional(v.string()),
    autoReplySource: v.optional(v.union(v.literal("smart"), v.literal("canned"))),
    manualReplyText: v.optional(v.string()),
    manualRepliedAt: v.optional(v.number()),
    manualRepliedByUserId: v.optional(v.id("users")),
  })
    .index("by_org_external", ["orgId", "externalId"])
    .index("by_org_sender", ["orgId", "senderInstagramId"])
    .index("by_org", ["orgId"])
    .index("by_org_lead", ["orgId", "leadId"])
    .index("by_org_customer", ["orgId", "customerId"]),

  facebookEvents: defineTable({
    orgId: v.id("organizations"),
    externalId: v.string(),
    kind: v.union(v.literal("comment"), v.literal("dm")),
    senderFacebookId: v.string(),
    senderName: v.optional(v.string()),
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    vehicleId: v.optional(v.id("vehicles")),
    text: v.optional(v.string()),
    postId: v.optional(v.string()),
    sourceSurface: v.optional(v.union(v.literal("post"), v.literal("reel"), v.literal("story"), v.literal("ad"), v.literal("unknown"))),
    vehicleMatchHintText: v.optional(v.string()),
    vehicleMatchHintSource: v.optional(v.union(v.literal("message"), v.literal("post"))),
    autoRepliedAt: v.optional(v.number()),
    autoReplyText: v.optional(v.string()),
    autoReplySource: v.optional(v.union(v.literal("smart"), v.literal("canned"))),
    manualReplyText: v.optional(v.string()),
    manualRepliedAt: v.optional(v.number()),
    manualRepliedByUserId: v.optional(v.id("users")),
  })
    .index("by_org_external", ["orgId", "externalId"])
    .index("by_org_sender", ["orgId", "senderFacebookId"])
    .index("by_org", ["orgId"])
    .index("by_org_lead", ["orgId", "leadId"])
    .index("by_org_customer", ["orgId", "customerId"]),

  // Full Messenger thread: one row per message (in or out), enabling complete
  // conversation history including messages sent before AutoFlow existed.
  facebookMessages: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    direction: v.union(v.literal("in"), v.literal("out")),
    text: v.optional(v.string()),
    timestamp: v.number(),
    fbMessageId: v.string(),
    fbConversationId: v.optional(v.string()),
    sentByUserId: v.optional(v.id("users")),
  })
    .index("by_org_customer_ts", ["orgId", "customerId", "timestamp"])
    .index("by_org_fb_message", ["orgId", "fbMessageId"]),

  socialPosts: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    platform: v.union(v.literal("instagram"), v.literal("facebook")),
    status: v.union(v.literal("PENDING"), v.literal("PUBLISHED"), v.literal("FAILED")),
    caption: v.optional(v.string()),
    imageStorageIds: v.array(v.id("_storage")),
    externalPostId: v.optional(v.string()),
    externalPermalink: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    triggeredBy: v.union(v.literal("manual"), v.literal("auto")),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    publishedAt: v.optional(v.number()),
    likeCount: v.optional(v.number()),
    commentsCount: v.optional(v.number()),
    engagementSyncedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_external_post_id", ["externalPostId"]),

  orgCustomFields: defineTable({
    orgId: v.id("organizations"),
    entityType: v.union(v.literal("vehicle"), v.literal("customer"), v.literal("lead")),
    fieldName: v.string(),
    fieldKey: v.string(),
    fieldType: v.union(v.literal("text"), v.literal("number"), v.literal("select"), v.literal("date")),
    isRequired: v.boolean(),
    options: v.optional(v.array(v.string())),
    order: v.number(),
    isActive: v.boolean(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_entity", ["orgId", "entityType"]),

  orgCustomFieldValues: defineTable({
    orgId: v.id("organizations"),
    entityType: v.string(),
    entityId: v.string(),
    fieldId: v.id("orgCustomFields"),
    value: v.string(),
  })
    .index("by_org", ["orgId"])
    .index("by_entity", ["entityType", "entityId"])
    .index("by_entity_field", ["entityId", "fieldId"]),

  orgLeadSources: defineTable({
    orgId: v.id("organizations"),
    label: v.string(),
    isActive: v.boolean(),
    order: v.number(),
  }).index("by_org", ["orgId"]),

  orgValuationCompanies: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    isActive: v.boolean(),
    order: v.number(),
  }).index("by_org", ["orgId"]),

  orgPipelineStages: defineTable({
    orgId: v.id("organizations"),
    stageKey: v.string(), // "NEW" | "CONTACTED" | "INTERESTED" | "TEST_DRIVE" | "NEGOTIATION" | "RESERVED" | "WON" | "LOST"
    label: v.string(), // Custom display label, e.g. "طازج" instead of "New"
    color: v.optional(v.string()), // Hex color, e.g. "#3b82f6"
    order: v.number(),
    isActive: v.boolean(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_key", ["orgId", "stageKey"]),

  orgImportMappings: defineTable({
    orgId: v.id("organizations"),
    entityType: v.union(v.literal("vehicle"), v.literal("customer")),
    mapping: v.array(v.object({
      sourceHeader: v.string(), // normalized header text from the dealer's file
      targetField: v.string(), // schema field key, e.g. "make" / "vin"
    })),
    updatedAt: v.number(),
  }).index("by_org_entity", ["orgId", "entityType"]),

  orgCustomerStatuses: defineTable({
    orgId: v.id("organizations"),
    label: v.string(),
    isActive: v.boolean(),
    order: v.number(),
  }).index("by_org", ["orgId"]),

  profitApprovalRequests: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    requestedProfit: v.number(),
    minimumProfit: v.number(),
    salespersonId: v.id("users"),
    status: v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED")),
    approvedBy: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    // Full wizard state snapshot so salesperson can resume after approval
    wizardSnapshot: v.optional(v.object({
      paymentType: v.string(),
      vehiclePrice: v.number(),
      desiredProfit: v.number(),
      downPayment: v.number(),
      termMonths: v.number(),
      selectedCompanyId: v.optional(v.string()),
      manualProfitRate: v.optional(v.number()),
      manualInsuranceRate: v.optional(v.number()),
    })),
  })
    .index("by_org", ["orgId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_salesperson", ["salespersonId"])
    .index("by_status", ["status"]),

  feedback: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    type: v.union(v.literal("BUG"), v.literal("FEATURE")),
    title: v.string(),
    description: v.optional(v.string()),
    url: v.optional(v.string()),
    status: v.union(v.literal("OPEN"), v.literal("CLOSED")),
    createdAt: v.number(),
    adminReply: v.optional(v.string()),
    adminRepliedAt: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_org_user_type", ["orgId", "userId", "type"])
    .index("by_org_user_status", ["orgId", "userId", "status"])
    .index("by_org_user_type_status", ["orgId", "userId", "type", "status"])
    .index("by_status", ["status"]),

  // ─── Subscription plans ────────────────────────────────────────────────────

  subscriptions: defineTable({
    orgId: v.id("organizations"),
    plan: v.union(
      v.literal("free"),
      v.literal("starter"),
      v.literal("professional"),
      v.literal("enterprise")
    ),
    status: v.union(
      v.literal("active"),     // on free plan or paying subscriber
      v.literal("past_due"),   // payment failed
      v.literal("cancelled"),  // cancelled; access until period end
      v.literal("expired"),    // paid plan lapsed, back to free
    ),
    billingInterval: v.optional(v.union(v.literal("monthly"), v.literal("annual"))),
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    renewalReminderSentAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_status_period_end", ["status", "currentPeriodEnd"]),

  // ─── Super-admin dashboard (cross-tenant, /admin) ──────────────────────────

  adminAuditLog: defineTable({
    actorUserId: v.id("users"),
    actorEmail: v.string(),
    action: v.string(),
    targetTable: v.optional(v.string()),
    targetId: v.optional(v.string()),
    orgId: v.optional(v.id("organizations")),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_org", ["orgId"]),

  cronHeartbeats: defineTable({
    jobName: v.string(),
    ranAt: v.number(),
    success: v.boolean(),
    detail: v.optional(v.string()),
  }).index("by_job", ["jobName"]),

  webhookLogs: defineTable({
    source: v.union(
      v.literal("clerk"),
      v.literal("whatsapp"),
      v.literal("resend"),
      v.literal("instagram-oauth"),
      v.literal("instagram"),
      v.literal("facebook-oauth"),
      v.literal("facebook"),
      v.literal("notification-email"),
      v.literal("notification-whatsapp"),
      v.literal("subscription-reminder"),
      v.literal("support-inbox-notification"),
      v.literal("upgrade-request")
    ),
    status: v.union(v.literal("success"), v.literal("error")),
    summary: v.string(),
    error: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  // ─── Company-level support inboxes (support@ / info@ autoflowdealer.com) ───
  // Not org-scoped — this is the AutoFlow operator's own inbox for talking to
  // subscriber dealerships, separate entirely from any tenant's data.

  supportThreads: defineTable({
    participantEmail: v.string(),
    participantName: v.optional(v.string()),
    subject: v.string(),
    status: v.union(v.literal("OPEN"), v.literal("CLOSED")),
    // Which inbox this thread belongs to — support@ (help), info@ (sales/general),
    // subscriptions@ (billing/plan inquiries).
    inbox: v.union(v.literal("support"), v.literal("info"), v.literal("subscriptions")),
    lastMessageAt: v.number(),
    autoRepliedAt: v.optional(v.number()),
  })
    .index("by_participantEmail_and_inbox", ["participantEmail", "inbox"])
    .index("by_inbox_and_lastMessageAt", ["inbox", "lastMessageAt"])
    .index("by_inbox_and_status", ["inbox", "status"]),

  supportMessages: defineTable({
    threadId: v.id("supportThreads"),
    direction: v.union(v.literal("INBOUND"), v.literal("OUTBOUND")),
    fromEmail: v.string(),
    toEmail: v.string(),
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    resendEmailId: v.optional(v.string()),
    sentByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
  }).index("by_thread", ["threadId"]),

  // ─── Live chat support (in-app, real-time) ─────────────────────────────────
  // Separate from the email support inbox above. Dealers chat from inside the
  // dashboard; a small team of support agents (gated by requireSupportAgent,
  // narrower than requireSuperAdmin) claim threads from a queue and reply live.

  supportAgents: defineTable({
    userId: v.id("users"),
    email: v.string(),
    isActive: v.boolean(),
    isOnline: v.optional(v.boolean()),
    lastHeartbeatAt: v.optional(v.number()),
    lastOfferedAt: v.optional(v.number()), // round-robin fairness for chat routing
    // Richer presence than isOnline: ONLINE accepts new offers, BREAK and
    // OFFLINE don't (isOnline is kept in sync with status === "ONLINE" so
    // existing isOnline-based routing/eligibility checks stay correct).
    status: v.optional(v.union(v.literal("ONLINE"), v.literal("BREAK"), v.literal("OFFLINE"))),
    // Set when the agent asks to go on break/offline while still handling an
    // active chat — excluded from new offers immediately, but the status
    // change itself is deferred until their last active chat closes.
    pendingBreak: v.optional(v.boolean()),
  })
    .index("by_userId", ["userId"])
    .index("by_email", ["email"]),

  liveChatThreads: defineTable({
    // kind is omitted on every pre-existing row, which are all dealer chats —
    // undefined is treated as "DEALER" everywhere this is read.
    kind: v.optional(v.union(v.literal("DEALER"), v.literal("LEAD"))),
    orgId: v.optional(v.id("organizations")), // unset for anonymous LEAD threads
    dealerUserId: v.optional(v.id("users")), // unset for anonymous LEAD threads
    dealerName: v.optional(v.string()), // doubles as the lead's display name for LEAD threads
    // Capability token (random, client-generated, stored in the visitor's
    // localStorage) identifying an anonymous marketing-site lead — there's no
    // authenticated `users` row to key off for these. Only set for LEAD threads.
    leadId: v.optional(v.string()),
    leadEmail: v.optional(v.string()),
    status: v.union(v.literal("WAITING"), v.literal("OFFERED"), v.literal("ACTIVE"), v.literal("CLOSED")),
    // Offer/accept/reject routing — a thread is offered to one agent at a
    // time; rejecting or timing out re-offers to the next eligible agent.
    offeredToUserId: v.optional(v.id("users")),
    offeredAt: v.optional(v.number()),
    offerExpiresAt: v.optional(v.number()),
    rejectedByUserIds: v.optional(v.array(v.id("users"))),
    claimedByUserId: v.optional(v.id("users")),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
    lastMessageAt: v.number(),
    closedAt: v.optional(v.number()),
    dealerLastReadAt: v.optional(v.number()),
    agentLastReadAt: v.optional(v.number()),
    // Typing indicators — last keystroke timestamp from each side; the
    // client treats this as "stopped typing" once it's a few seconds stale.
    dealerTypingAt: v.optional(v.number()),
    agentTypingAt: v.optional(v.number()),
    // Dealer presence within this thread's chat widget — self-reported by
    // the client (active = window open+focused, idle = open but unfocused)
    // and treated as "away" once dealerPresenceAt goes stale.
    dealerPresence: v.optional(v.union(v.literal("active"), v.literal("idle"))),
    dealerPresenceAt: v.optional(v.number()),
    dealerPresenceSince: v.optional(v.number()), // when dealerPresence last changed — drives the idle/away timer
    // Mirror of the above, but for the claiming agent's view of *this*
    // specific conversation (they may have several open elsewhere).
    agentPresence: v.optional(v.union(v.literal("active"), v.literal("idle"))),
    agentPresenceAt: v.optional(v.number()),
    agentPresenceSince: v.optional(v.number()),
  })
    .index("by_dealerUserId", ["dealerUserId"])
    .index("by_leadId", ["leadId"])
    .index("by_status", ["status", "createdAt"])
    .index("by_claimedByUserId", ["claimedByUserId"])
    .index("by_claimedByUserId_status", ["claimedByUserId", "status"]),

  // Typing/active-idle presence pings, split off liveChatThreads (one row per
  // thread+side) so a dealer's or agent's heartbeat never write-conflicts with
  // the other side, and so queries that don't display live presence (message
  // lists, thread lists) aren't invalidated by every ~10s heartbeat tick.
  // dealerLastReadAt/agentLastReadAt stay on liveChatThreads — they're low
  // frequency (only on actual reads, not heartbeats) and listMyActiveThreads
  // needs agentLastReadAt for its unread badges without an extra join.
  liveChatPresence: defineTable({
    threadId: v.id("liveChatThreads"),
    side: v.union(v.literal("DEALER"), v.literal("AGENT")),
    typingAt: v.optional(v.number()),
    presence: v.optional(v.union(v.literal("active"), v.literal("idle"))),
    presenceAt: v.optional(v.number()),
    presenceSince: v.optional(v.number()),
  }).index("by_thread_side", ["threadId", "side"]),

  liveChatMessages: defineTable({
    threadId: v.id("liveChatThreads"),
    senderType: v.union(v.literal("DEALER"), v.literal("AGENT")),
    senderUserId: v.optional(v.id("users")), // unset for messages sent by an anonymous LEAD-thread visitor
    senderName: v.optional(v.string()),
    bodyText: v.string(),
    createdAt: v.number(),
    // System notices (e.g. "agent ended the conversation") — rendered
    // centered/muted instead of as a chat bubble, but still an AGENT-typed
    // message so it flows through the existing unread/sound/notification path.
    isSystem: v.optional(v.boolean()),
  }).index("by_thread", ["threadId"]),

  // Temporary, audited "view/act as" access: while actively handling a
  // dealer's live chat, an agent can request a real (time-limited) OWNER-role
  // membership in that dealer's org to fix things directly. See
  // requestOrgAccess/revokeOrgAccess/expireOrgAccessGrant in convex/liveChat.ts.
  supportOrgAccessGrants: defineTable({
    agentUserId: v.id("users"),
    orgId: v.id("organizations"),
    threadId: v.id("liveChatThreads"),
    membershipId: v.id("memberships"),
    grantedAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_agentUserId_org", ["agentUserId", "orgId"])
    .index("by_orgId", ["orgId"])
    .index("by_threadId", ["threadId"]),

  // ─── Internal team messaging (DMs + group chats, org-scoped) ─────────────────

  dmConversations: defineTable({
    orgId: v.id("organizations"),
    type: v.union(v.literal("DM"), v.literal("GROUP")),
    name: v.optional(v.string()), // group display name
    memberIds: v.array(v.id("users")), // bounded — org team is small
    createdBy: v.id("users"),
    lastMessageAt: v.number(),
    lastMessageBody: v.optional(v.string()), // preview text
    lastMessageSenderId: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_lastMessageAt", ["orgId", "lastMessageAt"]),

  dmMessages: defineTable({
    conversationId: v.id("dmConversations"),
    senderId: v.id("users"),
    body: v.string(),
  }).index("by_conversation", ["conversationId"]),

  // Per-participant state: read receipts + typing + mute preference.
  // Kept separate from dmConversations to avoid write-contention on every
  // keystroke / read-receipt update invalidating the conversation list query.
  dmParticipantState: defineTable({
    conversationId: v.id("dmConversations"),
    userId: v.id("users"),
    lastReadAt: v.optional(v.number()), // marks messages up to here as "seen"
    typingAt: v.optional(v.number()),   // last keystroke timestamp
    isMuted: v.optional(v.boolean()),   // suppress sounds for this conversation
  })
    .index("by_conversation_user", ["conversationId", "userId"])
    .index("by_user", ["userId"]),

  // Temporary, audited "act as a specific real member" access for super
  // admins: same real-membership-grant pattern as supportOrgAccessGrants
  // above, but grants the target member's exact role rather than a fixed
  // OWNER role. See convex/adminImpersonation.ts.
  impersonationGrants: defineTable({
    actorUserId: v.id("users"), // the super admin
    targetUserId: v.id("users"), // the real member being impersonated
    orgId: v.id("organizations"),
    membershipId: v.id("memberships"), // the temp membership created for actorUserId
    reason: v.string(),
    grantedAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_actorUserId", ["actorUserId"])
    .index("by_orgId", ["orgId"]),

  // ─── Global site configuration (super-admin controlled) ───────────────────
  // Key-value store for platform-level settings that apply across all orgs.
  // Examples: showPlanPricing (bool), supportNotifyEmails (string[]).
  siteConfig: defineTable({
    key: v.string(),
    value: v.any(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Payment intents for payment-link / provider-initiated payments.
  // One intent per customer payment request. Fulfilled by provider webhook.
  paymentIntents: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    receivableDocumentId: v.optional(v.id("receivableDocuments")),
    saleId: v.optional(v.id("sales")),
    amountMinor: v.number(),
    currency: v.string(),
    provider: v.string(),
    externalId: v.optional(v.string()),
    status: v.union(
      v.literal("PENDING"),
      v.literal("SETTLED"),
      v.literal("FAILED"),
      v.literal("EXPIRED"),
      v.literal("REFUNDED")
    ),
    idempotencyKey: v.string(),
    providerPayload: v.optional(v.any()),
    settledAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_external_id", ["provider", "externalId"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"]),
});
