"use client";

import type { CostBearer } from "@/convex/utils/costBearer";
import { FormControl } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Translate = (key: any) => string;

/**
 * "Who bears this cost" picker shared by the expense and work-order dialogs
 * (SCRUM-389). Renders inside a caller's `FormItem`; the label, hint and
 * `FormMessage` stay with the caller because they differ per surface.
 */
export function CostBearerSelect({
  t,
  value,
  onValueChange,
  disabled,
  supplierDisabled,
  placeholder,
  triggerClassName,
  testId,
}: Readonly<{
  t: Translate;
  /** `""` renders the placeholder; the Select stays controlled either way. */
  value: CostBearer | "";
  onValueChange: (value: CostBearer) => void;
  disabled?: boolean;
  /** Offer SUPPLIER but refuse its selection (surfaces that cannot yet take it). */
  supplierDisabled?: boolean;
  placeholder?: string;
  triggerClassName?: string;
  testId: string;
}>) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => onValueChange(next as CostBearer)}>
      <FormControl>
        <SelectTrigger className={triggerClassName} data-testid={testId}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
      </FormControl>
      <SelectContent>
        <SelectItem value="SHOWROOM">{t("CostBearerShowroom" as any)}</SelectItem>
        <SelectItem value="SUPPLIER" disabled={supplierDisabled}>
          {t("CostBearerSupplier" as any)}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
