"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { getCodedErrorMessage } from "@/lib/errors";

type Account = Doc<"chartOfAccounts">;
const ACCOUNT_TYPES = [
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "COGS",
  "EXPENSE",
  "OTHER_INCOME",
  "OTHER_EXPENSE",
] as const satisfies readonly Account["type"][];
const BALANCES = ["DEBIT", "CREDIT"] as const;

/** Mounted only while open, matching SupplierCreateDialog so reopening resets unsaved fields. */
export function ChartOfAccountsDialog({
  orgId,
  account,
  onClose,
  onCloseAutoFocus,
}: Readonly<{
  orgId: Id<"organizations">;
  account?: Account;
  onClose: () => void;
  onCloseAutoFocus: (event: Event) => void;
}>) {
  const { t, isRtl } = useLanguage();
  const createAccount = useMutation(api.chartOfAccounts.create);
  const updateAccount = useMutation(api.chartOfAccounts.update);
  const [code, setCode] = useState(account?.code ?? "");
  const [name, setName] = useState(account?.name ?? "");
  const [nameAr, setNameAr] = useState(account?.nameAr ?? "");
  const [type, setType] = useState<Account["type"]>(account?.type ?? "ASSET");
  const [normalBalance, setNormalBalance] = useState<Account["normalBalance"]>(
    account?.normalBalance ?? "DEBIT",
  );
  const [active, setActive] = useState(account?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (account)
        await updateAccount({
          orgId,
          accountId: account._id,
          name,
          nameAr,
          ...(active !== account.active ? { active } : {}),
        });
      else
        await createAccount({ orgId, code, name, nameAr, type, normalBalance });
      toast.success(t("CoaSaved"));
      onClose();
    } catch (cause) {
      setError(getCodedErrorMessage(cause, t) ?? t("CoaSaveError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="text-start">
          <DialogTitle>{t(account ? "CoaEdit" : "CoaCreate")}</DialogTitle>
          <DialogDescription>
            {t(account ? "CoaImmutable" : "CoaDescription")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="coa-code">{t("CoaCode")}</Label>
            <Input
              id="coa-code"
              required={!account}
              dir="ltr"
              value={code}
              disabled={busy || !!account}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="coa-name">{t("CoaNameEn")}</Label>
            <Input
              id="coa-name"
              required
              dir="ltr"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="coa-name-ar">{t("CoaNameAr")}</Label>
            <Input
              id="coa-name-ar"
              dir="rtl"
              value={nameAr}
              disabled={busy}
              onChange={(event) => setNameAr(event.target.value)}
            />
          </div>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <Label htmlFor="coa-type">{t("CoaType")}</Label>
              <Select
                dir={isRtl ? "rtl" : "ltr"}
                value={type}
                disabled={busy || !!account}
                onValueChange={(next) => {
                  const choice = ACCOUNT_TYPES.find((entry) => entry === next);
                  if (choice) setType(choice);
                }}
              >
                <SelectTrigger id="coa-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {t(`CoaType_${entry}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 space-y-2">
              <Label htmlFor="coa-balance">{t("CoaNormalBalance")}</Label>
              <Select
                dir={isRtl ? "rtl" : "ltr"}
                value={normalBalance}
                disabled={busy || !!account}
                onValueChange={(next) => {
                  const choice = BALANCES.find((entry) => entry === next);
                  if (choice) setNormalBalance(choice);
                }}
              >
                <SelectTrigger id="coa-balance">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BALANCES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {t(`CoaBalance_${entry}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {account && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <Switch
                  id="coa-active"
                  checked={active}
                  disabled={busy || (!!account.systemKey && account.active)}
                  onCheckedChange={setActive}
                />
                <Label htmlFor="coa-active">{t("CoaActive")}</Label>
              </div>
              {account.systemKey && (
                <p className="text-sm text-muted-foreground">
                  {t("CoaSystemActive")}
                </p>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              {t("CoaCancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {t(busy ? "CoaSaving" : "CoaSave")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
