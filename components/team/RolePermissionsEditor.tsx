import { useState } from "react";
import { PERMISSIONS, Permission } from "@/convex/utils/permissions";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";

// Group permissions logically for the UI
const PERMISSION_GROUPS = [
  {
    id: "vehicles",
    label: "Vehicles",
    baseView: PERMISSIONS.VIEW_VEHICLES,
    tabs: [
      { id: PERMISSIONS.VIEW_VEHICLE_INFO, label: "Info Tab" },
      { id: PERMISSIONS.VIEW_VEHICLE_LEADS, label: "Leads Tab" },
      { id: PERMISSIONS.VIEW_VEHICLE_EXPENSES, label: "Expenses Tab" },
      { id: PERMISSIONS.VIEW_VEHICLE_TASKS, label: "Tasks Tab" },
      { id: PERMISSIONS.VIEW_VEHICLE_TEST_DRIVES, label: "Test Drives Tab" },
      { id: PERMISSIONS.VIEW_VEHICLE_WORK_ORDERS, label: "Work Orders Tab" },
      { id: PERMISSIONS.VIEW_VEHICLE_VALUATIONS, label: "Valuations Tab" },
    ],
    actions: [
      { id: PERMISSIONS.CREATE_VEHICLES, request: PERMISSIONS.CREATE_VEHICLES_REQUEST, label: "Create Vehicles" },
      { id: PERMISSIONS.EDIT_VEHICLES, request: PERMISSIONS.EDIT_VEHICLES_REQUEST, label: "Edit Vehicles" },
      { id: PERMISSIONS.DELETE_VEHICLES, label: "Delete Vehicles" },
    ]
  },
  {
    id: "sales",
    label: "Sales",
    baseView: PERMISSIONS.VIEW_SALES,
    tabs: [],
    actions: [
      { id: PERMISSIONS.CREATE_SALES, request: PERMISSIONS.CREATE_SALES_REQUEST, label: "Create Sales" },
      { id: PERMISSIONS.EDIT_SALES, request: PERMISSIONS.EDIT_SALES_REQUEST, label: "Edit Sales" },
      { id: PERMISSIONS.DELETE_SALES, label: "Delete Sales" },
    ]
  },
  {
    id: "customers",
    label: "Customers",
    baseView: PERMISSIONS.VIEW_CUSTOMERS,
    tabs: [],
    actions: [
      { id: PERMISSIONS.CREATE_CUSTOMERS, request: PERMISSIONS.CREATE_CUSTOMERS_REQUEST, label: "Create Customers" },
      { id: PERMISSIONS.EDIT_CUSTOMERS, request: PERMISSIONS.EDIT_CUSTOMERS_REQUEST, label: "Edit Customers" },
      { id: PERMISSIONS.DELETE_CUSTOMERS, label: "Delete Customers" },
    ]
  },
  {
    id: "leads",
    label: "Leads",
    baseView: PERMISSIONS.VIEW_LEADS,
    tabs: [],
    actions: [
      { id: PERMISSIONS.CREATE_LEADS, request: PERMISSIONS.CREATE_LEADS_REQUEST, label: "Create Leads" },
      { id: PERMISSIONS.EDIT_LEADS, request: PERMISSIONS.EDIT_LEADS_REQUEST, label: "Edit Leads" },
      { id: PERMISSIONS.DELETE_LEADS, label: "Delete Leads" },
    ]
  },
  {
    id: "expenses",
    label: "Expenses",
    baseView: PERMISSIONS.VIEW_EXPENSES,
    tabs: [],
    actions: [
      { id: PERMISSIONS.CREATE_EXPENSES, request: PERMISSIONS.CREATE_EXPENSES_REQUEST, label: "Create Expenses" },
      { id: PERMISSIONS.EDIT_EXPENSES, request: PERMISSIONS.EDIT_EXPENSES_REQUEST, label: "Edit Expenses" },
      { id: PERMISSIONS.DELETE_EXPENSES, label: "Delete Expenses" },
    ]
  },
  {
    id: "tasks",
    label: "Tasks",
    baseView: PERMISSIONS.VIEW_TASKS,
    tabs: [],
    actions: [
      { id: PERMISSIONS.CREATE_TASKS, label: "Create Tasks" },
      { id: PERMISSIONS.EDIT_TASKS, label: "Edit Tasks" },
      { id: PERMISSIONS.DELETE_TASKS, label: "Delete Tasks" },
    ]
  },
  {
    id: "settings",
    label: "Settings",
    baseView: PERMISSIONS.VIEW_SETTINGS,
    tabs: [],
    actions: [
      { id: PERMISSIONS.MANAGE_SETTINGS, label: "Manage Settings" },
      { id: PERMISSIONS.MANAGE_USERS, label: "Manage Users & Roles" },
      { id: PERMISSIONS.VIEW_COST_PRICE, label: "View Cost Price" },
    ]
  }
];

