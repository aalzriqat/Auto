"use client";

/**
 * SCRUM-868 P2: the supplier picker. It replaces free-text supplier entry in every pilot
 * vehicle form. The user searches the organization's supplier master by name or alias, picks
 * one, or - with MANAGE_FINANCE - adds a new one inline. The picker hands back the supplier
 * id; the SERVER resolves it and writes the name snapshot, so no name typed here is ever
 * stored on a vehicle or payable.
 *
 * The server stays the authority for every rule shown here: the inline create re-checks
 * MANAGE_FINANCE, duplicates, and the org. This component only avoids the round trip.
 *
 * Inline add is offered even when the typed text exactly matches an existing supplier: two distinct
 * suppliers may share a name, and the server's duplicate confirmation (confirmDistinctFrom) is the
 * one place that decides, so a finance user is never blocked from recording a genuinely different
 * supplier.
 */
import { Component, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { getLocalizedErrorMessage } from "@/lib/errors";
import { useSupplierCreateFlow } from "./useSupplierCreateFlow";
import { interpolate } from "@/lib/i18n/interpolate";

export interface PickedSupplier {
  id: Id<"suppliers">;
  displayName: string;
}

export interface SupplierSelectProps {
  orgId: Id<"organizations"> | null | undefined;
  /** The chosen supplier id, if any. */
  value: string | undefined;
  /** The stored display name of `value`, shown while the id is not in the current results. */
  valueLabel?: string;
  onChange: (supplier: PickedSupplier) => void;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  /** DOM id of the picker's trigger, so a `<label htmlFor>` reaches it. */
  id?: string;
  dataTestId?: string;
  className?: string;
}

interface PickerRow {
  _id: Id<"suppliers">;
  displayName: string;
  status: "ACTIVE" | "INACTIVE";
}

const LIST_PAGE_SIZE = 50;
/** A failed supplier query must not take the whole vehicle form down with it. */
class SupplierQueryBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function SupplierSelectBody({
  orgId,
  value,
  valueLabel,
  onChange,
  disabled,
  invalid,
  ariaLabel,
  id,
  dataTestId,
  className,
}: Readonly<SupplierSelectProps>) {
  const { t } = useLanguage();
  const translate = t as (key: string) => string;
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const canCreate = !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);

  const [text, setText] = useState("");
  const query = text.trim();

  const listed = useQuery(
    api.suppliers.list,
    orgId && query === ""
      ? { orgId, status: "ACTIVE", paginationOpts: { numItems: LIST_PAGE_SIZE, cursor: null } }
      : "skip",
  );
  const searched = useQuery(api.suppliers.search, orgId && query !== "" ? { orgId, query } : "skip");

  const rows: PickerRow[] | undefined = query === "" ? listed?.page : searched;
  const loading = !!orgId && rows === undefined;
  const options = (rows ?? [])
    .filter((row) => row.status === "ACTIVE")
    .map((row) => ({ value: row._id as string, label: row.displayName }));

  const flow = useSupplierCreateFlow(orgId);
  const { creating, candidates, reset: resetCreate } = flow;
  const createError = flow.error === null ? null : getLocalizedErrorMessage(flow.error, translate);

  // A new search is a new intent: drop the previous create attempt, its error and its key.
  useEffect(() => {
    resetCreate();
  }, [query, resetCreate]);

  const pick = (supplier: PickedSupplier, close: () => void) => {
    onChange(supplier);
    close();
  };

  async function submitCreate(confirmDistinctFrom: Id<"suppliers">[] | undefined, close: () => void) {
    if (creating) return;
    // The key identifies this exact request; the hook drops it after a duplicate answer, so the
    // confirmed retry (a different payload) gets a fresh one.
    const supplierId = await flow.submit({ displayName: query }, confirmDistinctFrom ? { confirmDistinctFrom } : {});
    if (supplierId) pick({ id: supplierId, displayName: query }, close);
  }
  const renderFooter = ({ close }: { search: string; close: () => void }) => {
    if (query === "") return null;
    return (
      <div className="border-t border-border p-2 space-y-2">
        {candidates && (
          <div role="group" aria-label={translate("SupplierPickerSimilarTitle")} className="space-y-2">
            <p className="text-xs font-medium">{translate("SupplierPickerSimilarTitle")}</p>
            <p className="text-xs text-muted-foreground">{translate("SupplierPickerSimilarHint")}</p>
            {candidates.map((candidate) => (
              <div key={candidate.supplierId} className="flex items-center justify-between gap-2">
                <span className="text-sm">
                  <bdi>{candidate.displayName}</bdi>
                  {candidate.status === "INACTIVE" && (
                    <span className="ms-2 text-xs text-muted-foreground">{translate("SupplierPickerInactive")}</span>
                  )}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={candidate.status === "INACTIVE"}
                  onClick={() => pick({ id: candidate.supplierId, displayName: candidate.displayName }, close)}
                >
                  {translate("SupplierPickerUseExisting")}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={creating}
              onClick={() => void submitCreate(candidates.map((c) => c.supplierId), close)}
            >
              {translate("SupplierPickerConfirmDistinct")}
            </Button>
          </div>
        )}
        {!candidates && canCreate && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full justify-start"
            disabled={creating}
            onClick={() => void submitCreate(undefined, close)}
          >
            <bdi>
              {creating
                ? translate("SupplierPickerCreating")
                : interpolate(translate("SupplierPickerCreate"), { name: query })}
            </bdi>
          </Button>
        )}
        {!candidates && !canCreate && !permissionsLoading && options.length === 0 && (
          <p className="text-xs text-muted-foreground">{translate("SupplierPickerCreateNoPermission")}</p>
        )}
        {createError && (
          <p role="alert" className="text-xs text-destructive">
            {createError}
          </p>
        )}
      </div>
    );
  };

  return (
    <SearchableSelect
      value={value}
      onValueChange={(id) => {
        const row = (rows ?? []).find((r) => r._id === id);
        if (row) onChange({ id: row._id, displayName: row.displayName });
      }}
      options={options}
      placeholder={translate("SupplierPickerPlaceholder")}
      searchPlaceholder={translate("SupplierPickerSearchPlaceholder")}
      emptyLabel={translate("SupplierPickerEmpty")}
      noResultsLabel={translate("SupplierPickerNoResults")}
      loading={loading}
      loadingLabel={translate("SupplierPickerLoading")}
      onSearchChange={setText}
      clientSideFilter={false}
      selectedFallbackLabel={valueLabel}
      renderFooter={renderFooter}
      disabled={disabled || !orgId}
      invalid={invalid}
      ariaLabel={ariaLabel}
      triggerId={id}
      dataTestId={dataTestId}
      className={className}
    />
  );
}

export function SupplierSelect(props: Readonly<SupplierSelectProps>) {
  const { t } = useLanguage();
  return (
    <SupplierQueryBoundary
      fallback={
        <p role="alert" className="text-xs text-destructive">
          {(t as (key: string) => string)("SupplierPickerLoadError")}
        </p>
      }
    >
      <SupplierSelectBody {...props} />
    </SupplierQueryBoundary>
  );
}
