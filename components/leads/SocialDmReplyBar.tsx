"use client";

import { useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Loader2, Send, Sparkles } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { getCodedErrorMessage, getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

type Platform = "instagram" | "facebook";
type DraftId = Id<"aiDrafts">;

export interface SocialDmReplyBarProps {
  orgId: Id<"organizations">;
  customerId: Id<"customers">;
  /** Platform of the customer's private-message thread; null sends nothing (as before). */
  platform: Platform | null;
  /** Lead-edit permission. Without it the AI availability query is never subscribed to. */
  canEditLeads: boolean;
}

/** The box holds text inserted from this draft (possibly edited since). */
type DraftOrigin = { draftId: DraftId; insertedText: string };

/** What happened when a ready draft arrived: placed in the box, or held because the box had typed text. */
type Arrival = { draftId: DraftId; kind: "inserted" | "held" };

type NoteKey =
  | "SocialAiDraftWriting"
  | "SocialAiDraftReady"
  | "SocialAiDraftNeedsPerson"
  | "SocialAiDraftFailed"
  | "SocialAiDraftKeptText";

/**
 * The private-message reply bar of the Social Inbox conversation: the reply
 * box, Send, and the optional AI draft ("Suggest a reply").
 *
 * Rules, owned here and nowhere else:
 * - Text leaves only when the staff member presses Send (or Enter). A draft is
 *   placed in the box, never sent.
 * - Typed text is never replaced: Suggest works only while the box is empty or
 *   still holds the unedited draft. A draft that arrives after the staff member
 *   typed is held, and comes in only when they clear the box and press Suggest.
 * - `aiDraftId` goes with a send only while the box content came from a draft;
 *   clearing the box or sending forgets it. A send without a draft is the same
 *   call as before the AI feature existed.
 * - The draft belongs to this mount: the dialog unmounts the bar when it
 *   closes and remounts it per conversation, so no older draft is ever loaded.
 */
export function SocialDmReplyBar({ orgId, customerId, platform, canEditLeads }: Readonly<SocialDmReplyBarProps>) {
  const { t } = useLanguage();
  const labelId = useId();

  const sendInstagramDirectMessage = useAction(api.instagramEngagement.sendInstagramDirectMessage);
  const sendFacebookDirectMessage = useAction(api.facebookEngagement.sendFacebookDirectMessage);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const aiDraft = useAiDraft({ orgId, customerId, platform, canEditLeads, text, setText, sending });
  const { aiEnabled, boxIsFree, pending, note, originDraftId } = aiDraft;
  async function handleSend() {
    if (!platform) return;
    if (!text.trim()) return;
    const args = { orgId, customerId, message: text, ...(originDraftId ? { aiDraftId: originDraftId } : {}) };
    setSending(true);
    try {
      if (platform === "facebook") {
        await sendFacebookDirectMessage(args);
      } else {
        await sendInstagramDirectMessage(args);
      }
      aiDraft.forgetDraft();
      setText("");
      toast.success(t("MessageSentSuccess"));
    } catch (error) {
      toast.error(getCodedErrorMessage(error, t) ?? getErrorMessage(error));
    } finally {
      setSending(false);
    }
  }

  function handleChange(value: string) {
    setText(value);
    if (value.trim() === "") aiDraft.forgetOrigin();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter is a new line; Enter that confirms an IME
    // composition is left to the input method.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void handleSend();
  }

  const hasOrigin = originDraftId !== null;
  const showDraftRow = aiEnabled || hasOrigin;

  return (
    <div className="px-4 py-3 border-t shrink-0 bg-background">
      {showDraftRow && (
        <div className="mb-1.5 flex min-h-7 items-center justify-between gap-2">
          {hasOrigin ? (
            <Badge id={labelId} variant="secondary" className="gap-1 text-[10px]">
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              {t("SocialAiDraftLabel")}
            </Badge>
          ) : (
            <span />
          )}
          {aiEnabled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              disabled={pending || sending || !boxIsFree}
              aria-busy={pending}
              title={!boxIsFree ? t("SocialAiDraftClearToSuggest") : undefined}
              onClick={() => void aiDraft.suggest()}
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {t("SocialAiSuggestReply")}
            </Button>
          )}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <Textarea
          value={text}
          dir="auto"
          rows={2}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("WriteAMessage")}
          aria-describedby={hasOrigin ? labelId : undefined}
          className="min-h-9 max-h-40 flex-1 resize-none bg-background field-sizing-content"
        />
        <Button size="sm" aria-label={t("SendMessage")} disabled={sending || !text.trim()} onClick={() => void handleSend()}>
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {aiEnabled && (
        // Always mounted while drafts are available, so screen readers announce
        // each change (a live region added together with its text is often missed).
        <p
          role="status"
          aria-live="polite"
          className={cn("text-xs text-muted-foreground", note && note !== "SocialAiDraftReady" && "mt-1.5")}
        >
          {note && <span className={note === "SocialAiDraftReady" ? "sr-only" : undefined}>{t(note)}</span>}
        </p>
      )}
    </div>
  );
}

type DraftRow = { status: "pending" | "ready" | "needs_person" | "failed"; text?: string | null };

/** The draft text once it is ready and not blank; null otherwise. */
function readyTextOf(draft: DraftRow | null | undefined): string | null {
  return draft?.status === "ready" && draft.text?.trim() ? draft.text : null;
}

/** Suggest may fill the box only while it is empty or still holds the unedited draft. */
function isBoxFree(text: string, origin: DraftOrigin | null): boolean {
  return text.trim() === "" || (origin !== null && text === origin.insertedText);
}

/** A request is in flight, or a requested draft has not come back yet. */
function isDraftPending(
  requesting: boolean,
  aiEnabled: boolean,
  draftId: DraftId | null,
  draft: DraftRow | null | undefined
): boolean {
  if (requesting) return true;
  return aiEnabled && draftId !== null && (draft === undefined || draft?.status === "pending");
}

/**
 * All the AI draft state of the bar: the requested draft, where the box text
 * came from, how a ready draft arrived, and the request itself. The reply text
 * stays with the component (it is the staff member's box); the hook only fills
 * it, through `setText`, and never replaces typed text.
 */
function useAiDraft({
  orgId,
  customerId,
  platform,
  canEditLeads,
  text,
  setText,
  sending,
}: {
  orgId: Id<"organizations">;
  customerId: Id<"customers">;
  platform: Platform | null;
  canEditLeads: boolean;
  text: string;
  setText: (value: string) => void;
  sending: boolean;
}) {
  const { t } = useLanguage();
  const requestDraft = useMutation(api.aiDrafts.requestDraft);

  const [origin, setOrigin] = useState<DraftOrigin | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [draftId, setDraftId] = useState<DraftId | null>(null);
  const [arrival, setArrival] = useState<Arrival | null>(null);
  // Bumped by every successful send, so a request still in flight cannot bring
  // a draft into the box the staff member has just emptied by sending.
  const generation = useRef(0);

  const availability = useQuery(api.aiDrafts.getAvailability, canEditLeads && platform ? { orgId } : "skip");
  const aiEnabled = availability?.enabled === true && platform !== null;
  const draft = useQuery(api.aiDrafts.getDraft, aiEnabled && draftId ? { orgId, draftId } : "skip");

  const readyText = readyTextOf(draft);
  const boxIsFree = isBoxFree(text, origin);
  const arrivalHandled = arrival !== null && arrival.draftId === draftId;

  function insertDraft(id: DraftId, draftText: string) {
    setText(draftText);
    setOrigin({ draftId: id, insertedText: draftText });
    setArrival({ draftId: id, kind: "inserted" });
  }

  // A ready draft is handled once, during render (React: "storing information
  // from previous renders"), so there is no effect and no extra paint.
  if (draftId && readyText !== null && !arrivalHandled) {
    if (boxIsFree) insertDraft(draftId, readyText);
    else setArrival({ draftId, kind: "held" });
  }

  const pending = isDraftPending(requesting, aiEnabled, draftId, draft);
  const held = arrivalHandled && arrival?.kind === "held" && readyText !== null;
  const note = noteFor({ draftId, draft, readyText, pending, held, fromDraft: origin?.draftId === draftId });

  async function suggest() {
    if (!aiEnabled || !platform || pending || sending || !boxIsFree) return;
    if (held && draftId && readyText !== null) {
      insertDraft(draftId, readyText);
      return;
    }
    const requestedAt = generation.current;
    setRequesting(true);
    try {
      const result = await requestDraft({ orgId, customerId, platform });
      if (generation.current === requestedAt) setDraftId(result.draftId);
    } catch (error: unknown) {
      // A string, never the error object, and only in the user's language.
      toast.error(getCodedErrorMessage(error, t) ?? t("SocialAiDraftRequestFailed"));
    } finally {
      setRequesting(false);
    }
  }

  /** The box no longer holds draft text: `aiDraftId` stops going with a send. */
  function forgetOrigin() {
    setOrigin(null);
  }

  /** A send went through: forget the draft and let no in-flight request fill the emptied box. */
  function forgetDraft() {
    generation.current += 1;
    setOrigin(null);
    setDraftId(null);
    setArrival(null);
  }

  return { aiEnabled, boxIsFree, pending, note, originDraftId: origin?.draftId ?? null, suggest, forgetOrigin, forgetDraft };
}

function noteFor({
  draftId,
  draft,
  readyText,
  pending,
  held,
  fromDraft,
}: {
  draftId: DraftId | null;
  draft: { status: "pending" | "ready" | "needs_person" | "failed" } | null | undefined;
  readyText: string | null;
  pending: boolean;
  held: boolean;
  fromDraft: boolean;
}): NoteKey | null {
  if (pending) return "SocialAiDraftWriting";
  if (!draftId || draft === undefined) return null;
  // A draft this dealership cannot read, or a "ready" draft with no text, is a failure.
  if (draft === null || draft.status === "failed" || readyText === null) {
    return draft?.status === "needs_person" ? "SocialAiDraftNeedsPerson" : "SocialAiDraftFailed";
  }
  if (held) return "SocialAiDraftKeptText";
  return fromDraft ? "SocialAiDraftReady" : null;
}