export function RolePermissionsEditor({
  selectedPermissions,
  onChange
}: {
  selectedPermissions: string[];
  onChange: (permissions: string[]) => void;
}) {
  const { t } = useLanguage();

  const togglePermission = (id: string, enabled: boolean) => {
    if (enabled) {
      onChange([...selectedPermissions, id]);
    } else {
      onChange(selectedPermissions.filter(p => p !== id));
    }
  };

  const handleActionChange = (actionId: string, requestId: string | undefined, value: "NONE" | "REQUEST" | "DIRECT") => {
    let newPerms = [...selectedPermissions];

    // Remove both first
    newPerms = newPerms.filter(p => p !== actionId && p !== requestId);

    if (value === "DIRECT") {
      newPerms.push(actionId);
    } else if (value === "REQUEST" && requestId) {
      newPerms.push(requestId);
    }

    onChange(newPerms);
  };

  return (
    <Accordion type="multiple" className="w-full space-y-2">
      {PERMISSION_GROUPS.map((group) => {
        const hasBaseAccess = selectedPermissions.includes(group.baseView);

        return (
          <AccordionItem key={group.id} value={group.id} className="border rounded-lg px-4 bg-card">
            <AccordionTrigger className="hover:no-underline py-3">
              <div className="flex items-center justify-between w-full pr-4">
                <span className="font-semibold">{t(group.label as any)}</span>
                <div
                  className="flex items-center space-x-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Label htmlFor={`base-${group.id}`} className="text-xs font-normal cursor-pointer">
                    {hasBaseAccess ? t("Enabled" as any) : t("Disabled" as any)}
                  </Label>
                  <Switch
                    id={`base-${group.id}`}
                    checked={hasBaseAccess}
                    onCheckedChange={(c) => togglePermission(group.baseView, c)}
                  />
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2 pb-4 space-y-6 border-t mt-2">
              {!hasBaseAccess && (
                <div className="text-sm text-muted-foreground p-3 bg-muted rounded-md border border-dashed">
                  {t("EnableModuleToggle" as any)}
                </div>
              )}

              <div className={`space-y-6 ${!hasBaseAccess ? 'opacity-50 pointer-events-none' : ''}`}>
                {/* Tabs Configuration */}
                {group.tabs.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-3 text-foreground/80">{t("TabVisibility" as any)}</h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {group.tabs.map(tab => (
                        <div key={tab.id} className="flex items-center space-x-2 bg-muted/30 p-2 rounded border">
                          <Checkbox
                            id={tab.id}
                            checked={selectedPermissions.includes(tab.id)}
                            onCheckedChange={(c) => togglePermission(tab.id, c === true)}
                          />
                          <Label htmlFor={tab.id} className="text-xs cursor-pointer font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                            {t(tab.label.replace(/[\s&]+/g, "") as any)}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions Configuration */}
                {group.actions.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium mb-3 text-foreground/80">{t("ActionsAndApprovals" as any)}</h4>
                    <div className="grid gap-3">
                      {group.actions.map(action => {
                        const actionRequest = (action as any).request;
                        const isDirect = selectedPermissions.includes(action.id);
                        const isRequest = actionRequest ? selectedPermissions.includes(actionRequest) : false;

                        let currentValue: "NONE" | "REQUEST" | "DIRECT" = "NONE";
                        if (isDirect) currentValue = "DIRECT";
                        else if (isRequest) currentValue = "REQUEST";

                        return (
                          <div key={action.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded border bg-muted/10">
                            <Label className="text-sm font-medium mb-2 sm:mb-0">{t(action.label.replace(/[\s&]+/g, "") as any)}</Label>
                            <div className="flex bg-muted p-1 rounded-md">
                              <button
                                type="button"
                                onClick={() => handleActionChange(action.id, actionRequest, "NONE")}
                                className={`px-3 py-1 text-xs rounded-sm font-medium transition-colors ${currentValue === "NONE" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                              >
                                {t("NoAccess" as any)}
                              </button>
                              {actionRequest && (
                                <button
                                  type="button"
                                  onClick={() => handleActionChange(action.id, actionRequest, "REQUEST")}
                                  className={`px-3 py-1 text-xs rounded-sm font-medium transition-colors ${currentValue === "REQUEST" ? "bg-yellow-500/20 text-yellow-700 dark:text-yellow-400 shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                                >
                                  {t("RequiresApproval" as any)}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleActionChange(action.id, actionRequest, "DIRECT")}
                                className={`px-3 py-1 text-xs rounded-sm font-medium transition-colors ${currentValue === "DIRECT" ? "bg-green-500/20 text-green-700 dark:text-green-400 shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                              >
                                {t("DirectAccess" as any)}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}
