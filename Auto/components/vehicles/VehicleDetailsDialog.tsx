import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Doc } from "@/convex/_generated/dataModel";
import { Separator } from "@/components/ui/separator";

interface VehicleDetailsDialogProps {
  vehicle: Doc<"vehicles"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canViewPurchasePrice: boolean;
}

export function VehicleDetailsDialog({
  vehicle,
  open,
  onOpenChange,
  canViewPurchasePrice,
}: VehicleDetailsDialogProps) {
  if (!vehicle) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-xl">
            {vehicle.year} {vehicle.make} {vehicle.model}
          </DialogTitle>
          <DialogDescription>
            Detailed information about this vehicle.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-4">
          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">VIN</span>
            <p className="font-mono text-sm font-semibold bg-muted px-2 py-1 rounded inline-block">{vehicle.vin}</p>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Status</span>
            <p className="text-sm font-semibold">{vehicle.status}</p>
          </div>

          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Make</span>
            <p className="text-sm">{vehicle.make}</p>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Model</span>
            <p className="text-sm">{vehicle.model}</p>
          </div>

          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Year</span>
            <p className="text-sm">{vehicle.year}</p>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Trim</span>
            <p className="text-sm">{vehicle.trim || "N/A"}</p>
          </div>

          <div className="col-span-2">
            <Separator className="my-2" />
          </div>

          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Color</span>
            <p className="text-sm">{vehicle.color}</p>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Mileage</span>
            <p className="text-sm">{vehicle.mileage.toLocaleString()} miles</p>
          </div>

          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Transmission</span>
            <p className="text-sm">{vehicle.transmission}</p>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Fuel Type</span>
            <p className="text-sm">{vehicle.fuelType}</p>
          </div>

          <div className="col-span-2">
            <Separator className="my-2" />
          </div>

          <div className="space-y-1">
            <span className="text-sm font-medium text-muted-foreground">Selling Price</span>
            <p className="text-sm font-bold text-green-500">${vehicle.sellingPrice.toLocaleString()}</p>
          </div>
          {canViewPurchasePrice && vehicle.purchasePrice !== undefined && (
            <div className="space-y-1">
              <span className="text-sm font-medium text-muted-foreground">Purchase Price</span>
              <p className="text-sm font-medium">${vehicle.purchasePrice.toLocaleString()}</p>
            </div>
          )}

          {vehicle.notes && (
            <div className="col-span-2 space-y-1 mt-2 bg-muted/50 p-3 rounded-lg border">
              <span className="text-sm font-medium text-muted-foreground block mb-1">Notes</span>
              <p className="text-sm whitespace-pre-wrap">{vehicle.notes}</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
