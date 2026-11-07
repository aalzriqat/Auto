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
  InventoryValuationScope: "Available, reserved and on-order vehicles, split by ownership",
  ActiveVehicles: "Active Vehicles",
  InventoryValue: "Inventory Value",
  OwnedInventoryValue: "Owned Inventory Value",
  OwnedInventoryValueHint:
    "Vehicles this dealership owns. Reconciles to the Vehicle Inventory account in the general ledger.",
  OwnedVehicles: "Owned vehicles",
  OwnedVehicle: "Owned vehicle",
  SourcedCommitment: "Sourced — committed, not owned",
  SourcedCommitmentHint:
    "Owed to source dealers for special-order cars. An obligation, not an asset — excluded from inventory value above.",
  SourcedVehicles: "Sourced vehicles",
  SourcedVehicle: "Sourced vehicle",
  Ownership: "Ownership",
  OwnedStock: "Owned",
  TotalInvested: "Total Invested",
  NoActiveVehiclesInInventory: "No active vehicles in inventory.",

  // Metrics cards
  TotalRevenue: "Total Revenue",
  TotalCosts: "Total Costs",
  TotalCost: "Total Cost",
  NetProfit: "Net Profit",
  ReportManagementNet: "Net profit (after commissions)",
  ReportUpdateRequired: "A report update is required before deal-page profit can be shown. These figures are unavailable until the backend update is deployed.",
  ReportDealCosts: "Deal costs and reconciliation",
  ReportDealFiguresHint: "Profit matches the deal page and includes commissions. Revenue is recognized dealership revenue. Costs and reconciliation bridge that revenue to net profit, including fees and showroom expenses. Supplier car prices are deal volume, not dealership revenue.",
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
  ProfitUnknownForSale:
    "The deal's net profit is unavailable. Check its fee, vehicle-cost and commission evidence or your access permissions on the deal page.",
  ProfitUnknownNotice:
    "{count} sale(s) are excluded from revenue, costs and net profit because a complete figure in the report currency is unavailable. Totals cover the included rows only.",
  // SCRUM-902: shown instead of the cost-bearing reports to a role that has view:reports but not view:cost_price.
  ReportsCostAccessRequired:
    "This report shows what each car cost and what it earned. Your role needs cost-price access as well as report access to see it. Ask an administrator to update your role.",
  // SCRUM-902: shown above the transaction register to a role without view:cost_price, whose list omits car purchase rows.
  RegisterCostRowsWithheld:
    "Car purchase rows are not shown, and the totals below leave them out. Your role needs cost-price access as well as finance access to see them. Ask an administrator to update your role.",
  // SCRUM-902: shown instead of the journal to a role that has view:finance but not view:cost_price.
  LedgerCostAccessRequired:
    "Journal entries show what each car cost. Your role needs cost-price access as well as finance access to see them. Ask an administrator to update your role.",
  // SCRUM-902: shown instead of the trial balance, income statement and balance sheet to a role without view:cost_price.
  FinancialStatementCostAccessRequired:
    "This statement includes vehicle inventory and cost of goods sold. Your role needs cost-price access as well as finance access to see it. Ask an administrator to update your role.",
  PerformanceUnknownNotice:
    "{count} sale(s) could not have their earnings established, so the salespeople who made them are listed separately at the bottom and are not ranked. Their totals cover only the sales that are known.",
  /**
   * Deliberately short. This sits inside a narrow numeric table cell, and the
   * full sentence — which is the notice above the table — wrapped onto four
   * lines at 390px and doubled the row's height. The explanation belongs where
   * there is room for it; the cell needs a marker.
   */
  ProfitKnownOnly: "{count} not counted",

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
  InventoryValuationScope: "المركبات المتاحة والمحجوزة وقيد الطلب، مقسّمة حسب الملكية",
  ActiveVehicles: "المركبات النشطة",
  InventoryValue: "قيمة المخزون",
  OwnedInventoryValue: "قيمة المخزون المملوك",
  OwnedInventoryValueHint:
    "المركبات التي يملكها المعرض. تتطابق مع حساب مخزون المركبات في دفتر الأستاذ العام.",
  OwnedVehicles: "مركبات مملوكة",
  OwnedVehicle: "مركبة مملوكة",
  SourcedCommitment: "مورَّدة — التزام وليست ملكاً",
  SourcedCommitmentHint:
    "مبالغ مستحقة لمعارض التوريد عن الطلبيات الخاصة. التزام وليس أصلاً — مستثناة من قيمة المخزون أعلاه.",
  SourcedVehicles: "مركبات مورَّدة",
  SourcedVehicle: "مركبة مورَّدة",
  Ownership: "الملكية",
  OwnedStock: "مملوكة",
  TotalInvested: "إجمالي الاستثمار",
  NoActiveVehiclesInInventory: "لا توجد مركبات نشطة في المخزون.",

  // Metrics cards
  TotalRevenue: "إجمالي الإيرادات",
  TotalCosts: "إجمالي التكاليف",
  TotalCost: "إجمالي التكلفة",
  NetProfit: "صافي الربح",
  ReportManagementNet: "صافي الربح (بعد العمولات)",
  ReportUpdateRequired: "يلزم تحديث التقرير قبل عرض ربح صفحة الصفقة. هذه الأرقام غير متاحة حتى نشر تحديث الخادم.",
  ReportDealCosts: "تكاليف الصفقة وفروق المطابقة",
  ReportDealFiguresHint: "يتطابق الربح مع صفحة الصفقة ويشمل العمولات. الإيرادات هي إيرادات المعرض المعترف بها. تربط التكاليف وفروق المطابقة هذه الإيرادات بصافي الربح، وتشمل الرسوم ومصروفات المعرض. أسعار سيارات الموردين تمثل حجم الصفقات وليست إيرادات المعرض.",
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
  ProfitUnknownForSale:
    "صافي ربح الصفقة غير متاح. راجع مستندات الرسوم وتكلفة المركبة والعمولات أو صلاحيات العرض في صفحة الصفقة.",
  ProfitUnknownNotice:
    "تم استثناء {count} عملية بيع من الإيرادات والتكاليف وصافي الربح لعدم توفر رقم مكتمل بعملة التقرير. تشمل الإجماليات الصفوف المحتسبة فقط.",
  ReportsCostAccessRequired:
    "يعرض هذا التقرير تكلفة كل مركبة وما حققته من ربح. يحتاج دورك إلى صلاحية عرض سعر التكلفة إضافةً إلى صلاحية التقارير. اطلب من المسؤول تحديث دورك.",
  RegisterCostRowsWithheld:
    "لا تظهر صفوف شراء المركبات، وتستثنيها الإجماليات أدناه. يحتاج دورك إلى صلاحية عرض سعر التكلفة إضافةً إلى صلاحية المالية. اطلب من المسؤول تحديث دورك.",
  LedgerCostAccessRequired:
    "تعرض قيود اليومية تكلفة كل مركبة. يحتاج دورك إلى صلاحية عرض سعر التكلفة إضافةً إلى صلاحية المالية. اطلب من المسؤول تحديث دورك.",
  FinancialStatementCostAccessRequired:
    "يتضمن هذا الكشف مخزون المركبات وتكلفة البضاعة المباعة. يحتاج دورك إلى صلاحية عرض سعر التكلفة إضافةً إلى صلاحية المالية. اطلب من المسؤول تحديث دورك.",
  PerformanceUnknownNotice:
    "تعذّر تحديد ما حققته {count} عملية بيع، لذلك يظهر البائعون الذين نفّذوها في أسفل الجدول بشكل منفصل ولا يدخلون في الترتيب. الإجماليات الخاصة بهم تشمل المبيعات المعروفة فقط.",
  ProfitKnownOnly: "{count} غير محتسبة",

  // Empty states
  NoSalesFoundPeriod: "لم يتم العثور على مبيعات في هذه الفترة.",
  NoExpensesFoundPeriod: "لم يتم العثور على مصروفات في هذه الفترة.",
  NoPerformanceData: "لم يتم العثور على بيانات أداء في هذه الفترة.",
  NoLeadMetrics: "لم يتم العثور على مقاييس عملاء محتملين في هذه الفترة.",
};
