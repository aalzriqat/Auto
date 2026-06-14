import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  }).index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"]),

  organizations: defineTable({
    name: v.string(),
    createdAt: v.number(),
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
    .index("by_org_email", ["orgId", "email"]),

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
    .index("by_org_assigned", ["orgId", "assignedUserId"]),

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
    commissionAmount: v.optional(v.number()), // Calculated at sale time
    commissionPaidAt: v.optional(v.number()),
    commissionPaidBy: v.optional(v.id("users")),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_salesperson", ["orgId", "salespersonId"])
    .index("by_org_saleDate", ["orgId", "saleDate"]),

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
    .index("by_status_alarm", ["status", "alarmTriggered"]),

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

    // Core parameters
    vehiclePrice: v.number(),
    downPayment: v.number(),
    termMonths: v.number(),

    // Financing Engine output
    totalFinancedAmount: v.optional(v.number()), // Principal + Insurance + Fees
    monthlyInstallment: v.optional(v.number()),
    profitRateApplied: v.optional(v.number()),
    totalProfit: v.optional(v.number()),

    status: v.union(v.literal("DRAFT"), v.literal("SHARED"), v.literal("ACCEPTED"), v.literal("EXPIRED")),
    expiresAt: v.optional(v.number()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_customer", ["customerId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_status", ["status"]),

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
      recipientName: v.optional(v.string()),
    }),
    selectedCustomerId: v.optional(v.string()),
    savedAt: v.number(),
  })
    .index("by_org_user", ["orgId", "userId"]),

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
    })),
  })
    .index("by_org", ["orgId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_salesperson", ["salespersonId"])
    .index("by_status", ["status"]),
});
