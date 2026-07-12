"use client";

import { useState, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id, Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { toast } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useLanguage } from "@/components/providers/LanguageProvider";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Upload, X, Search, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";

import { vehicleSchema, VehicleFormValues, VehicleDialogProps } from "./vehicle.schema";
import { CustomFieldsSection, useSaveCustomFieldValues } from "@/components/custom-fields/CustomFieldsSection";
import { decodeVinYear, toCarBrand, cleanMfrName, validateVinChecksum } from "@/lib/vinHelpers";

export function VehicleDialog({ open, onOpenChange, vehicle, canCreate = false, canEdit = false }: VehicleDialogProps) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const createVehicle = useMutation(api.vehicles.create);
  const updateVehicle = useMutation(api.vehicles.update);
  const requestCreate = useMutation(api.vehicleEdits.requestCreate);
  const requestUpdate = useMutation(api.vehicleEdits.requestUpdate);
  const generateUploadUrl = useMutation(api.vehicles.generateUploadUrl);
  const deleteImage = useMutation(api.vehicles.deleteImage);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isDecoding, setIsDecoding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageIds, setImageIds] = useState<string[]>([]);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>({});
  const saveCustomFields = useSaveCustomFieldValues();

  const form = useForm<z.infer<typeof vehicleSchema>>({
    resolver: zodResolver(vehicleSchema as any),
    defaultValues: {
      vin: "",
      make: "",
      model: "",
      year: new Date().getFullYear(),
      trim: "",
      mileage: 0,
      color: "",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 0,
      purchasePaymentMethod: undefined,
      minimumProfit: 0,
      sellingPrice: 0,
      status: "AVAILABLE",
      sourceType: "STOCK",
      sourcedFromName: "",
      sourceCost: 0,
      notes: "",
      imageIds: [],
      inspectionStatus: "NONE",
      accidentDisclosed: undefined,
      ownerCount: undefined,
      dealerGuarantee: false,
    },
  });

  useEffect(() => {
    if (vehicle && open) {
      form.reset({
        vin: vehicle.vin,
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year,
        trim: vehicle.trim || "",
        mileage: vehicle.mileage,
        color: vehicle.color,
        fuelType: vehicle.fuelType,
        transmission: vehicle.transmission,
        purchasePrice: vehicle.purchasePrice,
        minimumProfit: vehicle.minimumProfit,
        sellingPrice: vehicle.sellingPrice,
        status: vehicle.status,
        sourceType: (vehicle as any).sourceType ?? "STOCK",
        sourcedFromName: (vehicle as any).sourcedFromName ?? "",
        sourceCost: (vehicle as any).sourceCost ?? 0,
        notes: vehicle.notes || "",
        imageIds: vehicle.imageIds || [],
        inspectionStatus: (vehicle as any).inspectionStatus ?? "NONE",
        accidentDisclosed: (vehicle as any).accidentDisclosed,
        ownerCount: (vehicle as any).ownerCount,
        dealerGuarantee: (vehicle as any).dealerGuarantee ?? false,
      });
      setImageIds(vehicle.imageIds || []);
      setImageUrls((vehicle as any).imageUrls || []);
    } else if (open && !vehicle) {
      form.reset({
        vin: "",
        make: "",
        model: "",
        year: new Date().getFullYear(),
        trim: "",
        mileage: 0,
        color: "",
        fuelType: "Gasoline",
        transmission: "Automatic",
        purchasePrice: 0,
        purchasePaymentMethod: undefined,
        minimumProfit: 0,
        sellingPrice: 0,
        status: "AVAILABLE",
        sourceType: "STOCK",
        sourcedFromName: "",
        sourceCost: 0,
        notes: "",
        imageIds: [],
        inspectionStatus: "NONE",
        accidentDisclosed: undefined,
        ownerCount: undefined,
        dealerGuarantee: false,
      });
      setImageIds([]);
      setImageUrls([]);
    }
  }, [vehicle, open, form]);

  // Soft, non-blocking ISO 3779 check-digit warning — many non-North-American
  // VINs legitimately fail this, so it must never block submission.
  const watchedVin = form.watch("vin");
  const watchedSourceType = form.watch("sourceType");
  const isSourced = watchedSourceType === "SOURCED";
  const showVinChecksumWarning = (watchedVin?.length ?? 0) === 17 && !validateVinChecksum(watchedVin ?? "");

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !activeOrgId) return;

    setIsUploading(true);
    try {
      const newImageIds = [...imageIds];
      const newImageUrls = [...imageUrls];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const postUrl = await generateUploadUrl({
          orgId: activeOrgId,
          mimeType: file.type,
          sizeInBytes: file.size
        });
        const result = await fetch(postUrl, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        const { storageId } = await result.json();
        newImageIds.push(storageId);
        newImageUrls.push(URL.createObjectURL(file));
      }

      setImageIds(newImageIds);
      setImageUrls(newImageUrls);
      form.setValue("imageIds", newImageIds);
    } catch (error) {
      toast.error(t("FailedToUploadImage" as any));
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDecodeVIN = async () => {
    const rawVin = form.getValues("vin") ?? "";
    const vin = rawVin.trim().toUpperCase();
    if (vin !== rawVin) form.setValue("vin", vin);

    if (!vin || vin.length !== 17) {
      toast.error(t("InvalidVIN" as any) || "Please enter a valid 17-character VIN");
      return;
    }

    setIsDecoding(true);
    try {
      const [vinResult, wmiResult] = await Promise.allSettled([
        fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`).then(r => r.json()),
        fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeWMI/${vin.slice(0, 3)}?format=json`).then(r => r.json()),
      ]);

      const v = vinResult.status === "fulfilled" ? (vinResult.value.Results?.[0] ?? {}) : {};
      const wmiName = wmiResult.status === "fulfilled" ? (wmiResult.value.Results?.[0]?.Name ?? "") : "";

      const makeFromWmi = wmiName ? toCarBrand(cleanMfrName(wmiName)) : "";
      const makeFromVin = v.Make ? toCarBrand(v.Make.trim()) : "";
      const make = makeFromWmi || makeFromVin;

      const model   = (v.Model || v.Series || "").trim();
      const trim    = v.Trim?.trim() ?? "";
      const fuelRaw = v.FuelTypePrimary?.toLowerCase() ?? "";

      const nhtsaYear = v.ModelYear ? parseInt(v.ModelYear) : NaN;
      const year = !isNaN(nhtsaYear) ? nhtsaYear : (decodeVinYear(vin[9]) ?? undefined);

      if (make)  form.setValue("make",  make);
      if (model) form.setValue("model", toCarBrand(model));
      if (year)  form.setValue("year",  year);
      if (trim)  form.setValue("trim",  trim);

      if (fuelRaw.includes("gasoline") || fuelRaw.includes("petrol")) form.setValue("fuelType", "Gasoline");
      else if (fuelRaw.includes("diesel"))   form.setValue("fuelType", "Diesel");
      else if (fuelRaw.includes("electric")) form.setValue("fuelType", "Electric");
      else if (fuelRaw.includes("hybrid"))   form.setValue("fuelType", "Hybrid");

      if (!make) {
        toast.error(t("NoDataForVIN" as any) || "Could not identify this VIN — please fill in details manually.");
      } else if (!model) {
        toast.warning("Manufacturer identified — model not found, please enter it manually.");
      } else {
        toast.success(t("VINDecodedSuccessfully" as any) || "VIN decoded successfully!");
      }
    } catch {
      toast.error(t("FailedToDecodeVIN" as any));
    } finally {
      setIsDecoding(false);
    }
  };

  const handleRemoveImage = async (index: number) => {
    const storageId = imageIds[index];
    const newImageIds = [...imageIds];
    const newImageUrls = [...imageUrls];
    newImageIds.splice(index, 1);
    newImageUrls.splice(index, 1);
    setImageIds(newImageIds);
    setImageUrls(newImageUrls);
    form.setValue("imageIds", newImageIds);

    if (vehicle && activeOrgId) {
      try {
        await deleteImage({ orgId: activeOrgId, vehicleId: vehicle._id, storageId: storageId as Id<"_storage"> });
      } catch (err) {
        console.error("Failed to delete image from server", err);
      }
    }
  };

  const onSubmit = async (values: VehicleFormValues) => {
    if (!activeOrgId) return;

    // Only relevant when creating a new vehicle — update()/requestUpdate()
    // don't accept this field at all (purchasePrice locks once GL-posted).
    if (
      !vehicle &&
      values.sourceType !== "SOURCED" &&
      (values.purchasePrice ?? 0) > 0 &&
      !values.purchasePaymentMethod
    ) {
      form.setError("purchasePaymentMethod", {
        message: t("PurchasePaymentMethodRequired" as any) || "Payment method is required when a purchase price is entered",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const { imageIds: _formImageIds, inspectionStatus, purchasePaymentMethod, ...restValues } = values;
      // PARTNER_VERIFIED is display-only here (locked Select) — none of the
      // backend mutations accept it, so never resubmit it as-is.
      const trustPassportFields =
        inspectionStatus === "PARTNER_VERIFIED" ? {} : { inspectionStatus };

      if (vehicle) {
        if (canEdit) {
          await updateVehicle({
            orgId: activeOrgId,
            vehicleId: vehicle._id,
            ...restValues,
            ...trustPassportFields,
            imageIds: imageIds as Id<"_storage">[],
          });
          await saveCustomFields(activeOrgId, "vehicle", vehicle._id, customFieldValues);
          toast.success(t("VehicleUpdated" as any));
        } else {
          await requestUpdate({
            orgId: activeOrgId,
            vehicleId: vehicle._id,
            payload: {
              ...restValues,
              ...trustPassportFields,
              imageIds: imageIds as Id<"_storage">[],
            },
          });
          toast.success(t("UpdateRequestSubmitted" as any));
        }
      } else {
        if (canCreate) {
          const newId = await createVehicle({
            orgId: activeOrgId,
            ...restValues,
            purchasePaymentMethod,
            ...trustPassportFields,
            imageIds: imageIds as Id<"_storage">[],
          });
          if (newId) await saveCustomFields(activeOrgId, "vehicle", newId, customFieldValues);
          toast.success(t("VehicleAdded" as any));
        } else {
          await requestCreate({
            orgId: activeOrgId,
            payload: {
              ...restValues,
              purchasePaymentMethod,
              ...trustPassportFields,
              imageIds: imageIds as Id<"_storage">[],
            },
          });
          toast.success(t("CreationRequestSubmitted" as any));
        }
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{vehicle ? t("EditVehicle" as any) : t("AddVehicle")}</DialogTitle>
          <DialogDescription>
            {vehicle ? t("UpdateVehicleDesc" as any) || "Update vehicle details below." : t("AddVehicleDesc" as any) || "Enter the details of the new vehicle to add it to your inventory."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

            {/* Vehicle Source toggle — shown at the top so all conditional fields render correctly */}
            <FormField
              control={form.control}
              name="sourceType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("VehicleSource" as any)}</FormLabel>
                  <FormControl>
                    <div className="flex rounded-md border overflow-hidden">
                      {(["STOCK", "SOURCED"] as const).map((type) => (
                        <button
                          key={type}
                          type="button"
                          onClick={() => {
                            field.onChange(type);
                            if (type === "SOURCED") {
                              form.setValue("status", "SOURCING");
                            } else if (form.getValues("status") === "SOURCING") {
                              form.setValue("status", "AVAILABLE");
                            }
                          }}
                          className={`flex-1 py-2 text-sm font-medium transition-colors ${
                            field.value === type
                              ? "bg-primary text-primary-foreground"
                              : "bg-background text-muted-foreground hover:bg-muted"
                          }`}
                        >
                          {type === "STOCK" ? t("OwnedStock" as any) : t("SourcedFromDealer" as any)}
                        </button>
                      ))}
                    </div>
                  </FormControl>
                  {isSourced && (
                    <p className="text-xs text-muted-foreground">
                      {t("SourcedVehicleHint" as any)}
                    </p>
                  )}
                </FormItem>
              )}
            />

            {/* Sourced-only fields */}
            {isSourced && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 rounded-lg border border-orange-200 bg-orange-50 dark:bg-orange-950/20">
                <FormField
                  control={form.control}
                  name="sourcedFromName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("SourceDealerName" as any)} *</FormLabel>
                      <FormControl>
                        <Input placeholder={t("SourceDealerPlaceholder" as any)} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="sourceCost"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("SupplierCost" as any)} *</FormLabel>
                      <FormControl>
                        <Input type="number" min="0" step="0.01" {...field} onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="vin"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("VIN" as any)}{isSourced ? ` (${t("OptionalForSourced" as any)})` : ""}</FormLabel>
                    <FormControl>
                      <div className="flex gap-2">
                        <Input placeholder={isSourced ? t("VinSourcedPlaceholder" as any) : "17-character VIN"} {...field} />
                        {!isSourced && (
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={handleDecodeVIN}
                            disabled={isDecoding || (field.value?.length ?? 0) !== 17}
                            className="shrink-0"
                          >
                            {isDecoding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4 me-2" />}
                            {t("Decode" as any) || "Decode"}
                          </Button>
                        )}
                      </div>
                    </FormControl>
                    {showVinChecksumWarning && (
                      <p className="text-xs text-amber-700">
                        {t("VinChecksumWarning" as any) || "This VIN's check digit doesn't match — common for non-North-American vehicles, please double-check."}
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Status" as any)}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t("SelectStatus" as any)} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {!isSourced && <SelectItem value="AVAILABLE">{t("StatusAvailable" as any)}</SelectItem>}
                        {isSourced && <SelectItem value="SOURCING">{t("StatusSourcing" as any)}</SelectItem>}
                        <SelectItem value="IN_INSPECTION">{t("StatusInInspection" as any)}</SelectItem>
                        <SelectItem value="IN_REPAIR">{t("StatusInRepair" as any)}</SelectItem>
                        <SelectItem value="RESERVED">{t("StatusReserved" as any)}</SelectItem>
                        <SelectItem value="SOLD">{t("StatusSold" as any)}</SelectItem>
                        <SelectItem value="ARCHIVED">{t("StatusArchived" as any)}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="make"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Make" as any) || "Make"}</FormLabel>
                    <FormControl>
                      <Input placeholder="Toyota" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="model"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Model" as any) || "Model"}</FormLabel>
                    <FormControl>
                      <Input placeholder="Camry" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="year"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Year" as any)}</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="trim"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Trim" as any) || "Trim"}</FormLabel>
                    <FormControl>
                      <Input placeholder="SE" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="color"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Color" as any) || "Color"}</FormLabel>
                    <FormControl>
                      <Input placeholder="Silver" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="mileage"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Mileage" as any) || "Mileage"}</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="fuelType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("FuelType" as any) || "Fuel Type"}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select fuel type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="Gasoline">Gasoline</SelectItem>
                        <SelectItem value="Diesel">Diesel</SelectItem>
                        <SelectItem value="Hybrid">Hybrid</SelectItem>
                        <SelectItem value="Electric">Electric</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="transmission"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("Transmission" as any) || "Transmission"}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select transmission" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="Automatic">Automatic</SelectItem>
                        <SelectItem value="Manual">Manual</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {/* For owned vehicles, show purchasePrice directly; for sourced, sourceCost is used (shown in the sourcing section above). */}
              {!isSourced && (
                <FormField
                  control={form.control}
                  name="purchasePrice"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("PurchasePrice" as any) || "Purchase Price"} (JOD)</FormLabel>
                      <FormControl>
                        <Input type="number" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              {/* Only meaningful at creation — drives the one-time acquisition GL
                  posting; editing an existing vehicle's purchasePrice (before it's
                  posted) doesn't repost anything, so there's nothing for this to drive. */}
              {!isSourced && !vehicle && (
                <FormField
                  control={form.control}
                  name="purchasePaymentMethod"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("PaymentMethodLabel" as any)}</FormLabel>
                      <FormControl>
                        <PaymentMethodSelect
                          t={t as any}
                          value={field.value as PaymentMethod}
                          onValueChange={field.onChange}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name="minimumProfit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("MinimumProfit" as any) || "Minimum Profit Requirement"} (JOD)</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="sellingPrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("SellingPrice" as any) || "Selling Price"} (JOD)</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>{t("Notes" as any)}</FormLabel>
                    <FormControl>
                      <Input placeholder="Additional information..." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-4 rounded-lg border p-4">
              <div>
                <h4 className="text-sm font-medium">{t("TrustPassport" as any) || "Trust Passport"}</h4>
                <p className="text-xs text-muted-foreground">
                  {t("TrustPassportDesc" as any) || "Optional disclosures shown to marketplace buyers."}
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="inspectionStatus"
                  render={({ field }) => {
                    const isLocked = field.value === "PARTNER_VERIFIED";
                    return (
                      <FormItem>
                        <FormLabel>{t("InspectionStatus" as any) || "Inspection Status"}</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value ?? "NONE"} disabled={isLocked}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="NONE">{t("InspectionStatusNone" as any) || "Not disclosed"}</SelectItem>
                            <SelectItem value="SELF_REPORTED">
                              {t("InspectionStatusSelfReported" as any) || "Self-reported by our team"}
                            </SelectItem>
                            {isLocked && (
                              <SelectItem value="PARTNER_VERIFIED" disabled>
                                {t("InspectionStatusPartnerVerifiedLocked" as any) || "Partner-verified (locked)"}
                              </SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                        {isLocked && (
                          <p className="text-xs text-muted-foreground">
                            {t("InspectionStatusLockedHint" as any) ||
                              "Set by AutoFlow's verification process — contact support to change."}
                          </p>
                        )}
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />
                <FormField
                  control={form.control}
                  name="accidentDisclosed"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("AccidentHistory" as any) || "Accident History"}</FormLabel>
                      <Select
                        onValueChange={(v) => field.onChange(v === "unset" ? undefined : v === "yes")}
                        value={field.value === undefined ? "unset" : field.value ? "yes" : "no"}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="unset">{t("AccidentHistoryUnset" as any) || "Not disclosed"}</SelectItem>
                          <SelectItem value="no">{t("AccidentHistoryNo" as any) || "No accidents"}</SelectItem>
                          <SelectItem value="yes">{t("AccidentHistoryYes" as any) || "Accident disclosed"}</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="ownerCount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("OwnerCount" as any) || "Number of Previous Owners"}</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(e.target.value === "" ? undefined : parseInt(e.target.value, 10))
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="dealerGuarantee"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center gap-2 space-y-0 pt-6">
                      <FormControl>
                        <Checkbox id="dealerGuarantee" checked={field.value ?? false} onCheckedChange={field.onChange} />
                      </FormControl>
                      <FormLabel htmlFor="dealerGuarantee" className="font-normal cursor-pointer">
                        {t("DealerGuarantee" as any) || "We guarantee this vehicle's condition to buyers"}
                      </FormLabel>
                    </FormItem>
                  )}
                />
              </div>
            </div>

            {activeOrgId && (
              <CustomFieldsSection
                orgId={activeOrgId}
                entityType="vehicle"
                entityId={vehicle?._id}
                onChange={setCustomFieldValues}
              />
            )}

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{t("VehicleImages" as any) || "Vehicle Images"}</label>
                <div>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    ref={fileInputRef}
                    onChange={handleUpload}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                  >
                    <Upload className="w-4 h-4 me-2" />
                    {isUploading ? t("Uploading" as any) || "Uploading..." : t("UploadImages" as any) || "Upload Images"}
                  </Button>
                </div>
              </div>

              {imageUrls.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-2">
                  {imageUrls.map((url, index) => (
                    <div key={index} className="relative group aspect-video bg-muted rounded-md overflow-hidden border">
                      <img src={url} alt={`Vehicle ${index + 1}`} className="object-cover w-full h-full" />
                      <button
                        type="button"
                        onClick={() => handleRemoveImage(index)}
                        className="absolute top-1 right-1 bg-black/50 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="border-2 border-dashed rounded-lg p-8 text-center text-muted-foreground bg-muted/20">
                  <Upload className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>{t("NoImages" as any) || "No images uploaded yet"}</p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? t("Saving" as any) || "Saving..."
                  : vehicle
                    ? (canEdit ? t("SaveChanges" as any) || "Save Changes" : t("SubmitForApproval" as any) || "Submit for Approval")
                    : (canCreate ? t("AddVehicle" as any) : t("SubmitForApproval" as any) || "Submit for Approval")}
              </Button>
            </div>

            {vehicle && (vehicle.addedBy || vehicle.updatedBy) && (
              <div className="pt-4 border-t mt-6">
                <AuditLog addedBy={vehicle.addedBy} updatedBy={vehicle.updatedBy} updatedAt={vehicle.updatedAt} />
              </div>
            )}
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function AuditLog({ addedBy, updatedBy, updatedAt }: { addedBy?: Id<"users">, updatedBy?: Id<"users">, updatedAt?: number }) {
  const addedByUser = useQuery(api.users.getUser, addedBy ? { userId: addedBy } : "skip");
  const updatedByUser = useQuery(api.users.getUser, updatedBy ? { userId: updatedBy } : "skip");
  const { t } = useLanguage();

  const rtf = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="text-xs text-muted-foreground flex flex-col gap-1 bg-muted/30 p-3 rounded-md">
      <h4 className="font-semibold text-foreground mb-1">{t("AuditTrail" as any) || "Audit Trail"}</h4>
      {addedBy && (
        <p>
          <span className="font-medium">{t("AddedBy" as any) || "Added by:"}</span> {addedByUser === undefined ? t("Loading" as any) || "Loading..." : addedByUser?.name || "Unknown User"}
        </p>
      )}
      {updatedBy && updatedAt && (
        <p>
          <span className="font-medium">{t("LastUpdatedBy" as any) || "Last updated by:"}</span> {updatedByUser === undefined ? t("Loading" as any) || "Loading..." : updatedByUser?.name || "Unknown User"}
          {" "}{t("On" as any) || "on"} {rtf.format(new Date(updatedAt))}
        </p>
      )}
    </div>
  );
}
