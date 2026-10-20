"use client";

import { useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { htmlToPlainText, splitBodyText } from "@/lib/supportMail";
import { sanitizeEmailHtml } from "./sanitizeEmailHtml";
import type { SupportMessage } from "./types";

/** Plain text with `<https://…>` dumps collapsed into compact hostname chips. */
function PlainBody({ text }: { text: string }) {
  const { t } = useLanguage();
  const segments = useMemo(() => splitBodyText(text), [text]);
  if (segments.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("SupportInboxNoContent")}</p>;
  }
  return (
    <div dir="auto" className="whitespace-pre-wrap break-words text-sm leading-relaxed">
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          <a
            key={index}
            href={segment.url}
            target="_blank"
            rel="noopener noreferrer"
            title={segment.url}
            dir="ltr"
            className="mx-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-primary/10 px-2 py-px align-baseline text-xs text-primary hover:bg-primary/15"
          >
            {segment.host}
            <span aria-hidden="true">{"↗"}</span>
          </a>
        )
      )}
    </div>
  );
}

/** Untrusted HTML in a sandboxed iframe: no scripts, opaque origin, CSP. */
function HtmlBody({ html, onShowPlain }: { html: string; onShowPlain: () => void }) {
  const { t } = useLanguage();
  const { srcDoc, hasRemoteImages, unsafe } = useMemo(() => sanitizeEmailHtml(html), [html]);
  // Without allow-same-origin the parent cannot read the document height, so the
  // frame has a fixed height and scrolls internally.
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
        {hasRemoteImages && !unsafe ? (
          <>
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t("SupportInboxImagesHidden")}</span>
          </>
        ) : null}
        <span className="flex-1" />
        <button type="button" onClick={onShowPlain} className="font-semibold text-primary hover:underline">
          {t("SupportInboxViewPlain")}
        </button>
      </div>
      {unsafe ? (
        <p role="note" dir="auto" className="rounded-md border border-border bg-card px-3 py-4 text-sm text-muted-foreground">
          {t("SupportInboxUnsafeEmail")}
        </p>
      ) : (
        <iframe
          title={t("SupportInboxEmailContent")}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          className="block h-[min(70vh,640px)] w-full rounded-md border border-border bg-white"
        />
      )}
    </div>
  );
}

export function MessageBody({ message }: { message: SupportMessage }) {
  const { t } = useLanguage();
  const html = message.bodyHtml?.trim() ? message.bodyHtml : null;
  // Per-message view state; the parent remounts this component per thread.
  const [plain, setPlain] = useState(false);

  if (html && !plain) {
    return <HtmlBody html={html} onShowPlain={() => setPlain(true)} />;
  }

  const text = message.bodyText?.trim() ? message.bodyText : html ? htmlToPlainText(html) : "";
  return (
    <div>
      {html ? (
        <div className="mb-2 flex justify-end">
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-primary" onClick={() => setPlain(false)}>
            {t("SupportInboxViewFormatted")}
          </Button>
        </div>
      ) : null}
      <PlainBody text={text} />
    </div>
  );
}
