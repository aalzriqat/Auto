import { useMemo, useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Search, Check } from "lucide-react";

export default function VehiclePicker({
  vehicles,
  value,
  onChange,
}: {
  vehicles: any[] | undefined;
  value: string;
  onChange: (id: string, price: number) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = vehicles?.find((v) => v._id === value);

  const filtered = useMemo(() => {
    if (!vehicles) return [];
    const q = search.toLowerCase();
    if (!q) return vehicles;
    return vehicles.filter(
      (v) =>
        v.make.toLowerCase().includes(q) ||
        v.model.toLowerCase().includes(q) ||
        String(v.year).includes(q) ||
        v.vin.toLowerCase().includes(q) ||
        (v.color || "").toLowerCase().includes(q)
    );
  }, [vehicles, search]);

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

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm transition-colors",
          open ? "border-indigo-500 ring-1 ring-indigo-500/30" : "border-border hover:border-muted-foreground/60"
        )}
      >
        <span className={cn("flex items-center gap-2", selected ? "text-foreground" : "text-muted-foreground")}>
          {selected
            ? `${selected.year} ${selected.make} ${selected.model} — ${selected.vin}`
            : "Select an available vehicle…"}
          {selected?.status === "RESERVED" && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-500">
              Reserved — pending deal
            </span>
          )}
        </span>
        <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-popover shadow-lg">
          {/* Search bar */}
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by make, model, year, VIN…"
                className="w-full rounded-md border border-border bg-background ps-8 pe-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
              />
            </div>
          </div>

          {/* Vehicle list */}
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-6">No vehicles match your search</p>
            ) : (
              filtered.map((v) => {
                const isSelected = v._id === value;
                return (
                  <button
                    key={v._id}
                    type="button"
                    onClick={() => {
                      onChange(v._id, v.sellingPrice);
                      setOpen(false);
                      setSearch("");
                    }}
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-2.5 text-sm text-start hover:bg-muted/60 transition-colors",
                      isSelected && "bg-indigo-500/10 text-indigo-400"
                    )}
                  >
                    <div>
                      <p className="font-medium flex items-center gap-2">
                        {v.year} {v.make} {v.model}
                        {v.trim ? ` ${v.trim}` : ""}
                        {v.status === "RESERVED" && (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-500">
                            Reserved — pending deal
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">{v.vin} · {v.color}</p>
                    </div>
                    <div className="text-end flex-shrink-0 ms-4">
                      <p className="font-semibold">{v.sellingPrice.toLocaleString()} JOD</p>
                      {isSelected && <Check className="w-3.5 h-3.5 text-indigo-400 ms-auto mt-0.5" />}
                    </div>
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