"use client";

import { useState, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id, Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import { Upload, X, Search, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const vehicleSchema = z.object({
  vin: z.string().min(17, "VIN must be at least 17 characters").max(17, "VIN must be exactly 17 characters"),
  make: z.string().min(1, "Make is required"),
  model: z.string().min(1, "Model is required"),
  year: z.coerce.number().min(1900).max(new Date().getFullYear() + 1),
  trim: z.string().optional(),
  mileage: z.coerce.number().min(0, "Mileage cannot be negative"),
  color: z.string().min(1, "Color is required"),
  fuelType: z.string().min(1, "Fuel Type is required"),
  transmission: z.string().min(1, "Transmission is required"),
  purchasePrice: z.coerce.number().min(0).optional(),
  sellingPrice: z.coerce.number().min(0),
  status: z.enum(["AVAILABLE", "RESERVED", "SOLD", "IN_INSPECTION", "IN_REPAIR", "ARCHIVED"]).optional(),
  notes: z.string().optional(),
  imageIds: z.array(z.string()).optional(),
});

type VehicleFormValues = z.infer<typeof vehicleSchema>;

interface VehicleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vehicle?: Doc<"vehicles"> | null;
  canCreate?: boolean;
  canEdit?: boolean;
}

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
      sellingPrice: 0,
      status: "AVAILABLE",
      notes: "",
      imageIds: [],
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
        purchasePrice: vehicle.purchasePrice || 0,
        sellingPrice: vehicle.sellingPrice,
        status: vehicle.status,
        notes: vehicle.notes || "",
        imageIds: vehicle.imageIds || [],
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
        sellingPrice: 0,
        status: "AVAILABLE",
        notes: "",
        imageIds: [],
      });
      setImageIds([]);
      setImageUrls([]);
    }
  }, [vehicle, open, form]);

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
      toast.error("Failed to upload image");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDecodeVIN = async () => {
    const rawVin = form.getValues("vin");
    const vin = rawVin.trim().toUpperCase();

    // Update the form with the cleaned VIN
    if (vin !== rawVin) {
      form.setValue("vin", vin);
    }

    if (!vin || vin.length !== 17) {
      toast.error(t("InvalidVIN" as any) || "Please enter a valid 17-character VIN");
      return;
    }

    setIsDecoding(true);
    try {
      const response = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`);
      const data = await response.json();

      if (data.Results && data.Results.length > 0) {
        const result = data.Results[0];

        // NHTSA returns "0" or "0 - ..." for success
        // Many valid international VINs fail the check digit test (ErrorCode 1, 5, 14, etc.)
        // We shouldn't show a scary error if we still managed to decode the Make
        if (result.Make) {
          toast.success(t("VINDecodedSuccessfully" as any) || "VIN decoded successfully!");
          if (result.ErrorCode && result.ErrorCode !== "0" && !result.ErrorCode.startsWith("0 -")) {
            console.warn(`VIN Decode Warning: ${result.ErrorText}`);
          }
        } else if (result.ErrorCode && result.ErrorCode !== "0" && !result.ErrorCode.startsWith("0 -")) {
          toast.error(`VIN Decode Warning: ${result.ErrorText}`);
        } else {
          toast.success(t("VINDecodedSuccessfully" as any) || "VIN decoded successfully!");
        }

        if (result.Make) form.setValue("make", result.Make.charAt(0).toUpperCase() + result.Make.slice(1).toLowerCase());

        const decodedModel = result.Model || result.Series || "";
        if (decodedModel) {
          form.setValue("model", decodedModel.charAt(0).toUpperCase() + decodedModel.slice(1).toLowerCase());
        }

        if (result.ModelYear && !isNaN(parseInt(result.ModelYear))) form.setValue("year", parseInt(result.ModelYear));
        if (result.Trim) form.setValue("trim", result.Trim);

        if (result.FuelTypePrimary) {
          const fuel = result.FuelTypePrimary.toLowerCase();
          if (fuel.includes("gasoline")) form.setValue("fuelType", "Gasoline");
          else if (fuel.includes("diesel")) form.setValue("fuelType", "Diesel");
          else if (fuel.includes("electric")) form.setValue("fuelType", "Electric");
          else if (fuel.includes("hybrid")) form.setValue("fuelType", "Hybrid");
        }
      } else {
        toast.error("No data found for this VIN.");
      }
    } catch (error) {
      toast.error("Failed to decode VIN. Please try again.");
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
    setIsSubmitting(true);
    try {
      const { imageIds: _formImageIds, ...restValues } = values;

      if (vehicle) {
        if (canEdit) {
          await updateVehicle({
            orgId: activeOrgId,
            vehicleId: vehicle._id,
            ...restValues,
            imageIds: imageIds as Id<"_storage">[],
          });
          toast.success("Vehicle updated successfully");
        } else {
          await requestUpdate({
            orgId: activeOrgId,
            vehicleId: vehicle._id,
            payload: {
              ...restValues,
              imageIds: imageIds as Id<"_storage">[],
            },
          });
          toast.success("Update request submitted for approval");
        }
      } else {
        if (canCreate) {
          await createVehicle({
            orgId: activeOrgId,
            ...restValues,
            imageIds: imageIds as Id<"_storage">[],
          });
          toast.success("Vehicle added successfully");
        } else {
          await requestCreate({
            orgId: activeOrgId,
            payload: {
              ...restValues,
              imageIds: imageIds as Id<"_storage">[],
            },
          });
          toast.success("Creation request submitted for approval");
        }
      }
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Something went wrong");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{vehicle ? t("EditVehicle" as any) : t("AddVehicle")}</DialogTitle>
          <DialogDescription>
            {vehicle ? t("UpdateVehicleDesc" as any) || "Update vehicle details below." : t("AddVehicleDesc" as any) || "Enter the details of the new vehicle to add it to your inventory."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="vin"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("VIN" as any)}</FormLabel>
                    <FormControl>
                      <div className="flex gap-2">
                        <Input placeholder="17-character VIN" {...field} />
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={handleDecodeVIN}
                          disabled={isDecoding || field.value.length !== 17}
                          className="shrink-0"
                        >
                          {isDecoding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4 me-2" />}
                          {t("Decode" as any) || "Decode"}
                        </Button>
                      </div>
                    </FormControl>
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
                        <SelectItem value="AVAILABLE">{t("AvailableLC" as any) || "Available"}</SelectItem>
                        <SelectItem value="IN_INSPECTION">{t("InInspection" as any) || "In Inspection"}</SelectItem>
                        <SelectItem value="IN_REPAIR">{t("InRepair" as any) || "In Repair"}</SelectItem>
                        <SelectItem value="RESERVED">{t("Reserved" as any) || "Reserved"}</SelectItem>
                        <SelectItem value="SOLD">{t("Sold" as any) || "Sold"}</SelectItem>
                        <SelectItem value="ARCHIVED">{t("Archived" as any) || "Archived"}</SelectItem>
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
                    <Upload className="w-4 h-4 mr-2" />
                    {isUploading ? t("Uploading" as any) || "Uploading..." : t("UploadImages" as any) || "Upload Images"}
                  </Button>
                </div>
              </div>

              {imageUrls.length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2">
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
