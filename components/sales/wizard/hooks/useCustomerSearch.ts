"use client";

import { useMemo, useState } from "react";
import { Doc } from "@/convex/_generated/dataModel";

type Customer = Doc<"customers">;

interface UseCustomerSearchParams {
  customers: Customer[] | undefined;
  initialQuery?: string;
}

export function useCustomerSearch({
  customers,
  initialQuery = "",
}: UseCustomerSearchParams) {
  const [query, setQuery] = useState(initialQuery);

  const filteredCustomers = useMemo(() => {
    if (!customers) return [];

    const q = query.trim().toLowerCase();
    if (!q) return customers;

    return customers.filter((c) => {
      const fullName = `${c.firstName} ${c.lastName}`.toLowerCase();

      return (
        fullName.includes(q) ||
        c.firstName.toLowerCase().includes(q) ||
        c.lastName.toLowerCase().includes(q) ||
        (c.phone || "").includes(q) ||
        (c.nationalId || "").includes(q) ||
        (c.email || "").toLowerCase().includes(q)
      );
    });
  }, [customers, query]);

  const hasResults = filteredCustomers.length > 0;

  const clearQuery = () => setQuery("");

  return {
    query,
    setQuery,
    clearQuery,
    filteredCustomers,
    hasResults,
  };
}