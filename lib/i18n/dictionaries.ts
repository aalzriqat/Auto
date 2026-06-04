export type Locale = "en" | "ar";

const en = {
  // Navigation
  Dashboard: "Dashboard",
  Vehicles: "Vehicles",
  Customers: "Customers",
  Leads: "Leads",
  Sales: "Sales",
  Tasks: "Tasks",
  Expenses: "Expenses",
  Team: "Team",
  
  // Common
  Search: "Search...",
  Loading: "Loading...",
  Cancel: "Cancel",
  Save: "Save",
  Delete: "Delete",
  Edit: "Edit",
  AddNew: "Add New",
  Actions: "Actions",
  Status: "Status",
  Date: "Date",
  Price: "Price",
  
  // Custom context will fallback to English if not defined here for MVP.
};

const ar: typeof en = {
  // Navigation
  Dashboard: "لوحة القيادة",
  Vehicles: "المركبات",
  Customers: "العملاء",
  Leads: "العملاء المحتملين",
  Sales: "المبيعات",
  Tasks: "المهام",
  Expenses: "المصروفات",
  Team: "الفريق",
  
  // Common
  Search: "بحث...",
  Loading: "جاري التحميل...",
  Cancel: "إلغاء",
  Save: "حفظ",
  Delete: "حذف",
  Edit: "تعديل",
  AddNew: "إضافة جديد",
  Actions: "إجراءات",
  Status: "الحالة",
  Date: "التاريخ",
  Price: "السعر",
};

export const dictionaries = {
  en,
  ar,
};

export function getDictionary(locale: Locale) {
  return dictionaries[locale];
}
