"use client";

import { useEffect, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
import { AlertTriangle } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { SectionCard } from "@/components/admin/ui";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { formatLocalized } from "@/lib/dateLocale";
import { keySaveErrorMessage } from "./keySaveError";

const KEY_INPUT_ID = "ai-anthropic-key";

/** The two variants of the server's key status; the card does not need the provider name. */
export type ProviderKeyStatus = { kind: "set"; last4: string; setAt: number } | { kind: "unset" };

/**
 * Write-only entry for the Anthropic API key. The typed key lives only in this
 * component's state: it is sent once to `saveProviderKey`, cleared on success
 * and on unmount, and never logged, toasted, reported or put in a URL. What is
 * shown back is the server's status (last four characters and the save date).
 */
export function AnthropicKeyCard({
  encryptionConfigured,
  status,
}: {
  encryptionConfigured: boolean;
  status: ProviderKeyStatus;
}) {
  const { t, locale } = useLanguage();
  const saveProviderKey = useAction(api.aiAdmin.saveProviderKey);
  const removeProviderKey = useMutation(api.aiAdmin.removeProviderKey);

  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Clear the field on unmount too, so a typed key cannot outlive the screen
  // in a detached input (for example through the browser's back/forward cache).
  useEffect(() => {
    const node = inputRef.current;
    return () => {
      if (node) node.value = "";
    };
  }, []);

  const canSave = encryptionConfigured && !saving && apiKey.trim().length > 0;

  async function handleSave() {
    if (!canSave) return;
    const submittedKey = apiKey;
    setSaving(true);
    try {
      // The action takes an unvalidated argument (see the SCRUM-980 ADR), so
      // the shape is pinned here by an explicit type.
      const request: { provider: "anthropic"; apiKey: string } = { provider: "anthropic", apiKey: submittedKey };
      await saveProviderKey(request);
      setApiKey("");
      toast.success(t("AiAdminKeySaved"));
    } catch (error: unknown) {
      // A string, never the error object: the toast wrapper reports Error
      // objects to Sentry, and nothing from this call goes to an error report.
      toast.error(keySaveErrorMessage({ error, submittedKey, t }));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await removeProviderKey({ provider: "anthropic" });
      setConfirmOpen(false);
      toast.success(t("AiAdminKeyRemoved"));
    } catch (error: unknown) {
      toast.error(error);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <SectionCard
      title={t("AiAdminKeyTitle")}
      description={t("AiAdminKeyDescription")}
      action={
        status.kind === "set" ? (
          <Badge variant="secondary">{t("AiAdminKeyStatusSet")}</Badge>
        ) : (
          <Badge variant="outline">{t("AiAdminKeyStatusNotSet")}</Badge>
        )
      }
    >
      <div className="space-y-4">
        {!encryptionConfigured && (
          <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("AiAdminEncryptionMissingTitle")}</AlertTitle>
            <AlertDescription>{t("AiAdminEncryptionMissingBody")}</AlertDescription>
          </Alert>
        )}

        {status.kind === "set" && (
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t("AiAdminKeyEndsIn")}</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                <bdi dir="ltr" className="font-mono" data-testid="ai-key-last4">
                  {`••••${status.last4}`}
                </bdi>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("AiAdminKeySavedOn")}</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                <bdi>{formatLocalized(status.setAt, "d MMM yyyy", locale)}</bdi>
              </dd>
            </div>
          </dl>
        )}

        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Label htmlFor={KEY_INPUT_ID} className="mb-1 block text-xs text-muted-foreground">
              {status.kind === "set" ? t("AiAdminKeyReplaceLabel") : t("AiAdminKeyInputLabel")}
            </Label>
            <Input
              ref={inputRef}
              id={KEY_INPUT_ID}
              type="password"
              dir="ltr"
              // "off" is ignored for password inputs by most browsers (MDN,
              // "Turning off form autocompletion"); "new-password" is the hint
              // that keeps a saved site password from being filled in here.
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={t("AiAdminKeyInputPlaceholder")}
              value={apiKey}
              disabled={!encryptionConfigured || saving}
              onChange={(event) => setApiKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSave();
              }}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={() => void handleSave()} disabled={!canSave}>
              {saving ? t("AiAdminKeySaving") : t("AiAdminKeySave")}
            </Button>
            {status.kind === "set" && (
              <Button variant="outline" onClick={() => setConfirmOpen(true)} disabled={removing || saving}>
                {t("AiAdminKeyRemove")}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(open) => !removing && setConfirmOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("AiAdminKeyRemoveTitle")}</DialogTitle>
            <DialogDescription>{t("AiAdminKeyRemoveBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={removing}>
              {t("AiAdminCancel")}
            </Button>
            <Button variant="destructive" onClick={() => void handleRemove()} disabled={removing}>
              {removing ? t("AiAdminKeyRemoving") : t("AiAdminKeyRemove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
