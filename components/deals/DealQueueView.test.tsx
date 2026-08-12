/**
 * What the deal queue actually puts on screen.
 *
 * Rendered rather than reasoned about, for the reason the cockpit's own view
 * test records: raw enums leaking into an otherwise Arabic page, and bidi runs
 * reordering into nonsense, are invisible to a server test and obvious the
 * moment the screen is looked at.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DealQueueView, type DealQueueData, type DealQueueRowData } from "./DealQueueView";

const language = vi.hoisted(() => ({ locale: "ar" as "ar" | "en" }));

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({
    // Identity `t` so a MISSING translation surfaces as its key rather than
    // silently rendering something plausible.
    //
    // One exception: the truncation string is the only copy on this screen that
    // carries a placeholder, and an identity `t` would make the substitution
    // assertion pass whether or not the component ever performed it. This mock
    // supplies a real `{limit}` so that test exercises the actual behaviour.
    t: (key: string) =>
      key === "DealsQueueTruncated" ? "Showing the {limit} most recent deals" : key,
    isRtl: language.locale === "ar",
    locale: language.locale,
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const NOW = Date.UTC(2026, 7, 12, 12, 0, 0);
const DAY = 86_400_000;

function row(overrides: Partial<DealQueueRowData> = {}): DealQueueRowData {
  return {
    key: "application:app1",
    href: "/org1/applications/app1/deal",
    dealKind: "FINANCED",
    anchor: "APPLICATION",
    customerName: "عبدالرحمن سملاني",
    vehicleLabel: "Kia Sportage 2023",
    providerName: "عبداللطيف جميل للتمويل",
    providerLabelKey: null,
    ownerName: "عبدالكريم الزيات",
    statusKey: "UNDER_REVIEW",
    stageKey: "CREDIT_DECISION",
    blockerKey: "AwaitingCreditDecision",
    needsAttention: true,
    depositPending: false,
    lastActivityAt: NOW - 2 * DAY,
    ...overrides,
  };
}

function data(overrides: Partial<DealQueueData> = {}): DealQueueData {
  return {
    rows: [row()],
    counts: { ALL: 1, NEEDS_ATTENTION: 1 },
    truncated: false,
    limit: 40,
    ...overrides,
  };
}

function renderQueue(props: Partial<Parameters<typeof DealQueueView>[0]> = {}) {
  return render(
    <DealQueueView
      data={data()}
      view="NEEDS_ATTENTION"
      onViewChange={() => {}}
      now={NOW}
      {...props}
    />
  );
}

afterEach(() => {
  cleanup();
  language.locale = "ar";
});

describe("the row leads with the blocker", () => {
  test("the blocker is rendered, not the stage name, when there is one", () => {
    renderQueue();
    // The blocker is the operational answer. Showing the stage name instead
    // ("Credit decision") tells the operator where the deal is but not why it
    // has stopped, which is the failure of the two lists this replaces.
    expect(screen.getByText("BlockerAwaitingCreditDecision")).toBeTruthy();
    expect(screen.queryByText("StageCreditDecision")).toBeNull();
  });

  test("falls back to the stage name when the derivation names no blocker", () => {
    renderQueue({ data: data({ rows: [row({ blockerKey: null, stageKey: "HANDOVER" })] }) });
    expect(screen.getByText("StageHandover")).toBeTruthy();
  });

  test("a finished deal says so rather than rendering an empty line", () => {
    renderQueue({
      data: data({
        rows: [row({ blockerKey: null, stageKey: null, needsAttention: false })],
      }),
    });
    expect(screen.getByText("DealNoOpenStep")).toBeTruthy();
  });

  test("a dead deal still holding a deposit never says 'nothing outstanding'", () => {
    // Found by RENDERING the screen, not by reading it. A REJECTED application
    // has a fully STOPPED rail — no live stage, no blocker — so the row headline
    // fell through to "nothing outstanding" while the same row displayed a
    // "deposit pending" badge two lines below it. The screen contradicted itself
    // about money the dealership owes a real customer.
    renderQueue({
      data: data({
        rows: [
          row({
            statusKey: "REJECTED",
            blockerKey: null,
            stageKey: null,
            depositPending: true,
            needsAttention: true,
          }),
        ],
      }),
    });
    expect(screen.getByText("DealDepositAwaitingResolution")).toBeTruthy();
    expect(screen.queryByText("DealNoOpenStep")).toBeNull();
  });

  test("a real blocker still outranks the deposit line", () => {
    renderQueue({ data: data({ rows: [row({ depositPending: true })] }) });
    expect(screen.getByText("BlockerAwaitingCreditDecision")).toBeTruthy();
    expect(screen.queryByText("DealDepositAwaitingResolution")).toBeNull();
  });
});

describe("the stall stripe encodes a fact, not a mood", () => {
  test("waiting longer raises the level", () => {
    renderQueue({
      data: data({
        rows: [
          row({ key: "a", lastActivityAt: NOW - 1 * DAY }),
          row({ key: "b", lastActivityAt: NOW - 4 * DAY }),
          row({ key: "c", lastActivityAt: NOW - 20 * DAY }),
        ],
      }),
    });
    const rows = screen.getAllByTestId("deal-queue-row");
    expect(rows.map((el) => el.getAttribute("data-stall"))).toEqual([
      "FRESH",
      "ATTENTION",
      "URGENT",
    ]);
  });

  test("a deal nobody is waiting on is never stalled, however old", () => {
    // The stripe means "this has not moved and someone needs it to". A closed
    // deal from last year is finished, not urgent — colouring it would teach
    // operators that the colour means nothing.
    renderQueue({
      data: data({
        rows: [row({ lastActivityAt: NOW - 400 * DAY, needsAttention: false })],
      }),
    });
    expect(screen.getByTestId("deal-queue-row").getAttribute("data-stall")).toBe("FRESH");
  });
});

describe("no money reaches the screen", () => {
  test("nothing that looks like an amount is rendered", () => {
    const { container } = renderQueue({
      data: data({
        rows: [
          row({ lastActivityAt: NOW - 3 * DAY }),
          row({ key: "sale:s1", href: "/org1/sales/s1/deal", anchor: "SALE", dealKind: "CASH" }),
        ],
      }),
    });

    // The queue's own numbers are day counts and view counts. Any grouped
    // thousands separator or decimal amount would mean a money field reached a
    // surface that authorizes on `view:sales` alone — which is exactly how
    // `applications.list` leaks financed amounts today.
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\d{1,3}(,\d{3})+/);
    expect(text).not.toMatch(/\d+\.\d{2}\b/);
  });
});

describe("Arabic RTL and bidi", () => {
  test("mixed Arabic and Latin runs are each isolated", () => {
    const { container } = renderQueue();
    const dealRow = screen.getByTestId("deal-queue-row");

    // An Arabic customer name beside a Latin vehicle label beside a year is the
    // exact case that reorders into nonsense when left as one run. Asserting
    // `textContent` would pass either way — the isolation is structural, so the
    // structure is what gets asserted.
    const isolated = Array.from(dealRow.querySelectorAll("bdi")).map((el) => el.textContent);
    expect(isolated).toContain("عبدالرحمن سملاني");
    expect(isolated).toContain("Kia Sportage 2023");
    expect(container.querySelector("bdi")).toBeTruthy();
  });

  test("the day count is isolated from its Arabic unit", () => {
    renderQueue({ data: data({ rows: [row({ lastActivityAt: NOW - 5 * DAY })] }) });
    const dealRow = screen.getByTestId("deal-queue-row");
    const isolated = Array.from(dealRow.querySelectorAll("bdi")).map((el) => el.textContent);
    expect(isolated).toContain("5");
    expect(within(dealRow).getByText("DaysWaiting")).toBeTruthy();
  });

  test("one day reads as singular, not as '1 days'", () => {
    renderQueue({ data: data({ rows: [row({ lastActivityAt: NOW - 1 * DAY })] }) });
    expect(screen.getByText("DayWaiting")).toBeTruthy();
    expect(screen.queryByText("DaysWaiting")).toBeNull();
  });

  test("today is a word, not a zero", () => {
    renderQueue({ data: data({ rows: [row({ lastActivityAt: NOW - 60_000 })] }) });
    // "0 days waiting" reads as broken. A deal touched an hour ago has not been
    // waiting a countable number of days.
    expect(screen.getByText("WaitingToday")).toBeTruthy();
  });
});

describe("states the screen must not get wrong", () => {
  test("loading renders a skeleton, never an empty queue", () => {
    renderQueue({ data: undefined });
    // An undefined query rendering the empty state tells the operator there is
    // no work while the answer is still in flight.
    expect(screen.getByTestId("deal-queue-loading")).toBeTruthy();
    expect(screen.queryByText("DealsQueueEmptyTitle")).toBeNull();
  });

  test("an empty needs-attention view explains itself differently from an empty filter", () => {
    renderQueue({ data: data({ rows: [] }), view: "NEEDS_ATTENTION" });
    expect(screen.getByText("DealsQueueEmptyNeedsAttention")).toBeTruthy();

    cleanup();
    renderQueue({ data: data({ rows: [] }), view: "CASH" });
    expect(screen.getByText("DealsQueueEmptyView")).toBeTruthy();
  });

  test("truncation is stated, with the limit filled in", () => {
    renderQueue({ data: data({ truncated: true, limit: 40 }) });
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("40");
    // The placeholder must be substituted, not printed.
    expect(notice.textContent).not.toContain("{limit}");
  });

  test("a healthy queue shows no truncation notice at all", () => {
    renderQueue();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("a customer with no recorded name says so rather than rendering blank", () => {
    renderQueue({ data: data({ rows: [row({ customerName: "" })] }) });
    expect(screen.getByText("UnknownCustomer")).toBeTruthy();
  });
});

describe("views", () => {
  test("the active view is the selected tab and carries its count", () => {
    renderQueue({ data: data({ counts: { ALL: 9, NEEDS_ATTENTION: 3 } }) });
    const selected = screen.getAllByRole("tab").filter((el) => el.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("DealViewNeedsAttention");
    expect(selected[0].textContent).toContain("3");
  });

  test("choosing a view reports the key, and does not filter locally", () => {
    const onViewChange = vi.fn();
    renderQueue({ onViewChange });
    fireEvent.click(screen.getByText("DealViewCash"));
    // Filtering is the SERVER's job — a client filter over a truncated page
    // would silently narrow an already-incomplete list.
    expect(onViewChange).toHaveBeenCalledWith("CASH");
  });
});

describe("English renders too", () => {
  test("the row still renders every part in LTR", () => {
    language.locale = "en";
    renderQueue({
      data: data({
        rows: [
          row({
            customerName: "Sam Lee",
            providerName: null,
            providerLabelKey: "UnnamedFinanceProvider",
          }),
        ],
      }),
    });
    expect(screen.getByText("BlockerAwaitingCreditDecision")).toBeTruthy();
    // The nameless-provider case comes back as a key so it reads in the
    // operator's own language rather than as hardcoded English from the server.
    expect(screen.getByText("UnnamedFinanceProvider")).toBeTruthy();
  });
});
