"use client";

/**
 * The create-supplier handling shared by the inline picker (SupplierSelect) and the Suppliers
 * screen (SCRUM-887). One place decides how the server's answers to `suppliers.create` are read:
 *
 * - SUPPLIER_DUPLICATE_CANDIDATES: similar suppliers exist. The caller shows them and resubmits
 *   with `confirmDistinctFrom` set to exactly those ids (the server compares the lists).
 * - SUPPLIER_LEGAL_IDENTITY_EXISTS: the tax id and jurisdiction already belong to a supplier. The
 *   caller explains it and may resubmit as a declared shared legal identity.
 * - anything else: a localized message.
 *
 * The idempotency key identifies one request. It is reused for a retry of the same request and
 * dropped after a success, a duplicate answer, a legal-identity answer or `reset()`, because the
 * server fingerprints the payload (including the confirm list) against the key.
 */
import { useCallback, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getCodedErrorMessage, isConvexError } from "@/lib/errors";

export interface SupplierCandidate {
  supplierId: Id<"suppliers">;
  displayName: string;
  status: "ACTIVE" | "INACTIVE";
  reasons?: string[];
}

export interface SupplierCreateFields {
  displayName: string;
  legalName?: string;
  contact?: { phone?: string; email?: string; address?: string };
  taxId?: string;
  taxJurisdiction?: string;
}

export interface SupplierCreateOptions {
  confirmDistinctFrom?: Id<"suppliers">[];
  sharedLegalIdentityOf?: Id<"suppliers">;
  sharedLegalIdentityReason?: string;
}

export const DUPLICATE_CODE = "SUPPLIER_DUPLICATE_CANDIDATES";
export const LEGAL_IDENTITY_CODE = "SUPPLIER_LEGAL_IDENTITY_EXISTS";
export const VERSION_CONFLICT_CODE = "SUPPLIER_VERSION_CONFLICT";

function payloadOf(error: unknown): Record<string, unknown> | null {
  if (!isConvexError(error)) return null;
  const data = error.data as unknown;
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

/** The server's refusal code, or null when the error is not a coded refusal. */
export function refusalCode(error: unknown): string | null {
  const code = payloadOf(error)?.code;
  return typeof code === "string" ? code : null;
}

/** The similar suppliers a duplicate refusal lists, or null when the error is not one. */
export function duplicateCandidates(error: unknown): SupplierCandidate[] | null {
  const data = payloadOf(error);
  if (!data || data.code !== DUPLICATE_CODE || !Array.isArray(data.candidates)) return null;
  return (data.candidates as SupplierCandidate[]).filter(
    (c) => typeof c?.supplierId === "string" && typeof c?.displayName === "string",
  );
}

/** The supplier that already holds the legal identity, or null when the error is not that refusal. */
export function legalIdentityConflict(error: unknown): { existingSupplierId: Id<"suppliers"> } | null {
  const data = payloadOf(error);
  if (!data || data.code !== LEGAL_IDENTITY_CODE || typeof data.existingSupplierId !== "string") return null;
  return { existingSupplierId: data.existingSupplierId as Id<"suppliers"> };
}

export function newIdempotencyKey(): string {
  return `supplier-create:${globalThis.crypto.randomUUID()}`;
}

/**
 * A message in the user's language for any failed supplier call. A coded refusal uses its
 * `ServerError_<code>` entry; everything else gets one localized generic line, never the server's
 * English wording.
 */
export function describeSupplierError(error: unknown, translate: (key: string) => string): string {
  return getCodedErrorMessage(error, translate) ?? translate("SuppliersGenericError");
}

export function useSupplierCreateFlow(orgId: Id<"organizations"> | null | undefined) {
  const createSupplier = useMutation(api.suppliers.create);
  const [creating, setCreating] = useState(false);
  /** The last failure that was not a duplicate or legal-identity answer, as thrown. */
  const [error, setError] = useState<unknown>(null);
  const [candidates, setCandidates] = useState<SupplierCandidate[] | null>(null);
  const [legalConflict, setLegalConflict] = useState<{ existingSupplierId: Id<"suppliers"> } | null>(null);
  const keyRef = useRef<string | null>(null);
  const inFlight = useRef(false);

  /** A new intent: forget the previous attempt, its answers and its key. */
  const reset = useCallback(() => {
    setCandidates(null);
    setLegalConflict(null);
    setError(null);
    keyRef.current = null;
  }, []);

  /** Resolves to the new supplier's id, or null when the server did not create one. */
  const submit = useCallback(
    async (fields: SupplierCreateFields, options: SupplierCreateOptions = {}): Promise<Id<"suppliers"> | null> => {
      if (!orgId || inFlight.current) return null;
      inFlight.current = true;
      setCreating(true);
      setError(null);
      keyRef.current ??= newIdempotencyKey();
      try {
        const { supplierId } = await createSupplier({
          orgId,
          idempotencyKey: keyRef.current,
          ...fields,
          ...(options.confirmDistinctFrom ? { confirmDistinctFrom: options.confirmDistinctFrom } : {}),
          ...(options.sharedLegalIdentityOf
            ? {
                sharedLegalIdentityOf: options.sharedLegalIdentityOf,
                sharedLegalIdentityReason: options.sharedLegalIdentityReason,
              }
            : {}),
        });
        keyRef.current = null;
        setCandidates(null);
        setLegalConflict(null);
        return supplierId;
      } catch (caught) {
        const found = duplicateCandidates(caught);
        const conflict = legalIdentityConflict(caught);
        if (found) {
          setCandidates(found);
          setLegalConflict(null);
          keyRef.current = null;
        } else if (conflict) {
          setLegalConflict(conflict);
          setCandidates(null);
          keyRef.current = null;
        } else {
          setError(caught);
        }
        return null;
      } finally {
        inFlight.current = false;
        setCreating(false);
      }
    },
    [createSupplier, orgId],
  );

  return { creating, error, candidates, legalConflict, submit, reset };
}
