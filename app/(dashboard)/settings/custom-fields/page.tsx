"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
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
import { toast } from "sonner";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Id } from "@/convex/_generated/dataModel";

type EntityType = "vehicle" | "customer" | "lead";
type FieldType = "text" | "number" | "select" | "date";

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "select", label: "Dropdown" },
  { value: "date", label: "Date" },
];

function FieldForm({ orgId, entityType, onDone }: {
  orgId: string;
  entityType: EntityType;
  onDone: () => void;
}) {
  const createField = useMutation(api.orgCustomFields.create);
  const [fieldName, setFieldName] = useState("");
  const [fieldType, setFieldType] = useState<FieldType>("text");
  const [isRequired, setIsRequired] = useState(false);
  const [optionsRaw, setOptionsRaw] = useState(""); // comma-separated
  const [isSaving, setIsSaving] = useState(false);

  const fieldKey = fieldName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

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
      toast.success("Custom field created.");
      onDone();
    } catch (error: any) {
      toast.error(error.message || "Failed to create field.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4 p-4 rounded-lg border border-dashed border-border bg-muted/20">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Field Name</Label>
          <Input
            placeholder="e.g. Insurance Expiry"
            value={fieldName}
            onChange={(e) => setFieldName(e.target.value)}
            autoFocus
          />
          {fieldName && (
            <p className="text-xs text-muted-foreground">Key: <code>{fieldKey}</code></p>
          )}
        </div>
        <div className="space-y-1">
          <Label>Field Type</Label>
          <Select value={fieldType} onValueChange={(v) => setFieldType(v as FieldType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIELD_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {fieldType === "select" && (
          <div className="space-y-1 md:col-span-2">
            <Label>Options (comma-separated)</Label>
            <Input
              placeholder="Option 1, Option 2, Option 3"
              value={optionsRaw}
              onChange={(e) => setOptionsRaw(e.target.value)}
            />
          </div>
        )}
        <div className="flex items-center gap-3 md:col-span-2">
          <Switch checked={isRequired} onCheckedChange={setIsRequired} />
          <Label>Required field</Label>
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleCreate} disabled={isSaving || !fieldName.trim()}>
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add Field"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function EntityFieldList({ orgId, entityType }: { orgId: string; entityType: EntityType }) {
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
      toast.error(error.message || "Failed to update field.");
    }
  };

  const handleDelete = async (fieldId: Id<"orgCustomFields">) => {
    if (!confirm("Delete this custom field and all its values?")) return;
    try {
      await removeField({ orgId: orgId as Id<"organizations">, fieldId });
      toast.success("Field deleted.");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete field.");
    }
  };

  return (
    <div className="space-y-3">
      {fields === undefined ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading...
        </div>
      ) : fields.length === 0 && !showForm ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          No custom fields yet. Add one below.
        </div>
      ) : (
        fields.map((field) => (
          <div key={field._id} className="flex items-center gap-3 rounded-lg border px-4 py-3 bg-card">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{field.fieldName}</span>
                <Badge variant="outline" className="text-xs">{field.fieldType}</Badge>
                {field.isRequired && <Badge variant="secondary" className="text-xs">Required</Badge>}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">key: {field.fieldKey}</p>
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
          <Plus className="h-4 w-4 mr-2" /> Add Field
        </Button>
      )}
    </div>
  );
}

export default function CustomFieldsPage() {
  const { activeOrgId } = useOrg();

  if (!activeOrgId) return null;

  return (
    <div className="flex-1 space-y-4 p-4 md:p-8 pt-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Custom Fields</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Define extra fields that appear in vehicle, customer, and lead forms.
        </p>
      </div>

      <Tabs defaultValue="vehicle" className="space-y-4">
        <TabsList>
          <TabsTrigger value="vehicle">Vehicles</TabsTrigger>
          <TabsTrigger value="customer">Customers</TabsTrigger>
          <TabsTrigger value="lead">Leads</TabsTrigger>
        </TabsList>

        {(["vehicle", "customer", "lead"] as EntityType[]).map((entity) => (
          <TabsContent key={entity} value={entity}>
            <Card>
              <CardHeader>
                <CardTitle className="capitalize">{entity} Custom Fields</CardTitle>
                <CardDescription>
                  These fields will appear in the {entity} form below the standard fields.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EntityFieldList orgId={activeOrgId} entityType={entity} />
              </CardContent>
            </Card>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
