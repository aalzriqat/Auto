"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Id } from "@/convex/_generated/dataModel";

type EntityType = "vehicle" | "customer" | "lead";
type FieldType = "text" | "number" | "select" | "date";

function FieldForm({ orgId, entityType, onDone }: {
  orgId: string;
  entityType: EntityType;
  onDone: () => void;
}) {
  const { t } = useLanguage();
  const createField = useMutation(api.orgCustomFields.create);
  const [fieldName, setFieldName] = useState("");
  const [fieldType, setFieldType] = useState<FieldType>("text");
  const [isRequired, setIsRequired] = useState(false);
  const [optionsRaw, setOptionsRaw] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const fieldKey = fieldName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

  const FIELD_TYPES: { value: FieldType; labelKey: string }[] = [
    { value: "text", labelKey: "FieldTypeText" },
    { value: "number", labelKey: "FieldTypeNumber" },
    { value: "select", labelKey: "FieldTypeDropdown" },
    { value: "date", labelKey: "FieldTypeDate" },
  ];

  const handleCreate = async () => {
    if (!fieldName.trim()) return;
    setIsSaving(true);
    try {
      const options = fieldType === "select"
        ? optionsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      await createField({
        orgId: orgId as Id<"organizations">,
        entityType,
        fieldName: fieldName.trim(),
        fieldKey,
        fieldType,
        isRequired,
        options,
      });
      toast.success(t("FieldCreated" as any));
      onDone();
    } catch (error: any) {
      toast.error(error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4 p-4 rounded-lg border border-dashed border-border bg-muted/20">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>{t("FieldName" as any)}</Label>
          <Input
            placeholder={t("FieldNamePlaceholder" as any)}
            value={fieldName}
            onChange={(e) => setFieldName(e.target.value)}
            autoFocus
          />
          {fieldName && (
            <p className="text-xs text-muted-foreground">{t("FieldKeyPrefix" as any)} <code>{fieldKey}</code></p>
          )}
        </div>
        <div className="space-y-1">
          <Label>{t("FieldType" as any)}</Label>
          <Select value={fieldType} onValueChange={(v) => setFieldType(v as FieldType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIELD_TYPES.map((ft) => (
                <SelectItem key={ft.value} value={ft.value}>{t(ft.labelKey as any)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {fieldType === "select" && (
          <div className="space-y-1 md:col-span-2">
            <Label>{t("DropdownOptions" as any)}</Label>
            <Input
              placeholder="Option 1, Option 2, Option 3"
              value={optionsRaw}
              onChange={(e) => setOptionsRaw(e.target.value)}
            />
          </div>
        )}
        <div className="flex items-center gap-3 md:col-span-2">
          <Switch checked={isRequired} onCheckedChange={setIsRequired} />
          <Label>{t("RequiredField" as any)}</Label>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleCreate} disabled={isSaving || !fieldName.trim()}>
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : t("AddField" as any)}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>{t("Cancel" as any)}</Button>
      </div>
    </div>
  );
}

function EntityFieldList({ orgId, entityType, descKey }: { orgId: string; entityType: EntityType; descKey: string }) {
  const { t } = useLanguage();
  const fields = useQuery(api.orgCustomFields.list, {
    orgId: orgId as Id<"organizations">,
    entityType,
  });
  const updateField = useMutation(api.orgCustomFields.update);
  const removeField = useMutation(api.orgCustomFields.remove);
  const [showForm, setShowForm] = useState(false);

  const handleToggle = async (fieldId: Id<"orgCustomFields">, isActive: boolean) => {
    try {
      await updateField({ orgId: orgId as Id<"organizations">, fieldId, isActive });
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleDelete = async (fieldId: Id<"orgCustomFields">) => {
    if (!confirm(t("DeleteCustomFieldConfirm" as any))) return;
    try {
      await removeField({ orgId: orgId as Id<"organizations">, fieldId });
      toast.success(t("FieldDeleted" as any));
    } catch (error: any) {
      toast.error(error);
    }
  };

  const entityTitleKey = entityType === "vehicle"
    ? "VehicleCustomFields"
    : entityType === "customer"
    ? "CustomerCustomFields"
    : "LeadCustomFields";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="capitalize">{t(entityTitleKey as any)}</CardTitle>
        <CardDescription>{t(descKey as any)}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {fields === undefined ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> {t("Loading" as any)}
            </div>
          ) : fields.length === 0 && !showForm ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              {t("NoCustomFieldsYet" as any)}
            </div>
          ) : (
            fields.map((field) => (
              <div key={field._id} className="flex items-center gap-3 rounded-lg border px-4 py-3 bg-card">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{field.fieldName}</span>
                    <Badge variant="outline" className="text-xs">{field.fieldType}</Badge>
                    {field.isRequired && <Badge variant="secondary" className="text-xs">{t("FieldRequired" as any)}</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{t("FieldKeyPrefix" as any)} {field.fieldKey}</p>
                  {field.options && field.options.length > 0 && (
                    <p className="text-xs text-muted-foreground">{field.options.join(", ")}</p>
                  )}
                </div>
                <Switch
                  checked={field.isActive}
                  onCheckedChange={(checked) => handleToggle(field._id, checked)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-red-500 hover:text-red-600 h-8 w-8"
                  onClick={() => handleDelete(field._id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}

          {showForm ? (
            <FieldForm orgId={orgId} entityType={entityType} onDone={() => setShowForm(false)} />
          ) : (
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4 mr-2" /> {t("AddField" as any)}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const ENTITY_TABS: { value: EntityType; labelKey: string; descKey: string }[] = [
  { value: "vehicle", labelKey: "Vehicles", descKey: "VehicleCustomFieldsDesc" },
  { value: "customer", labelKey: "Customers", descKey: "CustomerCustomFieldsDesc" },
  { value: "lead", labelKey: "Leads", descKey: "LeadCustomFieldsDesc" },
];

export default function CustomFieldsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  if (!activeOrgId) return null;

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("CustomFields" as any)}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t("CustomFieldsDesc" as any)}</p>
      </div>

      <Tabs defaultValue="vehicle" className="space-y-4">
        <div className="overflow-x-auto">
          <TabsList className="w-max">
            {ENTITY_TABS.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value}>{t(tab.labelKey as any)}</TabsTrigger>
            ))}
          </TabsList>
        </div>

        {ENTITY_TABS.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            <EntityFieldList orgId={activeOrgId} entityType={tab.value} descKey={tab.descKey} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
