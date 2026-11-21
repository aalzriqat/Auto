import type { CSSProperties, ReactNode, RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { recordPanelId, workbenchPanelId } from "./dealWorkbenchPanels";

type Panel = readonly [key: string, node: ReactNode];

type FlowItem = {
  key: string;
  zone: "step" | "workbench" | "toggle" | "record";
  className: string;
  style?: CSSProperties;
  node: ReactNode;
};

function panelId({ key, zone }: FlowItem): string | undefined {
  if (zone === "record") return recordPanelId(key);
  if (zone === "workbench") return workbenchPanelId(key);
  return undefined;
}

export function DealWorkbenchGrid({
  stageViewNode,
  stepNode,
  workbenchItems,
  recordItems,
  detailsOpen,
  onDetailsOpenChange,
  flowRef,
  flowFocusRef,
  t,
}: Readonly<{
  stageViewNode: ReactNode;
  stepNode: ReactNode;
  workbenchItems: ReadonlyArray<Panel>;
  recordItems: ReadonlyArray<Panel>;
  detailsOpen: boolean;
  onDetailsOpenChange: (open: boolean) => void;
  flowRef: RefObject<HTMLDivElement | null>;
  flowFocusRef: RefObject<HTMLElement | null>;
  t: (key: string) => string;
}>) {
  // ONE parent, one keyed list: the next-step card, every movable panel and the
  // Deal-details toggle are siblings, and the stage only changes their ORDER.
  // React moves a keyed sibling without remounting it, so a panel that changes
  // place when the live stage changes keeps its local state — the add-cost
  // form's intent, an open custody dialog and its identity, an UNKNOWN attempt.
  // Collapsing is the 'hidden' attribute, never an unmount, for the same reason.
  // DOM order equals visual order, so tab order follows what is on screen.
  const recordIds = recordItems.map(([panel]) => recordPanelId(panel));
  const recordWorking = recordItems.filter(([panel]) => panel !== "money");
  const recordWorkingColumn = recordWorking.length > 0;
  const splitRecord = recordItems.some(([panel]) => panel === "money") && recordWorkingColumn;
  const flow: FlowItem[] = [];
  if (stageViewNode != null) flow.push({ key: "stage-view", zone: "step", className: "xl:col-span-5", node: stageViewNode });
  if (stepNode != null) flow.push({ key: "next-step", zone: "step", className: "xl:col-span-5", node: stepNode });
  for (const [panel, node] of workbenchItems) {
    flow.push({ key: panel, zone: "workbench", className: "xl:col-span-5", node });
  }
  if (recordItems.length > 0) flow.push({
    key: "details-toggle",
    zone: "toggle",
    className: "xl:col-span-5",
    node: (
      <button
        type="button"
        data-testid="deal-details-toggle"
        aria-expanded={detailsOpen}
        aria-controls={recordIds.join(" ")}
        onClick={() => onDetailsOpenChange(!detailsOpen)}
        className="group flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold">{t("DealDetailsHeading")}</span>
          <span className="block text-xs text-muted-foreground">{t("DealDetailsHint")}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-aria-expanded:rotate-180" aria-hidden />
      </button>
    ),
  });
  // Split only at xl: at lg the money column is ~220px beside a 256px sidebar —
  // too narrow for its figures — so it stacks instead. Two of five tracks, not
  // a strict third: a third is ~300px at 1280. The money spans the rows of the
  // working panels beside it (the reading side first, SCRUM-372).
  for (const [panel, node] of recordItems) {
    const isMoney = panel === "money";
    let className = "xl:col-span-5";
    if (splitRecord) {
      className = isMoney
        ? "xl:col-span-2 xl:col-start-1 xl:[grid-row:span_var(--record-rows)]"
        : "xl:col-span-3 xl:col-start-3";
    }
    flow.push({
      key: panel,
      zone: "record",
      className,
      style: isMoney && recordWorkingColumn ? ({ "--record-rows": recordWorking.length } as CSSProperties) : undefined,
      node,
    });
  }

  // The money column spans the rows of the working panels beside it. When the
  // money is TALLER than they are, a spanning item shares its extra height
  // equally across every row it spans, which pushes the working cards apart.
  // Every row but the last is sized to its content and the last takes the
  // slack, so the cards stay together and the spare height sits under them.
  // (One row per flow item except the money, which spans them.) The template
  // applies only while a record wrapper is shown (the has- variant on the
  // grid): collapsed, the grid has just the card and the toggle, and rows
  // sized for the hidden record would leave blank space under the toggle.
  const flowRows: CSSProperties | undefined =
    splitRecord
      ? ({ "--flow-rows": `repeat(${flow.length - 2}, auto) 1fr` } as CSSProperties)
      : undefined;

  return (
    <div
      ref={flowRef}
      className="grid min-w-0 gap-6 xl:grid-cols-5 xl:has-[>[data-zone=record]:not([hidden])]:[grid-template-rows:var(--flow-rows)]"
      style={flowRows}
      onFocus={(event) => {
        flowFocusRef.current = event.target as HTMLElement;
      }}
      onBlur={(event) => {
        // A real blur leaves the element in the document; a node that is
        // being moved is not a decision to leave, so its memory is kept.
        if ((event.target as HTMLElement).isConnected) flowFocusRef.current = null;
      }}
    >
      {flow.map((item) => (
        <div
          key={item.key}
          data-zone={item.zone}
          id={panelId(item)}
          hidden={item.zone === "record" && !detailsOpen}
          className={cn("min-w-0", item.className)}
          style={item.style}
        >
          {item.node}
        </div>
      ))}
    </div>
  );
}
