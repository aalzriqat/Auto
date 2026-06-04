"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VehicleDialog } from "@/components/vehicles/VehicleDialog";
import { Doc, Id } from "@/convex/_generated/dataModel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "AVAILABLE":
      return <Badge variant="default" className="bg-green-600">Available</Badge>;
    case "RESERVED":
      return <Badge variant="secondary" className="bg-yellow-500 text-white">Reserved</Badge>;
    case "SOLD":
      return <Badge variant="secondary" className="bg-blue-600 text-white">Sold</Badge>;
    case "IN_INSPECTION":
      return <Badge variant="outline" className="text-orange-500 border-orange-500">Inspection</Badge>;
    case "IN_REPAIR":
      return <Badge variant="outline" className="text-red-500 border-red-500">Repair</Badge>;
    case "ARCHIVED":
      return <Badge variant="secondary">Archived</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function VehiclesPage() {
  const { activeOrgId } = useOrg();
  const vehicles = useQuery(api.vehicles.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const removeVehicle = useMutation(api.vehicles.remove);

  const [searchQuery, setSearchQuery] = useState("");
  const [isVehicleDialogOpen, setIsVehicleDialogOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Doc<"vehicles"> | null>(null);
  
  const [vehicleToDelete, setVehicleToDelete] = useState<Doc<"vehicles"> | null>(null);

  const filteredVehicles = vehicles?.filter(v => 
    v.vin.toLowerCase().includes(searchQuery.toLowerCase()) ||
    v.make.toLowerCase().includes(searchQuery.toLowerCase()) ||
    v.model.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleEdit = (vehicle: Doc<"vehicles">) => {
    setEditingVehicle(vehicle);
    setIsVehicleDialogOpen(true);
  };

  const handleAddNew = () => {
    setEditingVehicle(null);
    setIsVehicleDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!activeOrgId || !vehicleToDelete) return;
    try {
      await removeVehicle({ orgId: activeOrgId, vehicleId: vehicleToDelete._id });
      toast.success("Vehicle removed successfully");
      setVehicleToDelete(null);
    } catch (error: any) {
      toast.error(error.message || "Failed to remove vehicle");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Inventory</h2>
          <p className="text-muted-foreground">
            Manage your dealership's vehicles.
          </p>
        </div>
        <Button onClick={handleAddNew}>
          <Plus className="mr-2 h-4 w-4" /> Add Vehicle
        </Button>
      </div>

      <div className="flex items-center w-full max-w-sm space-x-2">
        <Search className="h-4 w-4 text-muted-foreground absolute ml-3" />
        <Input
          placeholder="Search by VIN, Make, Model..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vehicle</TableHead>
              <TableHead>VIN</TableHead>
              <TableHead>Year</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredVehicles === undefined ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  Loading inventory...
                </TableCell>
              </TableRow>
            ) : filteredVehicles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No vehicles found.
                </TableCell>
              </TableRow>
            ) : (
              filteredVehicles.map((vehicle) => (
                <TableRow key={vehicle._id}>
                  <TableCell className="font-medium">
                    {vehicle.make} {vehicle.model} {vehicle.trim && <span className="text-muted-foreground text-xs ml-1">{vehicle.trim}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{vehicle.vin}</TableCell>
                  <TableCell>{vehicle.year}</TableCell>
                  <TableCell>${vehicle.sellingPrice.toLocaleString()}</TableCell>
                  <TableCell>
                    <StatusBadge status={vehicle.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => handleEdit(vehicle)}>
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setVehicleToDelete(vehicle)}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <VehicleDialog
        open={isVehicleDialogOpen}
        onOpenChange={setIsVehicleDialogOpen}
        vehicle={editingVehicle}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!vehicleToDelete} onOpenChange={(open) => !open && setVehicleToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Vehicle</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove the {vehicleToDelete?.year} {vehicleToDelete?.make} {vehicleToDelete?.model}? 
              This action cannot be undone unless it is archived.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVehicleToDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
