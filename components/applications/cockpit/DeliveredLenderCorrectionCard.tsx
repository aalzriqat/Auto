"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { formatLocalized } from "@/lib/dateLocale";
import { getCodedErrorMessage } from "@/lib/errors";

type Props = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  t: (key: string) => string;
};

type Action =
  | { kind: "request"; handoverAt: number; economicsStamp: string }
  | {
      kind: "approve" | "withdraw";
      correctionId: Id<"deliveredLenderCorrections">;
    };

export function DeliveredLenderCorrectionCard({
  orgId,
  applicationId,
  t,
}: Props) {
  const { locale } = useLanguage();
  const [pageCursors, setPageCursors] = useState<string[]>([]);
  const detail = useQuery(api.deliveredLenderCorrections.detail, {
    orgId,
    applicationId,
    cursor: pageCursors.at(-1),
  });
  const request = useMutation(api.deliveredLenderCorrections.request);
  const approve = useMutation(api.deliveredLenderCorrections.approve);
  const withdraw = useMutation(api.deliveredLenderCorrections.withdraw);
  const command = useCommandIdentity();
  const [action, setAction] = useState<Action | null>(null);
  const [quoteId, setQuoteId] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!detail) return null;

  const proposal = detail.kind === "AVAILABLE" ? detail : null;
  const pending = detail.kind === "PENDING" ? detail : null;
  const chosen = proposal?.replacements.find(
    (quote) => quote.quoteId === quoteId,
  );
  const mode = action?.kind;
  const currentIntent =
    action?.kind === "request"
      ? !!proposal &&
        proposal.handoverAt === action.handoverAt &&
        proposal.economicsStamp === action.economicsStamp
      : !!action && pending?.correctionId === action.correctionId;
  const inputRequired = mode === "approve" || mode === "request";
  const canSubmit =
    currentIntent &&
    (mode === "request"
      ? !!chosen && !!text.trim()
      : mode === "approve"
        ? !!pending?.canApprove && !!text.trim()
        : mode === "withdraw");

  function open(next: typeof action) {
    setAction(next);
    setQuoteId("");
    setText("");
    setError("");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || !canSubmit || busy) return;
    const value = text.trim();
    setBusy(true);
    setError("");
    try {
      if (action.kind === "request" && chosen) {
        const intent = `lender-correction:${applicationId}:${action.economicsStamp}:${chosen.quoteId}`;
        await request({
          orgId,
          applicationId,
          replacementQuoteId: chosen.quoteId,
          expectedHandoverAt: action.handoverAt,
          expectedEconomicsStamp: action.economicsStamp,
          reason: value,
          idempotencyKey: command.for(intent),
        });
        command.retire(intent);
      } else if (action.kind === "approve") {
        const intent = `approve-lender-correction:${action.correctionId}`;
        await approve({
          orgId,
          correctionId: action.correctionId,
          lenderApprovalReference: value,
          idempotencyKey: command.for(intent),
        });
        command.retire(intent);
      } else if (action.kind === "withdraw") {
        await withdraw({ orgId, correctionId: action.correctionId });
      }
      open(null);
    } catch (cause) {
      setError(getCodedErrorMessage(cause, t) ?? t("DeliveredLenderError"));
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === "approve"
      ? "DeliveredLenderApprove"
      : mode === "withdraw"
        ? "DeliveredLenderWithdraw"
        : "DeliveredLenderRequest";

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 text-start">
      <div className="space-y-1">
        <p className="font-medium">{t("DeliveredLenderTitle")}</p>
        {pending ? (
          <>
            <p className="text-sm">
              <bdi>{pending.lenderName}</bdi>
            </p>
            <p className="break-words text-sm text-muted-foreground">
              {pending.reason}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("DeliveredLenderPending")}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(
              detail.kind === "BLOCKED"
                ? detail.reason === "RECORDED_MONEY"
                  ? "DeliveredLenderMoneyBlocked"
                  : "DeliveredLenderCommitmentBlocked"
                : proposal?.replacements.length || proposal?.nextCursor
                  ? "DeliveredLenderDescription"
                  : "DeliveredLenderQuoteNeeded",
            )}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {proposal && pageCursors.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setPageCursors((pages) => pages.slice(0, -1))}
          >
            {t("DeliveredLenderPreviousQuotes")}
          </Button>
        )}
        {proposal?.nextCursor && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              const next = proposal.nextCursor;
              if (next) setPageCursors((pages) => [...pages, next]);
            }}
          >
            {t("DeliveredLenderOlderQuotes")}
          </Button>
        )}
        {proposal && proposal.replacements.length > 0 && (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              open({
                kind: "request",
                handoverAt: proposal.handoverAt,
                economicsStamp: proposal.economicsStamp,
              })
            }
          >
            {t("DeliveredLenderRequest")}
          </Button>
        )}
        {pending?.canApprove && (
          <Button
            type="button"
            onClick={() =>
              open({ kind: "approve", correctionId: pending.correctionId })
            }
          >
            {t("DeliveredLenderApprove")}
          </Button>
        )}
        {pending && (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              open({ kind: "withdraw", correctionId: pending.correctionId })
            }
          >
            {t("DeliveredLenderWithdraw")}
          </Button>
        )}
      </div>
      <Dialog
        open={action !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !busy) open(null);
        }}
      >
        <DialogContent className="text-start">
          <DialogHeader className="text-start">
            <DialogTitle>{t(title)}</DialogTitle>
            <DialogDescription>
              {t(
                mode === "withdraw"
                  ? "DeliveredLenderWithdrawDetails"
                  : "DeliveredLenderDescription",
              )}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            {mode === "request" && proposal && (
              <div className="space-y-2">
                <Label htmlFor="replacement-lender-quote">
                  {t("DeliveredLenderQuoteLabel")}
                </Label>
                <Select value={quoteId} onValueChange={setQuoteId}>
                  <SelectTrigger
                    id="replacement-lender-quote"
                    className="w-full"
                  >
                    <SelectValue placeholder={t("DeliveredLenderQuoteLabel")} />
                  </SelectTrigger>
                  <SelectContent>
                    {proposal.replacements.map((quote) => (
                      <SelectItem key={quote.quoteId} value={quote.quoteId}>
                        <bdi>{quote.name}</bdi> · {quote.termMonths}{" "}
                        {t("DeliveredLenderMonths")} ·{" "}
                        <bdi>
                          {formatLocalized(quote.createdAt, "d MMM yyyy", locale)}
                        </bdi>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {inputRequired && (
              <div className="space-y-2">
                <Label htmlFor="lender-correction-detail">
                  {t(
                    mode === "approve"
                      ? "DeliveredLenderReference"
                      : "DeliveredLenderReason",
                  )}
                </Label>
                <Textarea
                  id="lender-correction-detail"
                  value={text}
                  maxLength={mode === "approve" ? 200 : 500}
                  onChange={(event) => setText(event.target.value)}
                  required
                />
              </div>
            )}
            {(error || (action && !currentIntent)) && (
              <p role="alert" className="text-sm text-destructive">
                {error || t("DeliveredLenderError")}
              </p>
            )}
            <DialogFooter>
              <Button type="submit" disabled={!canSubmit || busy}>
                {t(title)}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
