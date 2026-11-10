import { defineBilingualMessages } from "../defineBilingualMessages";

/** Statement source links and relationship labels, split to retain the supplier domain size bound. */
const messages = defineBilingualMessages({
  SuppliersRowAP: ["A/P to supplier", "ذمم دائنة للمورّد"],
  SuppliersRowAR: ["A/R from supplier", "ذمم مدينة على المورّد"],
  SuppliersRowPayee: ["Payee", "المستفيد"],
  SuppliersRowPayer: ["Payer", "الدافع"],
  SuppliersRowCreated: ["Recorded", "تاريخ التسجيل"],
  SuppliersRowUnknownTime: ["Date unavailable", "التاريخ غير متاح"],
  SuppliersRowUnknownParty: ["Supplier snapshot unavailable", "بيانات المورّد المحفوظة غير متاحة"],
  SuppliersRowSourceUnavailable: ["Source record unavailable", "المستند المصدر غير متاح"],
  SuppliersRowSourceVEHICLE: ["Vehicle", "المركبة"],
  SuppliersRowSourceSALE: ["Sale", "البيع"],
  SuppliersRowSourceAPPLICATION: ["Deal", "الصفقة"],
  SuppliersRowSourceEXPENSE: ["Expense", "المصروف"],
  SuppliersRowSourceOPENING: ["Opening balance", "الرصيد الافتتاحي"],
  SuppliersRelationshipsTitle: ["Relationships", "السجلات المرتبطة"],
  SuppliersRelationshipsSourcedTitle: ["Consignment vehicles", "مركبات الأمانة"],
  SuppliersRelationshipsOwnedTitle: ["Owned vehicles bought on account", "المركبات المملوكة المشتراة على الحساب"],
  SuppliersRelationshipsSourced: ["Consignment", "أمانة"],
  SuppliersRelationshipsOwned: ["Owned · on account", "مملوكة · على الحساب"],
  SuppliersRelationshipsScope: ["Linked by supplier id only. Older records without a supplier link are excluded; their count is unavailable here.", "الربط بمعرّف المورّد فقط. تُستبعد السجلات القديمة غير المرتبطة بمورّد؛ عددها غير متاح هنا."],
  SuppliersRelationshipsLoading: ["Loading linked vehicles…", "جارٍ تحميل المركبات المرتبطة…"],
  SuppliersRelationshipsEmpty: ["No linked vehicles in this category.", "لا توجد مركبات مرتبطة في هذه الفئة."],
  SuppliersRelationshipsIncomplete: ["Incomplete list. More linked records may exist; no total is shown.", "القائمة غير مكتملة. قد توجد سجلات مرتبطة أخرى؛ لا يُعرض إجمالي."],
  SuppliersRelationshipsMore: ["Load more", "تحميل المزيد"],
  SuppliersRelationshipsError: ["Linked records could not be loaded. Please try again.", "تعذّر تحميل السجلات المرتبطة. يرجى المحاولة مجدداً."],
  ServerError_SUPPLIER_NAVIGATION_UNAVAILABLE: ["Supplier records could not be loaded. Please try again.", "تعذّر تحميل سجلات المورّد. يرجى المحاولة مجدداً."],
});

export const supplierNavigationEn = messages.en;
export const supplierNavigationAr = messages.ar;
