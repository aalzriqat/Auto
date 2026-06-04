"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomerDialog } from "@/components/customers/CustomerDialog";
import { Doc } from "@/convex/_generated/dataModel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Search, Pencil, Trash2, Mail, Phone } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export default function CustomersPage() {
  const { activeOrgId } = useOrg();
  const customers = useQuery(api.customers.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const removeCustomer = useMutation(api.customers.remove);

  const [searchQuery, setSearchQuery] = useState("");
  const [isCustomerDialogOpen, setIsCustomerDialogOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Doc<"customers"> | null>(null);
  
  const [customerToDelete, setCustomerToDelete] = useState<Doc<"customers"> | null>(null);

  const filteredCustomers = customers?.filter(c => {
    const fullName = `${c.firstName} ${c.lastName}`.toLowerCase();
    const q = searchQuery.toLowerCase();
    return fullName.includes(q) || 
           (c.email && c.email.toLowerCase().includes(q)) ||
           (c.phone && c.phone.includes(q));
  });

  const handleEdit = (customer: Doc<"customers">) => {
    setEditingCustomer(customer);
    setIsCustomerDialogOpen(true);
  };

  const handleAddNew = () => {
    setEditingCustomer(null);
    setIsCustomerDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!activeOrgId || !customerToDelete) return;
    try {
      await removeCustomer({ orgId: activeOrgId, customerId: customerToDelete._id });
      toast.success("Customer removed successfully");
      setCustomerToDelete(null);
    } catch (error: any) {
      toast.error(error.message || "Failed to remove customer");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Customers</h2>
          <p className="text-muted-foreground">
            Manage your dealership's customers and their contact information.
          </p>
        </div>
        <Button onClick={handleAddNew}>
          <Plus className="me-2 h-4 w-4" /> Add Customer
        </Button>
      </div>

      <div className="flex items-center w-full max-w-sm space-x-2">
        <Search className="h-4 w-4 text-muted-foreground absolute ms-3" />
        <Input
          placeholder="Search by name, email, phone..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="ps-9"
        />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>National ID</TableHead>
              <TableHead className="text-end">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredCustomers === undefined ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                  Loading customers...
                </TableCell>
              </TableRow>
            ) : filteredCustomers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                  No customers found.
                </TableCell>
              </TableRow>
            ) : (
              filteredCustomers.map((customer) => (
                <TableRow key={customer._id}>
                  <TableCell className="font-medium">
                    {customer.firstName} {customer.lastName}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                      {customer.email && (
                        <div className="flex items-center gap-1">
                          <Mail className="h-3 w-3" /> {customer.email}
                        </div>
                      )}
                      {(customer.phone || customer.whatsapp) && (
                        <div className="flex items-center gap-1">
                          <Phone className="h-3 w-3" /> {customer.phone || customer.whatsapp}
                        </div>
                      )}
                      {!customer.email && !customer.phone && !customer.whatsapp && (
                        <span className="italic text-xs">No contact info</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {customer.nationalId || <span className="text-muted-foreground italic">N/A</span>}
                  </TableCell>
                  <TableCell className="text-end">
                    <Button variant="ghost" size="icon" onClick={() => handleEdit(customer)}>
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setCustomerToDelete(customer)}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <CustomerDialog
        open={isCustomerDialogOpen}
        onOpenChange={setIsCustomerDialogOpen}
        customer={editingCustomer}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!customerToDelete} onOpenChange={(open) => !open && setCustomerToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Customer</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove {customerToDelete?.firstName} {customerToDelete?.lastName}? 
              This action cannot be undone. If they have associated sales or leads, this will fail.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomerToDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
