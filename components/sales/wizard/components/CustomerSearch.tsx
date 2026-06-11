"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Check, Search, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Doc } from "@/convex/_generated/dataModel";

type Customer = Doc<"customers">;

interface CustomerSearchProps {
  customers: Customer[] | undefined;
  selectedCustomer: Customer | null;
  onSelect: (customer: Customer | null) => void;
  onCreateNew: () => void;
  accentClass?: string;
}

export default function CustomerSearch({
  customers,
  selectedCustomer,
  onSelect,
  onCreateNew,
  accentClass = "border-indigo-500 bg-indigo-500/10",
}: CustomerSearchProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!customers) return [];

    const q = query.toLowerCase();
    if (!q) return customers;

    return customers.filter((c) => {
      return (
        c.firstName.toLowerCase().includes(q) ||
        c.lastName.toLowerCase().includes(q) ||
        (c.phone || "").includes(q) ||
        (c.nationalId || "").includes(q)
      );
    });
  }, [customers, query]);

  return (
    <div className="space-y-3">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, phone, or national ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-10 bg-background"
        />
      </div>

      {/* Results */}
      {query.length > 0 && (
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {filtered.length === 0 ? (
            <p className="text-sm text-center py-6 text-muted-foreground">
              No customers found.
            </p>
          ) : (
            filtered.map((c) => {
              const isSelected = selectedCustomer?._id === c._id;

              return (
                <button
                  key={c._id}
                  type="button"
                  onClick={() => onSelect(isSelected ? null : c)}
                  className={cn(
                    "w-full flex items-center gap-3 rounded-lg border px-4 py-3 text-start transition-all",
                    isSelected
                      ? accentClass
                      : "border-border bg-background hover:border-muted-foreground/50"
                  )}
                >
                  {/* Avatar */}
                  <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-semibold">
                    {c.firstName[0]}
                    {c.lastName[0]}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">
                      {c.firstName} {c.lastName}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {[c.phone, c.nationalId, c.email]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>

                  {isSelected && (
                    <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                  )}
                </button>
              );
            })
          )}
        </div>
      )}

      {/* Create new */}
      <Button
        type="button"
        variant="outline"
        className="w-full border-dashed text-muted-foreground hover:text-foreground"
        onClick={onCreateNew}
      >
        <UserPlus className="w-4 h-4 mr-2" />
        Create a new customer
      </Button>
    </div>
  );
}