"use client";

/**
 * Aliases of one supplier: list (active and retired), add, retire. An alias helps find a supplier
 * and spot duplicates; it never replaces the display name and is never matched into money paths.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { interpolate } from "@/lib/i18n/interpolate";
import { describeSupplierError } from "../useSupplierCreateFlow";
import { useTranslate } from "./shared";

export interface AliasRow {
  _id: Id<"supplierAliases">;
  alias: string;
  status: "ACTIVE" | "RETIRED";
}

export function SupplierAliasesSection({
  orgId,
  supplierId,
  aliases,
  canManage,
}: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers">; aliases: AliasRow[]; canManage: boolean }>) {
  const translate = useTranslate();
  const addAlias = useMutation(api.suppliers.addAlias);
  const retireAlias = useMutation(api.suppliers.retireAlias);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await action();
      toast.success(translate(success));
      return true;
    } catch (caught) {
      setError(describeSupplierError(caught, translate));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="supplier-aliases-title" className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 id="supplier-aliases-title" className="text-lg font-semibold">
          {translate("SuppliersAliasesTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{translate("SuppliersAliasesHint")}</p>
      </div>
      {aliases.length === 0 ? (
        <p className="text-sm text-muted-foreground">{translate("SuppliersAliasEmpty")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {aliases.map((alias) => (
            <li key={alias._id} className="flex items-center justify-between gap-3 p-2.5">
              <span className={alias.status === "RETIRED" ? "text-sm text-muted-foreground line-through" : "text-sm"}>
                <bdi>{alias.alias}</bdi>
              </span>
              {alias.status === "RETIRED" ? (
                <Badge variant="secondary">{translate("SuppliersAliasRetired")}</Badge>
              ) : (
                canManage && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    aria-label={interpolate(translate("SuppliersAliasRetireLabel"), { alias: alias.alias })}
                    onClick={() => void run(() => retireAlias({ orgId, aliasId: alias._id }), "SuppliersAliasRetiredToast")}
                  >
                    {translate("SuppliersAliasRetire")}
                  </Button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() === "") return;
            void run(() => addAlias({ orgId, supplierId, alias: text.trim() }), "SuppliersAliasAdded").then((ok) => {
              if (ok) setText("");
            });
          }}
        >
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="supplier-alias-new">{translate("SuppliersAliasLabel")}</Label>
            <Input id="supplier-alias-new" value={text} onChange={(e) => setText(e.target.value)} maxLength={200} disabled={busy} />
          </div>
          <Button type="submit" disabled={busy || text.trim() === ""}>
            {translate("SuppliersAliasAdd")}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
