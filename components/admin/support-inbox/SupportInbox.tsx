"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { Inbox, Search } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { resolveThreadCategory } from "@/lib/supportMail";
import { INBOX_KEYS, includesQuery, isTypingTarget, type InboxKey } from "./format";
import { ReadingPane } from "./ReadingPane";
import { ThreadList } from "./ThreadList";
import type { CategoryTab, StatusFilter, SupportThread } from "./types";

const MAILBOX_LABEL_KEY: Record<InboxKey, string> = {
  support: "SupportInboxMailboxSupport",
  info: "SupportInboxMailboxInfo",
  subscriptions: "SupportInboxMailboxBilling",
};

const PAGE_SIZE = 30;

function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <>
      <span className="flex justify-end gap-1">
        {keys.map((key) => (
          <kbd
            key={key}
            className="rounded border border-b-2 border-border px-1.5 text-[11px] text-muted-foreground"
          >
            {key}
          </kbd>
        ))}
      </span>
      <span>{label}</span>
    </>
  );
}

function EmptyReadingPane() {
  const { t } = useLanguage();
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground">
      <div>
        <Inbox className="mx-auto h-10 w-10" strokeWidth={1.4} aria-hidden="true" />
        <p className="mt-2 text-sm">{t("SupportInboxSelectPrompt")}</p>
        <div className="mt-4 grid grid-cols-[auto_auto] items-center gap-x-3 gap-y-1.5 text-start text-xs">
          <KeyHint keys={["j", "k"]} label={t("SupportInboxKeyNavigate")} />
          <KeyHint keys={["r"]} label={t("SupportInboxKeyReply")} />
          <KeyHint keys={["e"]} label={t("SupportInboxKeyClose")} />
          <KeyHint keys={["/"]} label={t("SupportInboxKeyFilter")} />
        </div>
      </div>
    </div>
  );
}

export function SupportInbox() {
  const { t } = useLanguage();
  const [inbox, setInbox] = useState<InboxKey>("support");
  const [category, setCategory] = useState<CategoryTab>("people");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<Id<"supportThreads"> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // `now` only decides "today / weekday / date" labels; refreshing it once a
  // minute keeps a long-open tab from showing stale relative days.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const {
    results,
    status: loadStatus,
    loadMore,
  } = usePaginatedQuery(
    api.support.listThreads,
    { inbox, status: statusFilter === "ALL" ? undefined : statusFilter },
    { initialNumItems: PAGE_SIZE }
  );

  // Category and text filtering run over the pages loaded so far. Phase 2 moves
  // both server-side (header-based classification + a search index); until then
  // an older thread that has not been paged in is not searchable.
  const visible = useMemo(
    () =>
      results.filter(
        (thread) =>
          resolveThreadCategory(thread) === category &&
          includesQuery(
            [thread.participantName, thread.participantEmail, thread.subject, thread.lastMessagePreview],
            query
          )
      ),
    [results, category, query]
  );

  const selectedIndex = selectedId ? visible.findIndex((thread) => thread._id === selectedId) : -1;

  const select = useCallback((thread: SupportThread) => setSelectedId(thread._id), []);

  const step = useCallback(
    (direction: 1 | -1) => {
      if (visible.length === 0) return;
      const from = selectedIndex < 0 ? (direction === 1 ? -1 : visible.length) : selectedIndex;
      const next = visible[Math.max(0, Math.min(visible.length - 1, from + direction))];
      if (next) setSelectedId(next._id);
    },
    [visible, selectedIndex]
  );

  // j / k / Esc / "/" — r and e live in ReadingPane, where the thread is known.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === "j") step(1);
      else if (event.key === "k") step(-1);
      else if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "Escape" && selectedId) setSelectedId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step, selectedId]);

  const reading = selectedId !== null;

  return (
    <div className="flex h-[calc(100dvh-8rem)] flex-col overflow-hidden rounded-lg border border-border bg-background lg:h-[calc(100dvh-6rem)]">
      <header className={cn("shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card px-4 py-2.5", reading ? "hidden lg:flex" : "flex")}>
        <h1 className="text-base font-bold text-foreground">{t("SupportInboxTitle")}</h1>
        <div role="tablist" aria-label={t("SupportInboxMailboxes")} className="flex gap-0.5 rounded-lg bg-muted p-[3px]">
          {INBOX_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={inbox === key}
              onClick={() => {
                setInbox(key);
                setSelectedId(null);
              }}
              className={cn(
                "whitespace-nowrap rounded-md px-3 py-1 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                inbox === key
                  ? "bg-card font-semibold text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(MAILBOX_LABEL_KEY[key])}
            </button>
          ))}
        </div>
        <label className="order-last flex min-w-0 basis-full items-center gap-2 rounded-full border border-transparent bg-muted px-3.5 py-1.5 focus-within:border-primary focus-within:bg-card sm:order-none sm:basis-0 sm:flex-1 sm:max-w-xl">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            dir="auto"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") event.currentTarget.blur();
            }}
            placeholder={t("SupportInboxFilterPlaceholder")}
            aria-label={t("SupportInboxFilterPlaceholder")}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded border border-b-2 border-border px-1.5 text-[11px] text-muted-foreground sm:inline">
            /
          </kbd>
        </label>
      </header>

      <div className="flex min-h-0 flex-1">
        <ThreadList
          className={reading ? "hidden lg:flex" : "flex"}
          threads={visible}
          loadedCount={results.length}
          loadStatus={loadStatus}
          selectedId={selectedId}
          now={now}
          category={category}
          statusFilter={statusFilter}
          onCategoryChange={(next) => {
            setCategory(next);
            setSelectedId(null);
          }}
          onStatusChange={setStatusFilter}
          onSelect={select}
          onLoadMore={() => loadMore(PAGE_SIZE)}
        />
        <section
          className={cn("min-w-0 flex-1 flex-col bg-background", reading ? "flex" : "hidden lg:flex")}
        >
          {selectedId ? (
            <ReadingPane
              key={selectedId}
              threadId={selectedId}
              position={selectedIndex >= 0 ? selectedIndex + 1 : null}
              total={visible.length}
              now={now}
              onBack={() => setSelectedId(null)}
              onPrevious={() => step(-1)}
              onNext={() => step(1)}
            />
          ) : (
            <EmptyReadingPane />
          )}
        </section>
      </div>
    </div>
  );
}
