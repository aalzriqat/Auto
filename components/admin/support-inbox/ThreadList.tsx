"use client";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { ThreadRow } from "./ThreadRow";
import type { CategoryTab, StatusFilter, SupportThread } from "./types";

type LoadStatus = "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";

interface ThreadListProps {
  threads: SupportThread[];
  /** Threads on the loaded pages before the category/search filters. */
  loadedCount: number;
  loadStatus: LoadStatus;
  selectedId: string | null;
  now: number;
  category: CategoryTab;
  statusFilter: StatusFilter;
  onCategoryChange: (category: CategoryTab) => void;
  onStatusChange: (status: StatusFilter) => void;
  onSelect: (thread: SupportThread) => void;
  onLoadMore: () => void;
  className?: string;
}

const CATEGORY_TABS: Array<{ id: CategoryTab; labelKey: string }> = [
  { id: "people", labelKey: "SupportInboxCatPeople" },
  { id: "automated", labelKey: "SupportInboxCatAutomated" },
];

const STATUS_CHIPS: Array<{ id: StatusFilter; labelKey: string }> = [
  { id: "OPEN", labelKey: "SupportInboxStatusOpen" },
  { id: "CLOSED", labelKey: "SupportInboxStatusClosed" },
  { id: "ALL", labelKey: "SupportInboxStatusAll" },
];

function SkeletonRows() {
  // Same row height as a real row so the first paint does not shift.
  return (
    <div aria-hidden="true">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="grid grid-cols-[2.25rem_1fr] gap-x-2.5 gap-y-1.5 border-b border-border px-3 py-2.5">
          <Skeleton className="row-span-2 h-9 w-9 rounded-full" />
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3.5 w-5/6" />
        </div>
      ))}
    </div>
  );
}

export function ThreadList({
  threads,
  loadedCount,
  loadStatus,
  selectedId,
  now,
  category,
  statusFilter,
  onCategoryChange,
  onStatusChange,
  onSelect,
  onLoadMore,
  className,
}: ThreadListProps) {
  const { t } = useLanguage();
  const loadingFirst = loadStatus === "LoadingFirstPage";

  return (
    <section
      aria-label={t("SupportInboxListLabel")}
      className={cn("flex min-h-0 w-full flex-col border-border bg-card lg:w-[24rem] lg:shrink-0 lg:border-e", className)}
    >
      <div role="tablist" aria-label={t("SupportInboxCategories")} className="flex shrink-0 border-b border-border px-2">
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={category === tab.id}
            onClick={() => onCategoryChange(tab.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              category === tab.id
                ? "border-primary font-semibold text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div role="group" aria-label={t("SupportInboxStatusFilter")} className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        {STATUS_CHIPS.map((chip) => (
          <button
            key={chip.id}
            type="button"
            aria-pressed={statusFilter === chip.id}
            onClick={() => onStatusChange(chip.id)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              statusFilter === chip.id
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {t(chip.labelKey)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loadingFirst ? (
          <SkeletonRows />
        ) : threads.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">
            {loadedCount === 0 ? t("SupportInboxEmpty") : t("SupportInboxEmptyFiltered")}
          </p>
        ) : (
          <ul>
            {threads.map((thread) => (
              <li key={thread._id}>
                <ThreadRow thread={thread} selected={thread._id === selectedId} now={now} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        )}
        {(loadStatus === "CanLoadMore" || loadStatus === "LoadingMore") && (
          <Button
            variant="outline"
            className="m-3 w-[calc(100%-1.5rem)] border-dashed text-muted-foreground"
            disabled={loadStatus === "LoadingMore"}
            onClick={onLoadMore}
          >
            {loadStatus === "LoadingMore" ? t("SupportInboxLoading") : t("SupportInboxLoadMore")}
          </Button>
        )}
      </div>
    </section>
  );
}
