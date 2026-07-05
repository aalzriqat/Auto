"use client";

import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { SortDir } from "@/hooks/useTableControls";

interface SortableColumnHeaderProps {
  label: string;
  sortKey: string;
  activeSortKey?: string;
  sortDir: SortDir;
  onSort: (key: string) => void;
  className?: string;
}

export function SortableColumnHeader({
  label,
  sortKey,
  activeSortKey,
  sortDir,
  onSort,
  className,
}: SortableColumnHeaderProps) {
  const isActive = activeSortKey === sortKey;
  const Icon = isActive ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
          isActive && "text-foreground font-semibold"
        )}
      >
        {label}
        <Icon className="h-3.5 w-3.5" />
      </button>
    </TableHead>
  );
}
