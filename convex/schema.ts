import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    disabled: v.optional(v.boolean()),
  }).index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"]),

  organizations: defineTable({
    name: v.string(),
    createdAt: v.number(),
    suspended: v.optional(v.boolean()),
    suspendedAt: v.optional(v.number()),
    suspendedReason: v.optional(v.string()),
  }),

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
    addedBy: v.optional(v.id("users")),
    updatedBy: v.optional(v.id("users")),
    updatedAt: v.optional(v.number()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_vin", ["orgId", "vin"]),

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
    .index("by_org_phone", ["orgId", "phone"]),

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
    title: v.string(),
    message: v.string(),
    isRead: v.boolean(),
    link: v.optional(v.string()), // Optional URL to navigate to when clicked
    relatedTaskId: v.optional(v.id("tasks")),
  })
    .index("by_user", ["userId"])
    .index("by_org_user", ["orgId", "userId"]),

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
      v.literal("PARTNER_DRAW"), v.literal("CAPITAL_INJECTION"),
      v.literal("CLAIM_PAYMENT"), v.literal("OTHER")
    ),
    description: v.string(), // "البيان"
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
    instagramAccessToken: v.optional(v.string()),
    instagramTokenExpiresAt: v.optional(v.number()),
    instagramPageName: v.optional(v.string()),
    socialAutoPostEnabled: v.optional(v.boolean()),
    instagramAutoReplyEnabled: v.optional(v.boolean()),
    instagramAutoReplyMessages: v.optional(v.array(v.string())),
    instagramAutoReplyLastIndex: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_instagram_business_account_id", ["instagramBusinessAccountId"]),

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
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    text: v.optional(v.string()),
    autoRepliedAt: v.optional(v.number()),
  })
    .index("by_org_external", ["orgId", "externalId"])
    .index("by_org_sender", ["orgId", "senderInstagramId"]),

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
    .index("by_org_vehicle", ["orgId", "vehicleId"]),

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
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"]),

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
      v.literal("instagram")
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
    // Which inbox this thread belongs to — support@ (help requests) vs info@
    // (general/sales inquiries) get separate threads even for the same sender.
    inbox: v.union(v.literal("support"), v.literal("info")),
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
});
