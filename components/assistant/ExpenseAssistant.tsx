"use client";

import { useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ExpenseDialog } from "@/components/expenses/ExpenseDialog";
import type { ExpenseProposalValues } from "@/components/expenses/expense.schema";
import { isConvexError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { closeExpenseAssistant, currentExpenseAssistantSession, useExpenseAssistantState } from "./expenseAssistantStore";

/** The request door's own limit (convex/domains/ai/expenseProposal.ts), on the trimmed text. */
const MAX_MESSAGE_CHARS = 1000;
/** The counter appears once the message is this long. */
const COUNTER_FROM_CHARS = 900;

type ProposalId = Id<"aiAssistantProposals">;

type OutcomeKey =
  | "ExpenseAssistantNotExpense"
  | "ExpenseAssistantNotUnderstood"
  | "ExpenseAssistantFailed"
  | "ExpenseAssistantRequestFailed"
  | "ServerError_AI_ASSISTANT_RATE_LIMITED"
  | "ServerError_AI_ASSISTANT_NOT_ENABLED";

type ProposalView =
  | null
  | { status: "pending" | "ready" | "not_expense" | "not_understood" | "failed"; proposal?: ExpenseProposalValues };

/**
 * What a refused request says. Only the two assistant refusals have their own
 * text; anything else (validation, permission, network) gets one generic line
 * in the user's language, so the server's English wording never shows.
 */
function refusalKey(error: unknown): OutcomeKey {
  const data: unknown = isConvexError(error) ? error.data : undefined;
  const code = typeof data === "object" && data !== null ? (data as { code?: unknown }).code : undefined;
  if (code === "AI_ASSISTANT_RATE_LIMITED") return "ServerError_AI_ASSISTANT_RATE_LIMITED";
  if (code === "AI_ASSISTANT_NOT_ENABLED") return "ServerError_AI_ASSISTANT_NOT_ENABLED";
  return "ExpenseAssistantRequestFailed";
}

/** A settled proposal that did not produce a form, as the line the panel shows. */
function outcomeKeyOf(view: ProposalView): OutcomeKey {
  if (view?.status === "not_expense") return "ExpenseAssistantNotExpense";
  if (view?.status === "not_understood") return "ExpenseAssistantNotUnderstood";
  return "ExpenseAssistantFailed";
}

/**
 * The expense assistant panel (SCRUM-1039), mounted once in the dashboard layout
 * and opened from the top bar or the phone drawer.
 *
 * Rules, owned here:
 * - The assistant never saves. A ready proposal closes this panel and opens the
 *   normal expense form pre-filled; only the staff member's own Record Expense
 *   click calls `expenses.create`, with the form's own idempotency key.
 * - Typed text survives every outcome except a ready proposal, so the staff
 *   member can correct it and try again.
 * - One request at a time: while a request or its proposal is pending the box is
 *   read-only and submitting does nothing. A pending proposal turns into
 *   `failed` on the server after two minutes, so there is no client timer.
 * - Closing the panel drops the request it was waiting on; a late answer is ignored.
 */
export function ExpenseAssistant() {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const { open, returnFocusTo, session } = useExpenseAssistantState();
  const requestProposal = useMutation(api.aiAssistant.requestExpenseProposal);

  const boxId = useId();
  const statusId = useId();
  const counterId = useId();
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const [text, setText] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [proposalId, setProposalId] = useState<ProposalId | null>(null);
  const [outcome, setOutcome] = useState<OutcomeKey | null>(null);
  // A ready proposal waits here while this panel closes, then becomes the open form.
  const [queued, setQueued] = useState<ExpenseProposalValues | null>(null);
  const [handover, setHandover] = useState<ExpenseProposalValues | null>(null);
  // Synchronous guard: two Enter presses in one tick both see `busy === false`.
  const inFlight = useRef(false);

  // Opening or closing starts a new session: whatever the panel was waiting on
  // is dropped (the text stays). Adjusted during render, as React recommends
  // for state that follows a changing input.
  const [seenSession, setSeenSession] = useState(session);
  if (seenSession !== session) {
    setSeenSession(session);
    setProposalId(null);
    setOutcome(null);
  }

  const panelOpen = open && queued === null;
  const view = useQuery(
    api.aiAssistant.getExpenseProposal,
    panelOpen && activeOrgId && proposalId ? { orgId: activeOrgId, proposalId } : "skip",
  ) as ProposalView | undefined;

  // A settled proposal is handled once, during render. Ready queues the form and
  // closes this panel; anything else keeps the text and says why.
  if (proposalId !== null && view !== undefined && view?.status !== "pending") {
    setProposalId(null);
    if (view?.status === "ready" && view.proposal) {
      setQueued(view.proposal);
      setText("");
      setOutcome(null);
    } else {
      setOutcome(outcomeKeyOf(view));
    }
  }

  const waiting = proposalId !== null && (view === undefined || view?.status === "pending");
  const busy = requesting || waiting;
  const trimmedLength = text.trim().length;
  const tooLong = trimmedLength > MAX_MESSAGE_CHARS;
  const showCounter = trimmedLength >= COUNTER_FROM_CHARS;
  const canSubmit = !busy && trimmedLength >= 1 && !tooLong;

  let note: OutcomeKey | "ExpenseAssistantWorking" | "ExpenseAssistantTooLong" | null = outcome;
  if (busy) note = "ExpenseAssistantWorking";
  else if (tooLong) note = "ExpenseAssistantTooLong";

  async function submit() {
    if (!activeOrgId || !canSubmit || inFlight.current) return;
    inFlight.current = true;
    const requestedIn = currentExpenseAssistantSession();
    setOutcome(null);
    setRequesting(true);
    try {
      const result = await requestProposal({ orgId: activeOrgId, message: text.trim() });
      if (currentExpenseAssistantSession() === requestedIn) setProposalId(result.proposalId);
    } catch (error: unknown) {
      if (currentExpenseAssistantSession() === requestedIn) setOutcome(refusalKey(error));
    } finally {
      inFlight.current = false;
      setRequesting(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter asks; Shift+Enter is a new line; Enter that confirms an IME
    // composition is left to the input method.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  function closeForm() {
    setHandover(null);
    // The form is unmounted, not animated out; give focus back to what opened the assistant.
    const target = returnFocusTo;
    window.setTimeout(() => {
      if (target?.isConnected) target.focus();
    }, 0);
  }

  return (
    <>
      <Dialog open={panelOpen} onOpenChange={(next) => { if (!next) closeExpenseAssistant(); }}>
        <DialogContent
          className="max-w-md"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            boxRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // There is no DialogTrigger, so Radix would leave focus on the page body.
            event.preventDefault();
            if (returnFocusTo?.isConnected) returnFocusTo.focus();
            // The form opens only after this panel is gone, so it never fights
            // this panel's focus trap.
            if (queued) {
              setHandover(queued);
              setQueued(null);
              closeExpenseAssistant();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("ExpenseAssistantTitle")}</DialogTitle>
            <DialogDescription>{t("ExpenseAssistantExplain")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor={boxId}>{t("ExpenseAssistantMessageLabel")}</Label>
            <Textarea
              id={boxId}
              ref={boxRef}
              value={text}
              dir="auto"
              rows={3}
              readOnly={busy}
              aria-busy={busy}
              aria-invalid={tooLong}
              aria-describedby={showCounter ? `${statusId} ${counterId}` : statusId}
              placeholder={t("ExpenseAssistantPlaceholder")}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={handleKeyDown}
              className={cn("max-h-48 resize-none", busy && "opacity-70")}
            />
            <div className="flex min-h-5 items-start justify-between gap-3">
              {/* Always mounted while the panel is open, so each change is announced. */}
              <p id={statusId} role="status" aria-live="polite" className={cn("flex items-start gap-1.5 text-sm", tooLong || (outcome && !busy) ? "text-amber-800" : "text-muted-foreground")}>
                {busy && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />}
                {note && <span>{t(note)}</span>}
              </p>
              {showCounter && (
                <span id={counterId} dir="ltr" className={cn("shrink-0 text-xs tabular-nums", tooLong ? "text-red-600" : "text-muted-foreground")}>
                  {`${trimmedLength}/${MAX_MESSAGE_CHARS}`}
                </span>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              aria-disabled={!canSubmit}
              className={cn(!canSubmit && "cursor-not-allowed opacity-50")}
              onClick={() => void submit()}
            >
              {t("ExpenseAssistantSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {handover && (
        <ExpenseDialog
          open
          assistantProposal={handover}
          onOpenChange={(next) => { if (!next) closeForm(); }}
        />
      )}
    </>
  );
}
