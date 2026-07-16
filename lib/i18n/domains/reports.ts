export const reportsEn = {
  // Tab labels
  SalesProfit: "Sales & Profit",
  Performance: "Performance",
  LeadConversion: "Lead Conversion",
  SalesProfitOverview: "Sales & Profit Overview",
  ExpensesOverview: "Expenses Overview",

  // Inventory
  InventoryValuation: "Inventory Valuation",
  CurrentAvailableAndReserved: "Current available and reserved vehicles",
  ActiveVehicles: "Active Vehicles",
  InventoryValue: "Inventory Value",
  TotalInvested: "Total Invested",
  NoActiveVehiclesInInventory: "No active vehicles in inventory.",

  // Metrics cards
  TotalRevenue: "Total Revenue",
  TotalCosts: "Total Costs",
  TotalCost: "Total Cost",
  NetProfit: "Net Profit",
  TotalExpenses: "Total Expenses",
  TotalLeads: "Total Leads",
  WonLeads: "Won Leads",
  OverallConversion: "Overall Conversion",

  // Performance table
  SalespersonPerformance: "Salesperson Performance",
  VehiclesSold: "Vehicles Sold",

  // Leads table
  AssignedLeads: "Assigned Leads",
  Won: "Won",
  ConversionRate: "Conversion Rate",

  // Expenses table
  Category: "Category",
  Description: "Description",
  RelatedVehicle: "Related Vehicle",
  Amount: "Amount",
  PrepaidAmortizedNote: "Prepaid — {monthsElapsed}/{amortizationMonths} months recognized of {totalAmount} total",

  // Operational vs ledger — this report counts what happened operationally,
  // including postings still queued or failed. The income statement counts only
  // what reached the ledger. The two agree exactly when nothing is outstanding.
  OperationalExpensesReport: "Operational Expenses Report",
  OperationalTotal: "Operational Total",
  PostedToPnl: "Posted to P&L",
  CapitalizedToAssets: "Capitalized to Assets",
  PendingPosting: "Pending Posting",
  FailedPosting: "Failed Posting",
  GlStatus: "Ledger Status",
  GlStatePOSTED: "Posted",
  GlStateCAPITALIZED: "Capitalized",
  GlStatePENDING: "Pending",
  GlStateFAILED: "Failed",
  GlStateMIXED: "Partly posted",
  OperationalReportNotice:
    "This is an operational report: it counts what happened, including {count} posting(s) not yet in the ledger. The official profit & loss is the ledger-backed Income Statement.",
  OperationalReportCapitalizedNote:
    "All expenses here have posted. This operational total is {capitalized} higher than the Income Statement because that much was capitalized to inventory, which is reported as an asset rather than an expense.",
  OperationalReportAllPosted: "Every expense in this period has posted to the ledger as a P&L expense, so this report and the Income Statement agree.",
  ResolveUnpostedEntries: "Resolve unposted entries",

  // Empty states
  NoSalesFoundPeriod: "No sales found in this period.",
  NoExpensesFoundPeriod: "No expenses found in this period.",
  NoPerformanceData: "No performance data found in this period.",
  NoLeadMetrics: "No lead metrics found in this period.",
};

export const reportsAr = {
  // Tab labels
  SalesProfit: "المبيعات والأرباح",
  Performance: "الأداء",
  LeadConversion: "تحويل العملاء المحتملين",
  SalesProfitOverview: "نظرة عامة على المبيعات والأرباح",
  ExpensesOverview: "نظرة عامة على المصروفات",

  // Inventory
  InventoryValuation: "تقييم المخزون",
  CurrentAvailableAndReserved: "المركبات المتاحة والمحجوزة حالياً",
  ActiveVehicles: "المركبات النشطة",
  InventoryValue: "قيمة المخزون",
  TotalInvested: "إجمالي الاستثمار",
  NoActiveVehiclesInInventory: "لا توجد مركبات نشطة في المخزون.",

  // Metrics cards
  TotalRevenue: "إجمالي الإيرادات",
  TotalCosts: "إجمالي التكاليف",
  TotalCost: "إجمالي التكلفة",
  NetProfit: "صافي الربح",
  TotalExpenses: "إجمالي المصروفات",
  TotalLeads: "إجمالي العملاء المحتملين",
  WonLeads: "العملاء المحتملون الذين تحولوا",
  OverallConversion: "نسبة التحويل الإجمالية",

  // Performance table
  SalespersonPerformance: "أداء مندوبي المبيعات",
  VehiclesSold: "المركبات المباعة",

  // Leads table
  AssignedLeads: "العملاء المحتملون المكلفون",
  Won: "تحولوا",
  ConversionRate: "نسبة التحويل",

  // Expenses table
  Category: "الفئة",
  Description: "الوصف",
  RelatedVehicle: "المركبة ذات الصلة",
  Amount: "المبلغ",
  PrepaidAmortizedNote: "مصروف مدفوع مقدماً — تم احتساب {monthsElapsed}/{amortizationMonths} أشهر من إجمالي {totalAmount}",

  // Operational vs ledger
  OperationalExpensesReport: "تقرير المصروفات التشغيلي",
  OperationalTotal: "الإجمالي التشغيلي",
  PostedToPnl: "مُرحّل إلى قائمة الدخل",
  CapitalizedToAssets: "مُرسمل ضمن الأصول",
  PendingPosting: "بانتظار الترحيل",
  FailedPosting: "فشل الترحيل",
  GlStatus: "حالة الترحيل",
  GlStatePOSTED: "مُرحّل",
  GlStateCAPITALIZED: "مُرسمل",
  GlStatePENDING: "بانتظار الترحيل",
  GlStateFAILED: "فشل الترحيل",
  GlStateMIXED: "مُرحّل جزئياً",
  OperationalReportNotice:
    "هذا تقرير تشغيلي: يحتسب ما حدث فعلاً، بما في ذلك {count} قيد لم يصل إلى دفتر الأستاذ بعد. أما قائمة الدخل المبنية على دفتر الأستاذ فهي التقرير الرسمي للأرباح والخسائر.",
  OperationalReportCapitalizedNote:
    "جميع المصروفات هنا مُرحّلة. هذا الإجمالي التشغيلي يزيد عن قائمة الدخل بمقدار {capitalized} لأن هذا المبلغ رُسمل ضمن المخزون، ويظهر كأصل وليس كمصروف.",
  OperationalReportAllPosted: "جميع مصروفات هذه الفترة مُرحّلة إلى دفتر الأستاذ كمصروف في قائمة الدخل، لذلك يتطابق هذا التقرير مع قائمة الدخل.",
  ResolveUnpostedEntries: "معالجة القيود غير المُرحّلة",

  // Empty states
  NoSalesFoundPeriod: "لم يتم العثور على مبيعات في هذه الفترة.",
  NoExpensesFoundPeriod: "لم يتم العثور على مصروفات في هذه الفترة.",
  NoPerformanceData: "لم يتم العثور على بيانات أداء في هذه الفترة.",
  NoLeadMetrics: "لم يتم العثور على مقاييس عملاء محتملين في هذه الفترة.",
};
