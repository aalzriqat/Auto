"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Search, Check } from "lucide-react";

export interface SearchableSelectOption {
  value: string;
  label: string;
  subLabel?: string;
}

interface SearchableSelectProps {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  /** If provided, adds a "none/clear" entry at the top of the list */
  noneLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function SearchableSelect({
  value: valueProp,
  onValueChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  noneLabel,
  disabled,
  className,
}: SearchableSelectProps) {
  const value = valueProp ?? "";
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = value && value !== "none" ? options.find((o) => o.value === value) : null;

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.subLabel?.toLowerCase().includes(q) ?? false)
    );
  }, [options, search]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Keyboard: Escape closes
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      setTimeout(() => searchRef.current?.focus(), 10);
    } else {
      setSearch("");
    }
  }, [open]);

  function handleSelect(val: string) {
    onValueChange(val);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      {/* Trigger — matches shadcn SelectTrigger exactly */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={cn(
          "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          !selected && "text-muted-foreground",
          open && "ring-1 ring-ring"
        )}
      >
        <span className="line-clamp-1 text-start">
          {selected ? selected.label : (noneLabel && !value ? noneLabel : placeholder)}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 opacity-50 shrink-0 ms-2 transition-transform duration-150",
            open && "rotate-180"
          )}
        />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[200px] rounded-md border border-border bg-popover text-popover-foreground shadow-md">
          {/* Search */}
          <div className="p-1.5 border-b border-border">
            <div className="relative">
              <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full rounded-sm border border-border bg-background ps-8 pe-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          {/* Options list */}
          <div className="max-h-60 overflow-y-auto">
            {noneLabel && (
              <button
                type="button"
                onClick={() => handleSelect("none")}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-sm text-start hover:bg-accent hover:text-accent-foreground transition-colors text-muted-foreground",
                  (value === "none" || value === "") && "bg-accent/50"
                )}
              >
                <span className="flex-1">{noneLabel}</span>
                {(value === "none" || value === "") && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            )}

            {filtered.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-6">
                {search ? "No results found." : "No options available."}
              </p>
            ) : (
              filtered.map((o) => {
                const isSelected = o.value === value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => handleSelect(o.value)}
                    className={cn(
                      "w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-start hover:bg-accent hover:text-accent-foreground transition-colors",
                      isSelected && "bg-accent font-medium"
                    )}
                  >
                    <span className="flex-1">
                      <span className="block">{o.label}</span>
                      {o.subLabel && (
                        <span className="block text-xs text-muted-foreground mt-0.5">{o.subLabel}</span>
                      )}
                    </span>
                    {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
