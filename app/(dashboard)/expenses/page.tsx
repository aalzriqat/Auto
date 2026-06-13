"use client";

import { useState } from "react";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
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
import { toast } from "@/components/ui/sonner";
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
  const { t } = useLanguage();
  const { results: expenses } = usePaginatedQuery(api.expenses.list, activeOrgId ? { orgId: activeOrgId } : "skip", { initialNumItems: 100 });
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
      toast.success(t("ExpenseDeletedSuccess" as any));
      setExpenseToDelete(null);
    } catch (error: any) {
      toast.error(error.message || t("ExpenseDeleteFail" as any));
    }
  };

  const getCategoryBadge = (category: string) => {
    switch (category) {
      case "REPAIR": return <Badge variant="destructive">{t("Repair" as any)}</Badge>;
      case "MAINTENANCE": return <Badge variant="secondary" className="bg-blue-500/20 text-blue-600 hover:bg-blue-500/30">{t("Maintenance" as any)}</Badge>;
      case "DETAILING": return <Badge variant="secondary" className="bg-cyan-500/20 text-cyan-600 hover:bg-cyan-500/30">{t("Detailing" as any)}</Badge>;
      default: return <Badge variant="outline">{t(category as any)}</Badge>;
    }
  };

  return (
    <RoleGuard permissions={["view:expenses"]}>
      <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-4">
        <Button onClick={handleAddNew}>
          <Plus className="me-2 h-4 w-4" /> {t("RecordExpense" as any)}
        </Button>
      </div>

      <div className="flex items-center w-full max-w-sm space-x-2">
        <Search className="h-4 w-4 text-muted-foreground absolute ms-3" />
        <Input
          placeholder={t("SearchExpenses" as any)}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="ps-9"
        />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Date" as any)}</TableHead>
              <TableHead>{t("Title" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead>{t("Category" as any)}</TableHead>
              <TableHead>{t("Vendor" as any)}</TableHead>
              <TableHead>{t("PaidBy" as any)}</TableHead>
              <TableHead>{t("LinkedVehicle" as any)}</TableHead>
              <TableHead className="text-end">{t("Amount" as any)}</TableHead>
              <TableHead className="text-end">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredExpenses === undefined ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  {t("LoadingExpenses" as any)}
                </TableCell>
              </TableRow>
            ) : filteredExpenses.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  {t("NoExpensesFound" as any)}
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
                      <Badge className="bg-green-100 text-green-800 hover:bg-green-100">{t("Paid" as any)}</Badge>
                    ) : (
                      <Badge variant="outline" className="bg-yellow-100 text-yellow-800 hover:bg-yellow-100 border-yellow-200">{t("Pending" as any)}</Badge>
                    )}
                  </TableCell>
                  <TableCell>{getCategoryBadge(expense.category)}</TableCell>
                  <TableCell>{expense.vendor || <span className="text-muted-foreground italic">{t("NA" as any)}</span>}</TableCell>
                  <TableCell>{expense.payerName || <span className="text-muted-foreground italic">{t("Unassigned" as any)}</span>}</TableCell>
                  <TableCell>
                    {expense.vehicleSummary ? (
                      <span className="text-sm">{expense.vehicleSummary}</span>
                    ) : (
                      <span className="text-sm text-muted-foreground italic">{t("GeneralExpense" as any)}</span>
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
            <DialogTitle>{t("DeleteExpense" as any)}</DialogTitle>
            <DialogDescription>
              {t("DeleteExpenseDesc" as any)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExpenseToDelete(null)}>{t("Cancel" as any)}</Button>
            <Button variant="destructive" onClick={handleDelete}>{t("DeletePermanently" as any)}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </RoleGuard>
  );
}
