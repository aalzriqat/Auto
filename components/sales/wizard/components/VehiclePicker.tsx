"use client";

import { useMemo, useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Search, Check, Truck, Loader2 } from "lucide-react";

export type SourceVehicleData = {
  make: string;
  model: string;
  year: number;
  trim?: string;
  color: string;
  mileage: number;
  fuelType: string;
  transmission: string;
  sourcedFromName: string;
  sourceCost: number;
  sellingPrice: number;
  vin?: string;
};

const DEFAULT_SOURCE_DATA: SourceVehicleData = {
  make: "",
  model: "",
  year: new Date().getFullYear(),
  trim: "",
  color: "",
  mileage: 0,
  fuelType: "Gasoline",
  transmission: "Automatic",
  sourcedFromName: "",
  sourceCost: 0,
  sellingPrice: 0,
  vin: "",
};

export default function VehiclePicker({
  vehicles,
  value,
  onChange,
  onSourceVehicle,
}: {
  vehicles: any[] | undefined;
  value: string;
  onChange: (id: string, price: number) => void;
  onSourceVehicle?: (data: SourceVehicleData) => Promise<string>;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [showSourceForm, setShowSourceForm] = useState(false);
  const [isSourcing, setIsSourcing] = useState(false);
  const [sourceData, setSourceData] = useState<SourceVehicleData>(DEFAULT_SOURCE_DATA);
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
        (v.vin ?? "").toLowerCase().includes(q) ||
        (v.color || "").toLowerCase().includes(q)
    );
  }, [vehicles, search]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowSourceForm(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSourceSubmit = async () => {
    if (!onSourceVehicle) return;
    if (!sourceData.make || !sourceData.model || !sourceData.sourcedFromName || !sourceData.sourceCost || !sourceData.sellingPrice) {
      return;
    }
    setIsSourcing(true);
    try {
      const newId = await onSourceVehicle(sourceData);
      onChange(newId, sourceData.sellingPrice);
      setOpen(false);
      setShowSourceForm(false);
      setSourceData(DEFAULT_SOURCE_DATA);
    } catch (err: any) {
      throw err; // Propagate so the parent wizard can surface the error via toast
    } finally {
      setIsSourcing(false);
    }
  };

  const inputCls = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500/30";
  const labelCls = "text-xs font-medium text-muted-foreground";

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
            ? `${selected.year} ${selected.make} ${selected.model}${selected.sourceType === "SOURCED" ? " · Sourced" : selected.vin ? ` — ${selected.vin}` : ""}`
            : "Select an available vehicle…"}
          {selected?.status === "RESERVED" && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-500">
              Reserved — pending deal
            </span>
          )}
          {selected?.sourceType === "SOURCED" && (
            <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-500">
              Sourced
            </span>
          )}
        </span>
        <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-popover shadow-lg">
          {!showSourceForm ? (
            <>
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
                                Reserved
                              </span>
                            )}
                            {v.sourceType === "SOURCED" && (
                              <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-500">
                                Sourced
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">{v.vin ?? "VIN pending"} · {v.color}</p>
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

              {/* Source a new vehicle button */}
              {onSourceVehicle && (
                <div className="border-t border-border p-2">
                  <button
                    type="button"
                    onClick={() => setShowSourceForm(true)}
                    className="w-full flex items-center gap-2 rounded-md px-3 py-2 text-sm text-orange-600 hover:bg-orange-500/10 transition-colors font-medium"
                  >
                    <Truck className="w-4 h-4" />
                    Source a vehicle for this customer
                  </button>
                </div>
              )}
            </>
          ) : (
            /* Inline sourcing form */
            <div className="p-3 space-y-3 max-h-[480px] overflow-y-auto">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold flex items-center gap-1.5">
                  <Truck className="w-4 h-4 text-orange-500" />
                  Source a vehicle for this customer
                </p>
                <button type="button" onClick={() => setShowSourceForm(false)} className="text-xs text-muted-foreground hover:text-foreground">
                  ← Back to list
                </button>
              </div>

              <div className="p-2.5 rounded-md bg-orange-50 dark:bg-orange-950/20 border border-orange-200 text-xs text-orange-700 dark:text-orange-400">
                Car not in stock? Enter the details to create a sourced vehicle and continue building the quote.
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <p className={labelCls}>Make *</p>
                  <input className={inputCls} value={sourceData.make} onChange={(e) => setSourceData((d) => ({ ...d, make: e.target.value }))} placeholder="Toyota" />
                </div>
                <div>
                  <p className={labelCls}>Model *</p>
                  <input className={inputCls} value={sourceData.model} onChange={(e) => setSourceData((d) => ({ ...d, model: e.target.value }))} placeholder="Camry" />
                </div>
                <div>
                  <p className={labelCls}>Year *</p>
                  <input className={inputCls} type="number" min="2000" max="2030" value={sourceData.year} onChange={(e) => setSourceData((d) => ({ ...d, year: parseInt(e.target.value) || new Date().getFullYear() }))} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className={labelCls}>Trim (optional)</p>
                  <input className={inputCls} value={sourceData.trim ?? ""} onChange={(e) => setSourceData((d) => ({ ...d, trim: e.target.value }))} placeholder="LE, XLE…" />
                </div>
                <div>
                  <p className={labelCls}>Color *</p>
                  <input className={inputCls} value={sourceData.color} onChange={(e) => setSourceData((d) => ({ ...d, color: e.target.value }))} placeholder="White" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className={labelCls}>Fuel Type</p>
                  <select className={inputCls} value={sourceData.fuelType} onChange={(e) => setSourceData((d) => ({ ...d, fuelType: e.target.value }))}>
                    <option>Gasoline</option>
                    <option>Diesel</option>
                    <option>Hybrid</option>
                    <option>Electric</option>
                  </select>
                </div>
                <div>
                  <p className={labelCls}>Transmission</p>
                  <select className={inputCls} value={sourceData.transmission} onChange={(e) => setSourceData((d) => ({ ...d, transmission: e.target.value }))}>
                    <option>Automatic</option>
                    <option>Manual</option>
                  </select>
                </div>
              </div>

              <div>
                <p className={labelCls}>VIN (optional — can be updated when car arrives)</p>
                <input className={inputCls} value={sourceData.vin ?? ""} onChange={(e) => setSourceData((d) => ({ ...d, vin: e.target.value }))} placeholder="Leave blank if not yet assigned" />
              </div>

              <div className="border-t border-border pt-2 space-y-2">
                <div>
                  <p className={labelCls}>Source Dealer Name *</p>
                  <input className={inputCls} value={sourceData.sourcedFromName} onChange={(e) => setSourceData((d) => ({ ...d, sourcedFromName: e.target.value }))} placeholder="Al-Safeer Motors" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className={labelCls}>Supplier Cost (JOD) *</p>
                    <input className={inputCls} type="number" min="0" step="0.01" value={sourceData.sourceCost || ""} onChange={(e) => setSourceData((d) => ({ ...d, sourceCost: parseFloat(e.target.value) || 0 }))} placeholder="0.000" />
                  </div>
                  <div>
                    <p className={labelCls}>Selling Price (JOD) *</p>
                    <input className={inputCls} type="number" min="0" step="0.01" value={sourceData.sellingPrice || ""} onChange={(e) => setSourceData((d) => ({ ...d, sellingPrice: parseFloat(e.target.value) || 0 }))} placeholder="0.000" />
                  </div>
                </div>
                {sourceData.sourceCost > 0 && sourceData.sellingPrice > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Margin: <span className="font-medium text-green-600">{(sourceData.sellingPrice - sourceData.sourceCost).toLocaleString()} JOD</span>
                    {" "}({((sourceData.sellingPrice - sourceData.sourceCost) / sourceData.sourceCost * 100).toFixed(1)}%)
                  </p>
                )}
              </div>

              <button
                type="button"
                disabled={isSourcing || !sourceData.make || !sourceData.model || !sourceData.sourcedFromName || !sourceData.sourceCost || !sourceData.sellingPrice || !sourceData.color}
                onClick={handleSourceSubmit}
                className="w-full flex items-center justify-center gap-2 rounded-md bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white py-2 text-sm font-medium transition-colors"
              >
                {isSourcing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Truck className="w-4 h-4" />}
                {isSourcing ? "Creating sourced vehicle…" : "Create & select this vehicle"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
