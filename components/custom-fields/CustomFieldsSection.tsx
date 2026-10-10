"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useEffect, useState } from "react";
import { toast } from "@/components/ui/sonner";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";

type EntityType = "vehicle" | "customer" | "lead";

/** Mirrors WRITE_TARGETS in convex/orgCustomFields.ts, which is the authority. */
const EDIT_PERMISSION: Record<EntityType, string> = {
  vehicle: PERMISSIONS.EDIT_VEHICLES,
  customer: PERMISSIONS.EDIT_CUSTOMERS,
  lead: PERMISSIONS.EDIT_LEADS,
};

interface Props {
  orgId: string;
  entityType: EntityType;
  /** Pass the entity ID when editing an existing entity; undefined for new entities */
  entityId?: string;
  /** Callback to retrieve current values so parent can include them on save */
  onChange?: (values: Record<string, string>) => void;
}

export function CustomFieldsSection({ orgId, entityType, entityId, onChange }: Props) {
  const fields = useQuery(api.orgCustomFields.list, {
    orgId: orgId as Id<"organizations">,
    entityType,
  });
  const existingValues = useQuery(
    api.orgCustomFields.getValues,
    entityId
      ? { orgId: orgId as Id<"organizations">, entityType, entityId }
      : "skip"
  );

  const { hasPermission, isLoading } = usePermissions();
  const [values, setValues] = useState<Record<string, string>>({});

  // Load existing values when editing
  useEffect(() => {
    if (existingValues) {
      const map: Record<string, string> = {};
      for (const v of existingValues) {
        map[v.fieldId] = v.value;
      }
      setValues(map);
    }
  }, [existingValues]);

  // Notify parent on every change
  useEffect(() => {
    onChange?.(values);
  }, [values]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeFields = fields?.filter((f: Doc<"orgCustomFields">) => f.isActive) ?? [];
  // SCRUM-790: the backend refuses a value write without the matching edit
  // permission, so a caller who cannot edit never sees inputs whose typed values
  // would be lost to an error toast after the record is created.
  if (isLoading || !hasPermission(EDIT_PERMISSION[entityType])) return null;
  if (activeFields.length === 0) return null;

  const handleChange = (fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  };

  return (
    <div className="space-y-4">
      <Separator />
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Additional Fields
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {activeFields.map((field: Doc<"orgCustomFields">) => (
          <div key={field._id} className="space-y-1">
            <Label>
              {field.fieldName}
              {field.isRequired && <span className="text-red-500 ml-1">*</span>}
            </Label>
            {field.fieldType === "select" ? (
              <Select
                value={values[field._id] ?? ""}
                onValueChange={(v) => handleChange(field._id, v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={`Select ${field.fieldName}`} />
                </SelectTrigger>
                <SelectContent>
                  {field.options?.map((opt: string) => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                type={field.fieldType === "number" ? "number" : field.fieldType === "date" ? "date" : "text"}
                value={values[field._id] ?? ""}
                onChange={(e) => handleChange(field._id, e.target.value)}
                placeholder={field.fieldName}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Persist custom field values after saving an entity.
 * Call this once you have the entityId (after insert/update).
 */
export function useSaveCustomFieldValues() {
  const setValues = useMutation(api.orgCustomFields.setValues);

  return async (
    orgId: string,
    entityType: string,
    entityId: string,
    values: Record<string, string>
  ) => {
    const entries = Object.entries(values)
      .filter(([, v]) => v !== "")
      .map(([fieldId, value]) => ({ fieldId: fieldId as Id<"orgCustomFields">, value }));

    if (entries.length === 0) return;

    try {
      await setValues({
        orgId: orgId as Id<"organizations">,
        entityType,
        entityId,
        values: entries,
      });
    } catch (err) {
      toast.error(err);
    }
  };
}
