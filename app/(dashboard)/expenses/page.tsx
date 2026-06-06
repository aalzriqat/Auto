"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExpenseDialog } from "@/components/expenses/ExpenseDialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Search, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export default function ExpensesPage() {
  const { activeOrgId } = useOrg();
  const expenses = useQuery(api.expenses.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const removeExpense = useMutation(api.expenses.remove);

  const [searchQuery, setSearchQuery] = useState("");
  const [isExpenseDialogOpen, setIsExpenseDialogOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<any>(null);
  const [expenseToDelete, setExpenseToDelete] = useState<any>(null);

  const filteredExpenses = expenses?.filter(e => {
    const q = searchQuery.toLowerCase();
    return e.title.toLowerCase().includes(q) || 
           (e.vehicleSummary && e.vehicleSummary.toLowerCase().includes(q)) ||
           e.category.toLowerCase().includes(q);
  });

  const handleEdit = (expense: any) => {
    setEditingExpense(expense);
    setIsExpenseDialogOpen(true);
  };

  const handleAddNew = () => {
    setEditingExpense(null);
    setIsExpenseDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!activeOrgId || !expenseToDelete) return;
    try {
      await removeExpense({ orgId: activeOrgId, expenseId: expenseToDelete._id });
      toast.success("Expense deleted successfully");
      setExpenseToDelete(null);
    } catch (error: any) {
      toast.error(error.message || "Failed to delete expense");
    }
  };

  const getCategoryBadge = (category: string) => {
    switch (category) {
      case "REPAIR": return <Badge variant="destructive">Repair</Badge>;
      case "MAINTENANCE": return <Badge variant="secondary" className="bg-blue-500/20 text-blue-600 hover:bg-blue-500/30">Maintenance</Badge>;
      case "DETAILING": return <Badge variant="secondary" className="bg-cyan-500/20 text-cyan-600 hover:bg-cyan-500/30">Detailing</Badge>;
      default: return <Badge variant="outline">{category}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Expenses</h2>
          <p className="text-muted-foreground">
            Track dealership overhead and individual vehicle repair costs.
          </p>
        </div>
        <Button onClick={handleAddNew}>
          <Plus className="me-2 h-4 w-4" /> Record Expense
        </Button>
      </div>

      <div className="flex items-center w-full max-w-sm space-x-2">
        <Search className="h-4 w-4 text-muted-foreground absolute ms-3" />
        <Input
          placeholder="Search expenses..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="ps-9"
        />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Paid By</TableHead>
              <TableHead>Linked Vehicle</TableHead>
              <TableHead className="text-end">Amount</TableHead>
              <TableHead className="text-end">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredExpenses === undefined ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  Loading expenses...
                </TableCell>
              </TableRow>
            ) : filteredExpenses.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  No expenses found.
                </TableCell>
              </TableRow>
            ) : (
              filteredExpenses.map((expense) => (
                <TableRow key={expense._id}>
                  <TableCell className="font-medium">
                    {new Date(expense.date).toLocaleDateString()}
                  </TableCell>
                  <TableCell>{expense.title}</TableCell>
                  <TableCell>
                    {expense.status === "PAID" ? (
                      <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Paid</Badge>
                    ) : (
                      <Badge variant="outline" className="bg-yellow-100 text-yellow-800 hover:bg-yellow-100 border-yellow-200">Pending</Badge>
                    )}
                  </TableCell>
                  <TableCell>{getCategoryBadge(expense.category)}</TableCell>
                  <TableCell>{expense.vendor || <span className="text-muted-foreground italic">N/A</span>}</TableCell>
                  <TableCell>{expense.payerName || <span className="text-muted-foreground italic">Unassigned</span>}</TableCell>
                  <TableCell>
                    {expense.vehicleSummary ? (
                      <span className="text-sm">{expense.vehicleSummary}</span>
                    ) : (
                      <span className="text-sm text-muted-foreground italic">General Expense</span>
                    )}
                  </TableCell>
                  <TableCell className="text-end font-medium text-red-500">
                    -{expense.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} JOD
                  </TableCell>
                  <TableCell className="text-end">
                    <Button variant="ghost" size="icon" onClick={() => handleEdit(expense)}>
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setExpenseToDelete(expense)}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <ExpenseDialog
        open={isExpenseDialogOpen}
        onOpenChange={setIsExpenseDialogOpen}
        expense={editingExpense}
      />

      <Dialog open={!!expenseToDelete} onOpenChange={(open) => !open && setExpenseToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Expense</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this expense? This action cannot be undone and will affect your profit margin calculations.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExpenseToDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete Permanently</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
